# Canvas Implementation Plan

Canvases are **stored views** that live as a dedicated layer type inside SynapsD trees. A canvas pre-filters documents at the tree path it sits on, applies its own stored `querySpec` (features + filters), and carries opaque UI configuration in `metadata`. Because a canvas is just a ULID-keyed layer, copying one path to another re-uses the same underlying payload — rename/update in one place, reflected everywhere.

This plan is split into three phases. **Phase 1 (SynapsD) is the focus** — everything else builds on it. Phases 2 and 3 are sketched to show the surface area but will be planned in detail once Phase 1 lands.

---

## Phase 0 — Context & prior art (read first)

Before writing any code, skim these files. They already contain 80% of the plumbing — the canvas work is mostly about giving existing hooks a proper shape, not inventing new infrastructure.

- `src/services/synapsd/README.md` — canonical SynapsD API, `list` vs `search`, spec fields.
- `src/services/synapsd/src/schemas/internal/layers/BaseLayer.js` — `metadata: {}` and `acl: {}` already exist and round-trip through `toJSON` / `fromJSON`.
- `src/services/synapsd/src/schemas/internal/layers/Canvas.js` — stub with `type: 'canvas'`. Needs `querySpec` added.
- `src/services/synapsd/src/schemas/SchemaRegistry.js` — `internal/layers/canvas` is already registered.
- `src/services/synapsd/src/views/ContextTree.js`:
  - `insertPath(path, { leafType: 'canvas' })` — already creates canvas leaves (line ~371).
  - Upgrade path `context → canvas` already handled (line ~433).
  - `copyPath` re-uses the same layer payload — canvas reuse is free.
- `src/services/synapsd/src/views/lib/LayerIndex.js` — CRUD over layers, indexed by name + ID.
- `src/services/synapsd/src/index.js` — SynapsD public API surface; `createTree`, `getTree`, `list`, `search`, etc.
- `src/services/synapsd/src/utils/filters.js` — `parseFilters`, datetime filter grammar.
- `src/services/synapsd/src/utils/events.js` — `EVENTS` map (frozen). All new events must be added here.
- `src/core/context/lib/Context.js` — `list()` / `search()` already compose `contextSelector + features + filters`. Canvas auto-apply plugs in here.
- `src/core/context/lib/Canvas.js` — currently an empty subclass of `Context`. Either repurpose or delete once canvases are first-class in SynapsD.
- `src/transports/routes/contexts/tree.js` and `src/transports/routes/workspaces/tree.js` — existing tree routes; canvas routes should sit alongside.

### Key architectural decisions (already settled in prior discussion)

1. **Canvas = tree node type**, not a document. Tree is the navigation primitive; views must ride along with tree mounts (future mountpoint feature).
2. **`querySpec`** uses SynapsD's native grammar (`features`, `filters`, `excludeTrees`). No app-specific vocabulary leaks into SynapsD.
3. **`metadata`** is an **opaque JSON blob**. SynapsD must never introspect it — it's the app's UI config (applet layout, colors, etc.).
4. **Canvas layer ∩ own querySpec ∩ ancestor path** is the composition rule. All three AND together.
5. **Canvas is also a bucket** — documents linked at its path are naturally part of it (via layer bitmap). A canvas is not only a filter; a user can drop docs onto it and have them persist under that layer, because it's a layer.
6. **Reuse is free**: same canvas under `/projects/a/reports` and `/projects/b/reports` means two tree positions pointing at one layer ID. Update once, reflected both places.

---

## Phase 1 — SynapsD: first-class Canvas layers

### 1.1  Extend the Canvas layer schema

**File:** `src/services/synapsd/src/schemas/internal/layers/Canvas.js`

Add structured fields beyond what `BaseLayer` provides:

```js
{
  // inherited from BaseLayer: id, type='canvas', name, label, description, color,
  //                          lockedBy, metadata, acl, schemaVersion
  querySpec: {
    features: null,      // null | string[] | { allOf, anyOf, noneOf }
    filters:  [],        // string[] — bitmap keys or "datetime:..." expressions
    excludeTrees: [],    // string[] — tree names/ids to exclude (optional)
    // intentionally NO `tree` / `path` — canvas binds to its host tree path at execution time
  },
  metadata: {
    ui: { /* opaque to SynapsD — app-level layout/applet config */ },
    // ...other app keys freely
  },
  shareTokens: [],       // string[] of token ids; full token records live in internal/share-tokens/*
}
```

- `querySpec` is **partial**: missing keys mean "no constraint". `null` features ≠ `[]` features.
- Validation: `features` is a plain string array → treated as `anyOf` (matches `list` README). Object form `{ allOf, anyOf, noneOf }` passes through verbatim.
- `filters` is validated lazily — parsed the same way as `list({ filters })` already does.
- Add `setQuerySpec(spec)` and `setUiMetadata(obj)` convenience methods. Respect `isLocked`.
- Update `toJSON` / `fromJSON` to round-trip the new fields. **Default them** if missing in stored data (back-compat: existing layers of type `canvas` created via `leafType: 'canvas'` will have no `querySpec` yet).
- Bump `schemaVersion` to `'2.1'` for canvas layers.

### 1.2  `LayerIndex` — tolerate and migrate old canvas layers

**File:** `src/services/synapsd/src/views/lib/LayerIndex.js`

- `getLayerByID`: when reconstructing a canvas layer without `querySpec`, default to `{ features: null, filters: [] }`. Log once.
- No schema migration script needed — the default on read is sufficient for MVP; persist on first write.

### 1.3  ContextTree — canvas CRUD API

**File:** `src/services/synapsd/src/views/ContextTree.js`

All of these are thin wrappers over existing `insertPath` + `LayerIndex.updateLayer` / `removeLayer`. They exist so callers don't have to know that "creating a canvas" = "inserting a path with `leafType: canvas` + writing querySpec onto the leaf layer".

```js
// Create (or upgrade an existing context leaf to) a canvas at the given path.
// If the path doesn't exist, intermediate 'context' layers are auto-created.
// Returns the canvas layer.
async createCanvas(path, {
  name,                 // optional — defaults to last path segment
  querySpec = {},
  metadata = {},
  description,
  color,
  acl = {},
} = {});

// Fetch a canvas by either tree path OR canvas layer id.
getCanvas(pathOrId);                      // sync, returns Canvas layer or null

// Update a canvas's querySpec / metadata / label / description / color / acl.
// Partial: only supplied fields are changed. `querySpec` replaces wholesale — callers should read-modify-write.
async updateCanvas(pathOrId, updates = {});

// List canvases. If path given, lists canvases **at or below** that path.
// Otherwise lists every layer of type 'canvas' in this tree.
async listCanvases(path = null);

// Remove a canvas. Because canvases are layers, this calls `deleteLayer`
// which also frees the underlying bitmap (documents remain in LMDB,
// they're just no longer reachable via this canvas — same as any layer deletion).
async removeCanvas(pathOrId);
```

Implementation notes:
- `createCanvas` calls `insertPath(path, { leafType: 'canvas' })` and then `#layerIndex.updateLayer(leafName, { querySpec, metadata, ... })`. Emit `CANVAS_CREATED`.
- `getCanvas(pathOrId)` resolves by id first (looks like ULID or starts with `layer/`), else by path → last node's payload, then validates `payload.type === 'canvas'`.
- `updateCanvas` emits `CANVAS_UPDATED` with a `changedFields` array (so downstream consumers can cheaply decide whether to re-run queries). Use the existing `#layerIndex.persistLayer` path.
- `removeCanvas` emits `CANVAS_DELETED` and then reuses `deleteLayer` for bitmap cleanup.

### 1.4  ContextTree — canvas execution (`runCanvas` / `searchCanvas`)

Composition rule:

```
effectivePath     = tree path of the canvas (e.g. /projects/mbag/my-canvas)
effectiveFeatures = intersect(canvas.querySpec.features, runtimeFeatures)
effectiveFilters  = concat(canvas.querySpec.filters, runtimeFilters)
excludeTrees      = concat(canvas.querySpec.excludeTrees, runtimeExcludeTrees)
```

`effectivePath` is what makes a canvas composable: navigating to it ANDs every ancestor layer's bitmap with the canvas's own layer bitmap — no extra work, the existing path-based bitmap intersection already does this. The canvas's `querySpec` piles on top.

```js
// Run the canvas — bitmap-filtered listing (no text query).
// Merges the canvas's querySpec with any runtime overrides.
async runCanvas(pathOrId, overrides = {}) {
  // overrides may contain: features, filters, excludeTrees, limit, offset, page, parse
  // NOTE: overrides extend, they do not replace — a canvas owner decides the filter floor.
  //       If you need to ignore the canvas spec entirely, use list({ tree, path }) directly.
}

// Ranked search within a canvas.
async searchCanvas(pathOrId, query, overrides = {}) {
  // Requires a query string; same merge semantics as runCanvas.
}
```

Merge semantics:
- `features`: if both canvas and overrides provide arrays, compose as `{ allOf: canvas.anyOf, anyOf: overrides.anyOf }` — conservative default. If either side uses the object form, do a field-wise union for `anyOf`, intersection for `allOf`, union for `noneOf`. Document this clearly in the method JSDoc and in `README.md`.
- `filters`: concatenation (both apply).
- `limit`/`offset`/`page`/`parse`: overrides win.

Both methods delegate to `this.#db.list` / `this.#db.search` with the composed spec; no new DB code required.

### 1.5  SynapsD top-level canvas API

**File:** `src/services/synapsd/src/index.js`

Expose the same methods on the DB instance so callers that hold a `SynapsD` reference but not a tree reference can still operate:

```js
async createCanvas(treeNameOrId, path, options);
getCanvas(treeNameOrId, pathOrId);
async updateCanvas(treeNameOrId, pathOrId, updates);
async listCanvases(treeNameOrId, path = null);
async removeCanvas(treeNameOrId, pathOrId);
async runCanvas(treeNameOrId, pathOrId, overrides);
async searchCanvas(treeNameOrId, pathOrId, query, overrides);
```

Each resolves the tree via `getTree(treeNameOrId)` (already exists) then delegates. DirectoryTree should also accept canvases later, but **scope for MVP: ContextTree only** — DirectoryTree throws `Error('Canvas layers not yet supported on directory trees')` if asked. (Directory trees have filesystem semantics; adding canvas nodes there is a separate design conversation.)

Also add a **global canvas listing** helper:

```js
async listAllCanvases({ treeType = 'context' } = {});
// Iterates every tree of the given type, concatenates results with { treeId, treeName, canvas }.
// Useful for the UI's "all my canvases" view and for share-token resolution.
```

### 1.6  Sharing — token + ACL

Canvases need to be shareable via:
- **Email-based** — uses the `acl` field already on `BaseLayer`. Same shape as `Context.#acl.users[email] = { accessLevel, userId, grantedAt, ... }`.
- **Token-based** — generate an opaque token that resolves to `{ treeId, canvasId, accessLevel, createdAt, expiresAt? }`. Tokens live in a new internal dataset; canvas layer stores only token ids in `shareTokens: []`.

**New internal store:** `db.createDataset('share-tokens')` created during SynapsD `start()`.

**Token record shape:**
```js
{
  id: 'tok_<ulid>',              // the token itself (opaque, passed in URL)
  canvasId: '<layer ulid>',
  treeId: '<tree ulid>',
  accessLevel: 'canvasRead',     // canvasRead | canvasReadWrite (MVP: canvasRead only)
  createdBy: '<userId>',
  createdAt: '<iso>',
  expiresAt: null,               // optional
  revokedAt: null,
  description: null,             // human label "shared bike search"
}
```

`accessLevel` values are new and distinct from the existing `documentRead`/`documentWrite` — canvas access is about *viewing the filtered doc set*, not writing into the canvas.

**New methods on SynapsD:**
```js
async createCanvasShareToken(treeNameOrId, pathOrId, { accessLevel, expiresAt, description, createdBy });
async revokeCanvasShareToken(tokenId);
async listCanvasShareTokens(treeNameOrId, pathOrId);        // returns sanitized records (no secret)
async resolveCanvasShareToken(tokenId);                     // returns { treeId, canvasId, accessLevel } or null
```

**Events:** `CANVAS_SHARED`, `CANVAS_SHARE_REVOKED`.

**Scope trim for MVP:** token-based only. Email-based ACL is a short follow-up that reuses `BaseLayer.acl` — document the structure but defer wiring until Phase 2.

### 1.7  Events

**File:** `src/services/synapsd/src/utils/events.js`

Add to the frozen `EVENTS` map:
```js
CANVAS_CREATED:        'canvas.created',
CANVAS_UPDATED:        'canvas.updated',      // fired on querySpec/metadata/acl changes
CANVAS_DELETED:        'canvas.deleted',
CANVAS_EXECUTED:       'canvas.executed',     // optional, fired from runCanvas/searchCanvas — useful for telemetry, but can be deferred if noisy
CANVAS_SHARED:         'canvas.shared',
CANVAS_SHARE_REVOKED:  'canvas.share.revoked',
```

All payloads wrapped via `createTreeEvent` so `treeId`/`treeName`/`treeType` are populated. Payload body: `{ canvasId, canvasName, path, changedFields?, tokenId? }`.

### 1.8  README updates

**File:** `src/services/synapsd/README.md`

Add a **Canvases** section directly after **Trees**. Document:
- Conceptual model (layer of type `canvas`, composed with ancestor path and own spec).
- Schema of a canvas layer (`querySpec`, `metadata`, `shareTokens`).
- The 7 CRUD/execute methods on SynapsD and on ContextTree.
- Merge semantics for `runCanvas` overrides (with a worked example).
- Sharing: token shape, resolution flow.
- **Explicit non-goal for MVP:** no DirectoryTree support, no nested canvases-filtering-canvases (a canvas inside another canvas's subtree just inherits ancestor-path layers, nothing extra).

### 1.9  Tests

**Location:** `src/services/synapsd/tests/` (check existing layout and mirror it).

Test cases — each should live in a focused file:

1. `canvas-schema.test.js` — `Canvas` layer round-trips through `toJSON`/`fromJSON`, defaults missing `querySpec`, `setQuerySpec` rejects when locked.
2. `canvas-crud.test.js` — create at deep path (auto-creates ancestor context layers), create where leaf already exists as context (upgrades to canvas), create where leaf is already canvas (merges or errors — pick errors on conflict), update, delete, list.
3. `canvas-reuse.test.js` — `copyPath` a canvas into two locations, confirm both resolve to the same layer ID, updating one updates both, deleting at one position only removes that tree edge (existing `removePath` semantics).
4. `canvas-execute.test.js` — seed docs with different features, put canvas with features `anyOf: ['data/abstraction/email']`, verify `runCanvas` returns only emails under the ancestor path. Override with additional `filters: ['datetime:created:today']` and verify AND behavior. Verify overrides can narrow but not widen.
5. `canvas-search.test.js` — ranked search within a canvas, default `limit: 50`, verify LanceDB path.
6. `canvas-sharing.test.js` — create token, `resolveCanvasShareToken` returns canvas reference, revoke, resolution now returns null, expired tokens return null.
7. `canvas-events.test.js` — all six events fire with correct envelope (treeId/treeName/treeType populated).
8. `canvas-directory-tree.test.js` — confirms directory-tree rejection path.

### 1.10  Acceptance checklist for Phase 1

- [ ] `createCanvas` / `getCanvas` / `updateCanvas` / `listCanvases` / `removeCanvas` on both `ContextTree` and `SynapsD`.
- [ ] `runCanvas` / `searchCanvas` compose ancestor path + querySpec correctly.
- [ ] Canvas schema round-trips; old context leaves can be upgraded to canvases without data loss.
- [ ] Share-token create/revoke/resolve works; `shareTokens[]` on the layer stays consistent with the `share-tokens` dataset.
- [ ] Six new events fire with correct envelopes.
- [ ] README updated.
- [ ] All 8 test files green.
- [ ] No changes to `list` / `search` spec — canvas methods are sugar, not a new query path.

---

## Phase 2 — canvas-server: Context manager & transports

### 2.1  `Context.js` — auto-apply canvas spec on navigation

**File:** `src/core/context/lib/Context.js`

When `setUrl` resolves a path whose leaf layer is a canvas, stash the canvas spec on the context and merge it into subsequent `list` / `search` calls.

```js
// new private state
#canvasSpec = null;   // { canvasId, querySpec, metadata }

// inside setUrl, after insertPath returns:
const leafLayer = this.#tree.getLayerForPath(parsed.path);
this.#canvasSpec = leafLayer?.type === 'canvas'
  ? { canvasId: leafLayer.id, querySpec: leafLayer.querySpec, metadata: leafLayer.metadata }
  : null;

// in list/search: merge #canvasSpec.querySpec into spec (unless spec.rawCanvas === true)
```

Opt-out: `context.list(userId, { rawCanvas: true })` runs the path query unmodified.

Emit `context.canvas.entered` / `context.canvas.left` when `#canvasSpec` changes.

### 2.2  Delete or repurpose `src/core/context/lib/Canvas.js`

It's an empty `Context` subclass with `type: 'canvas'`. Delete it — canvas is now a layer concern, not a separate Context subclass. Confirm nothing imports it (`Grep -r "from '.*Canvas'"` in `src/core`), then remove.

### 2.3  REST routes

New file: `src/transports/routes/workspaces/canvases.js`

```
POST    /workspaces/:wid/trees/:treeId/canvases              create at { path, querySpec, metadata }
GET     /workspaces/:wid/trees/:treeId/canvases              list (optional ?path=)
GET     /workspaces/:wid/trees/:treeId/canvases/:canvasId    fetch one
PATCH   /workspaces/:wid/trees/:treeId/canvases/:canvasId    update
DELETE  /workspaces/:wid/trees/:treeId/canvases/:canvasId    remove

POST    /workspaces/:wid/trees/:treeId/canvases/:canvasId/run       runCanvas (body: overrides)
POST    /workspaces/:wid/trees/:treeId/canvases/:canvasId/search    searchCanvas (body: { query, overrides })

POST    /workspaces/:wid/trees/:treeId/canvases/:canvasId/share     create token
GET     /workspaces/:wid/trees/:treeId/canvases/:canvasId/share     list tokens
DELETE  /workspaces/:wid/share-tokens/:tokenId                       revoke token
```

Context-scoped shortcuts in `src/transports/routes/contexts/canvases.js`:

```
GET   /contexts/:contextId/canvas              returns current leaf canvas if any (null otherwise)
POST  /contexts/:contextId/canvas/run          run the current canvas (convenience over /workspaces/.../run)
```

Public route: `src/transports/routes/pub/canvas.js`

```
GET   /pub/canvas/:token                       resolves token, runs the canvas read-only, returns results
GET   /pub/canvas/:token/meta                  returns canvas UI metadata only (layout/applets) for rendering
GET   /pub/canvas/:token/qr                    QR code of the public URL (match existing /pub/.../qr pattern)
```

Wire all three into `src/transports/routes/index.js` / the existing mount logic.

### 2.4  WebSocket channel

**File:** `src/transports/websocket/channels/context.js` (extend) and/or a new `canvas.js` channel.

- Push `canvas.updated` to clients subscribed to `workspace:<wid>:canvas:<canvasId>`.
- Push document-set-changed hints: whenever a `document.inserted`/`.removed` event on the host workspace intersects the canvas's layer bitmap, broadcast a cheap `canvas.documents.changed` hint so UI clients can debounce-refresh.

### 2.5  Permissions

- Owner of the workspace can CRUD canvases freely.
- `canvasRead` token → `/pub/canvas/:token` returns read-only results; no write routes accept tokens.
- Extend `checkPermission` in `Context.js` to understand `canvasRead` (treat as strictly-weaker-than `documentRead`).

### 2.6  Acceptance checklist for Phase 2

- [ ] Context auto-applies canvas spec; `rawCanvas: true` opts out.
- [ ] All REST endpoints return `ResponseObject` shapes consistent with sibling routes.
- [ ] Public token endpoint works end-to-end (token → results) without any authenticated session.
- [ ] WebSocket pushes `canvas.updated` and `canvas.documents.changed`.
- [ ] Old `src/core/context/lib/Canvas.js` removed.
- [ ] New routes covered by the existing route-test harness (if present — check before writing).

---

## Phase 3 — WebUI (sketch only)

Not covered in this plan. Expected touchpoints (to be planned once Phase 2 is merged):
- Canvas card component (Outlook board view style).
- Tree renderer distinguishes canvas nodes from context layers (different icon/background).
- "Save current filters as canvas" action from any tree path.
- Applet registry; UI layout stored in `canvas.metadata.ui`.
- Shared-canvas public viewer at `/pub/canvas/:token`.

---

## Order of operations (recommended execution order for a fresh session)

1. **Phase 1.1 → 1.2** — schema + LayerIndex tolerance. Ship tests 1.9#1.
2. **Phase 1.3** — ContextTree CRUD. Ship tests 1.9#2 and #3.
3. **Phase 1.4 → 1.5** — execution + top-level SynapsD API. Ship tests 1.9#4 and #5.
4. **Phase 1.6** — sharing. Ship tests 1.9#6.
5. **Phase 1.7** — events everywhere. Ship tests 1.9#7.
6. **Phase 1.8** — README.
7. **Phase 1.10** — full acceptance sweep.
8. Only then proceed to Phase 2.

Keep each step as a separate commit; do not bundle schema changes with API additions. The schema change is the riskiest piece (touches persisted data), so land it small and isolated.

---

## Open questions / deferred decisions

These don't block Phase 1 but should be answered before Phase 3:

- **Mountpoints interaction**: when a subtree is mounted from another workspace, canvases inside it travel with the mount. Do they execute against the source workspace's SynapsD or the mounting one? (Source — because their layer bitmaps live there.) Write this up once mountpoints are actually designed.
- **Canvas inside canvas**: today the composition is "ancestor path AND canvas spec". If an ancestor layer is itself a canvas, its spec is currently ignored (only its layer bitmap participates). Intentional or not? Recommend keeping it this way for MVP; revisit if users complain.
- **DirectoryTree support**: can wait. Filesystem canvases are useful for saved searches over files but the composition semantics are different (directory OR vs context AND).
- **Canvas versioning / history**: not MVP. If ever needed, store prior `querySpec` snapshots in the layer's `metadata.history[]`.
