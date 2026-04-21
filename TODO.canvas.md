# Canvas Implementation Plan (incomplete)

Canvases can be tought of as **stored db views** that live as a dedicated layer type inside SynapsD trees. A canvas pre-filters documents at the tree path it sits on, applies its own stored `querySpec` (features + filters), and carries opaque UI configuration in `metadata`. Because a canvas is just a ULID-keyed layer(in a contextTree), copying one path to another re-uses the same underlying payload — rename/update in one place, reflected everywhere.

This plan is split into three phases.

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

1. **Canvas = tree layer(node) type**, not a document. Tree is the navigation primitive; views must ride along with tree mounts (future mountpoint feature). From the application perspective, **Canvas** can be thought of as a "frozen", movable/copyable **Context** (`src/core/context/lib/Context.js`)
2. **`querySpec`** uses SynapsD's native grammar (`features`, `filters`, `excludeTrees`). No app-specific vocabulary leaks into SynapsD.
3. **`metadata`** is an **opaque JSON blob**. SynapsD must never introspect it — it's the app's UI config (applet layout, colors, etc.).
4. **Canvas layer ∩ own querySpec ∩ ancestor path** is the composition rule. All three AND together.
5. **Canvas is also a bucket** — documents linked at its path are naturally part of it (via layer bitmap). A canvas is not only a filter; a user can drop docs onto it indexing them for the given path and in all path layers in case of a context tree or only the active layer in case of a directory tree.
6. **Reuse is free**: same canvas under `/projects/a/reports` and `/projects/b/reports` means two tree positions pointing at one layer ID. Update once, reflected both places. This should have same schemantics in the directoryTree view

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
    // intentionally NO `tree` / `path` — canvas binds to its host tree path at execution time. The whole excluded tree logic seems counterintuitive and broken/unnecessary 
  },
  // App will store all it needs here, maybe we should extend the base schema or move this under metadata - we should not leak app logic into the db layer(we already do and we'll refactor it out eventually) so I'm inclined to use the metadata field to store share info, ui configuration object and any other fields we may require
  metadata: {
  }
}
```

- `querySpec` is **partial**: missing keys mean "no constraint". `null` features ≠ `[]` features.
- Validation: `features` is a plain string array → treated as `anyOf` (matches `list` README). Object form `{ allOf, anyOf, noneOf }` passes through verbatim.
- `filters` is validated lazily — parsed the same way as `list({ filters })` already does.
- Update `toJSON` / `fromJSON` to round-trip the new fields. **Default them** if missing in stored data (back-compat: existing layers of type `canvas` created via `leafType: 'canvas'` (or layerType since BaseLayer.type already exists) will have no `querySpec` yet).
- Bump `schemaVersion` to `'2.1'` for canvas layers.

### 1.2  Ensure `LayerIndex` is up-to-date

**File:** `src/services/synapsd/src/views/lib/LayerIndex.js`

### 1.3  Ensure ContextTree and DirectoryTree supports layers of type canvas

**File:** `src/services/synapsd/src/views/ContextTree.js`
**File:** `src/services/synapsd/src/views/DirectoryTree.js`

Question: Should we even create dedicated methods for dealing with canvases? 

```js
// Create (or upgrade an existing context layer to) a canvas at the given path.
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
// Canvas is just a layer, maybe we can reuse getLayerByName and getLayerById - this should not really require additionall methods/helpers hence if possible, lets update/reuse our LayerIndex module
// In general we shoudl reuse as much of the existing code as possible

// Update a canvas's querySpec / metadata / label / description / color / acl.
// Partial: only supplied fields are changed. `querySpec` replaces wholesale — callers should read-modify-write.
async updateCanvas(pathOrId, updates = {}); // should reuse updateLayer

// List canvases. If path given, lists canvases **at or below** that path.
// Otherwise lists every layer of type 'canvas' in this tree.
async listCanvases(path = null); // should reuse listLayers(type)

// Remove a canvas. Because canvases are layers, this calls `deleteLayer`
// which also frees the underlying bitmap (documents remain in LMDB,
// they're just no longer reachable via this canvas — same as any layer deletion).
async removeCanvas(pathOrId); // should reuse layerIndex methods
```

### 1.4  ContextTree / DirectoryTree

Accessing a canvas should be the same as accessing a normal context path(both are made of layers), except we always prepend the currently send filters to the db query. 
Opening a path /foo/bar/baz/canvas-name does give us foo AND bar AND baz + whatever filters/query spec is stored in canvas-name 

Methods delegate to `this.#db.list` / `this.#db.search` with the composed spec; no new DB code required.

### 1.5  SynapsD top-level canvas API

**File:** `src/services/synapsd/src/index.js`

## Phase 2 — canvas-server: Context manager & transports

### 2.1  `Context.js` — auto-apply canvas spec on navigation

**File:** `src/core/context/lib/Context.js`

When `setUrl` resolves a path whose leaf layer is a canvas, stash the canvas spec on the context and merge it into subsequent `list` / `search` calls.

### 2.2  REST routes

We should mirror the API shape we have for `/contexts` in our to-be created `/canvases` routes.

`/canvases/:canvas_id/documents`

or under workspaces
`/workspaces/:wid/canvases`

Canvas - same as context - is bound to a specific tree hence we do not need to provide this information in our API route

### 2.3  WebSocket channel

**File:** `src/transports/websocket/channels/context.js` (extend) and/or a new `canvas.js` channel.

### 2.4  Permissions

- Owner of the workspace can CRUD canvases freely.
- `canvasRead` token → `/pub/canvas/:token` returns read-only results; no write routes accept tokens.
- Extend `checkPermission` in `Context.js` to understand `canvasRead` (treat as strictly-weaker-than `documentRead`).

## Phase 3 - WebUI (to be done, omit for this phase)

- Canvas card component (Outlook board view style).
- Tree renderer distinguishes canvas nodes from context layers (different icon/background).
- "Save current filters as canvas" action from any tree path.
- Applet registry; UI layout stored in `canvas.metadata.ui`.
- Shared-canvas public viewer at `/pub/canvas/:token`.


## Phase 4 - WebUI Toolbox
