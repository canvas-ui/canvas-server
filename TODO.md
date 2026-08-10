# TODO List

## Simplify the canvas-web UI!!

- We need to add a "simple" or "compact" UI version and leave the current one as "advanced" 
- Simple version
  - Focused on context switching, Pinned tree layers, canvases + a A2UI canvas controlled via an internal inferd UI runtime thread
  - 
-

## Toolbox Apps (applets/widgets)

**Landed 2026-08-07 - Apps tab + applet framework + Notes applet (first pass):**
- New top-level Apps tab in the Toolbox, FIRST in the icon row (`ToolboxPanel`,
  `panels/AppsPanel.tsx`). Context/Global sub-tabs; each applet declares which modes it
  supports (`components/toolbox/applets/registry.tsx` - `modes: ('context'|'global')[]`),
  and the launcher lists it under the matching sub-tab(s). Applets are plain components
  behind a descriptor, deliberately free of page-level assumptions so they can port to
  the tauri desktop UI later.
- Notes applet (`applets/NotesApplet.tsx`, modes: context): all notes in the focused
  context (workspace path or context - context mode resolves its bound workspace for
  writes) stacked in one editable document view. Per note: muted created-date + #id line,
  editable title, editable auto-growing plain-text body; autosave debounced 1.2s +
  flushed on blur, per-note save state (spinner/check/save failed). Top controls:
  full-text search (client-side over the loaded set) with match counter, autoscroll to
  the current match and Enter = advance + select the hit inside the body (notepad
  find); created-date sort toggle; inline Add note (draft pinned above the list, saved
  through the same submitDocuments path as the toolbox NoteForm). Listens to
  workspace:documents:refresh so external creates land live.

**Landed 2026-08-08 - Todos applet, standalone /apps routes, PWA shortcuts:**
- Todos applet (`applets/TodosApplet.tsx`, registry id `todo`): same stacked notepad view
  as Notes with a status checkbox (pending <-> completed), title + description editing,
  due/status in the muted meta line; DONE ITEMS (completed/cancelled) HIDDEN BY DEFAULT
  with an eye toggle + hidden count; draft due defaults to end of today.
- Both applets: per-item Link To (opens the LinkToCard sidebar, any workspace/path,
  multi-select) and Delete (removes from path, trash semantics) - quiet reveal-on-hover
  controls in the meta row.
- Standalone host `/apps/<id>` (`pages/apps/index.tsx`, chrome-free, outside AppShell):
  binding lives in the URL - Bind to Path (`?workspace=&path=`, defaults universe + `/`,
  first page only = APPLET_LIST_LIMIT 50) or Bind to Context (`?context=<id>`); `add=1`
  opens the inline draft. Applets got an `AppletTargetProvider` (applet-target.tsx);
  inside the toolbox the target still derives from focused navigation.
- Quick-add landing `/apps/add/<kind>` (note|todo|link|file|photo) renders the B5
  quick-add card (same hosting as share-target) - the add-then-Link-To workflow for
  unbound capture.
- PWA manifest `shortcuts` (vite.config.ts): Notes -> /apps/notes, Add Note ->
  /apps/add/note, Add Todo -> /apps/add/todo, Add Photo -> /apps/add/photo.
- Filter button on workspace/context pages turns info-blue ("Filter on") while any
  toolbox filters are active, so a filtered-empty tree is explainable at a glance.

Remaining:
- [ ] Configurable keyboard shortcut to open an applet (Notes) directly, and a floating
      "Applets" button for ad-hoc opening (the toolbox FAB currently opens Filters).
- [ ] Global applets: none exist yet - a clock and/or calendar is the natural first one
      (the Global sub-tab shows an empty state until then). The camera-stream showcase
      (live synapsd results for a camera feed) is a global applet + the planned
      services.streams work.
- [ ] Standalone host niceties: tree-picker for the path binding (text input today),
      context labels in the picker (shows ids), remember last binding per applet.
- [ ] Manual ordering (needs order: in metadata - deliberately skipped).
- [ ] Applet niceties: tag editing, search-term highlighting inside the body, load-more
      beyond the first page.
























-----------------


Eval `/workspace/ingest/<driver>/<format>` ?stream?
https://canvas.idnc.sk/home/pinned


We need to refactor the unfortunate way we handle workspaces on the server, specifically:
- Refactor users + workspaces + contexts index
- Allow removing of the default context
- Allow removing of the users default "universe" workspace

Workspaces are movable, one should easily move them between canvas-server instances - even by copyting them into users Workspaces directory (server should scan for valid accessible workspaces - we need this feature to support a more standard import/export feature)

We also need to support foreign-local or remote workspaces besides "transplanting" a workspace into a users Workspaces director, hence why the updated design should account for that

The design is still an open question hence the plan mode trigger for this session
If we auto-scan, we could probably hold all user workspaces under User in a map(re-use our conf-based wrapper to support conf updates with all the bells and whistles wo reinventing the wheel)
Contexts are user-local, can span workspaces (although not sure, this moved between workspace-local and user-local a couple of times already)

Server
  - Users
    - User "container"
      - Workspaces
        - Workspace "container"

## Scheduled tasks

## Workspace hook TODO items in `TODO.hooks.md`

### IMAP / email
- [ ] Attachments as File docs + rel/ relations (rel/* bitmaps exist, nothing populates them; Synapses tab empty by design gap).
- [ ] SMTP reply: per-mailbox smtp{} config, nodemailer send route, Reply button in EmailRenderer.
  - Sent-folder: postfix/dovecot does NOT copy sent mail into Sent — that's the client's job
    via IMAP APPEND (Gmail-style auto-append is a provider exception). So reply needs send +
    APPEND (ImapBackend is write:false today), or the MVP shortcut: ingest the sent message
    directly at send time (persistBlob + Email doc filed under the account's Sent path) and
    APPEND best-effort so other mail clients see it.
- [ ] UIDVALIDITY guard (small; do with/before SMTP reply — protects multi-mailbox MVP use):
  persist `uidValidity` per mailbox next to `lastUid`; on mismatch reset `lastUid=0` (refetch
  is idempotent — raw-.eml checksum dedup re-binds to existing docs) and refuse UID-based
  EXPUNGE until resynced. Without it a bump silently gaps incremental sync (`lastUid+1:*`
  skips renumbered messages) and destroy-by-UID can expunge the WRONG message server-side.
  Reading is already safe: bytes live in stored://workspace:data, imap:// is provenance-only.
- [ ] Per-driver Reconciler extraction (spec rule 5) — DEFERRED deliberately (2026-07-19):
  imap sync is add-only incremental today, so the UIDVALIDITY mass-absence hazard cannot fire
  (nothing diffs absences); shared invariants (scoping, liveness, orphan-not-delete,
  completed-snapshot) are already enforced above the file driver. Extract the Reconciler
  interface when imap gains real expunge/absence detection — driver supplies identity
  (Message-ID over UID for imap, st_dev/st_ino for fs), shared layer enforces the invariants.


## Geotagging follow-ups

Landed 2026-07-15: `metadata.geo = {lat, lon, alt?, accuracy?, source?}` with `source` = `device|exif|manual`, precedence **manual > exif > device** (rank, not write order → re-upserts idempotent). Owner: `src/core/workspace/lib/geo.js` (`pickGeo`). Opt-in device geotag toggle (default off) on note/todo create. Null-Island guard in synapsd `#indexDocumentGeo` (`Number(null) === 0` and is finite → `{lat:null,lon:null}` used to get indexed at 0,0 and answer bbox queries there).

- [ ] **Nothing writes `source:'manual'` yet** — manual is the top rank precisely so a hand-fixed pin survives re-indexing, but the UI that would set it (drag-a-pin / edit geo in the doc modal) doesn't exist. The rank is in place ahead of the feature that needs it.
- [ ] **No backfill of sentinel geo already in the S2 index** — the guard self-heals a doc only on re-put. Existing `{lat:null,lon:null}` docs stay indexed at 0,0 until touched. Candidate for the admin reindex endpoints.
- [ ] Geotag toggle covers note/todo only — files/photos (FileForm/FileCardBody/share-target) still send no device geo. EXIF outranks it anyway, so this only matters for photos with no GPS.
- [ ] `data/media/has-gps` feature is still watch-path-only (see also the extraction gaps in the blob metadata notes) — derive it server-side from `metadata.geo` on insert instead.
- [ ] `alt` is inert — stored but nothing reads it (index + renderers use lat/lon only). Either surface it or drop the pretence.

## WebUI cosmetics

- [ ] (deffered) Content area section should support tabs 
- [x] Layers M2 (WorkspaceM2 "Context layers" tab) now grouped by layer type — Canvases first,
      then Datasets, Context layers, Workspaces, Universe, Labels, System, then any unknown type
      as its own title-cased section (forward-compatible: a future `dataset` layer type slots in
      with no code change). Section headers reuse the `text-[10px] uppercase tracking-wide` idiom
      + a per-group count. (2026-07-21)
- [x] Canvas layout Save button (CanvasGrid toolbar) goes **purple (`bg-violet-600`)** while the
      layout is dirty — same affordance as the toolbox "Save filters" button (ToolsPanel) so an
      unsaved canvas is spottable at a glance; neutral bordered look once saved. (2026-07-21)
      NOTE: deliberately did NOT add "open canvas from the Layers menu" — a canvas fine-tuned for a
      specific path renders misleadingly under `/`; a plain-root open is the wrong affordance.

## Pinned items (renderer-agnostic pin API) — design agreed 2026-07-21

Driver: the webui and a future desktop overlay (and canvas-agent "Lucy") must show the **same**
pinned items — you log in, gesture/shortcut, and get your pinned canvases/layers as tiles with live
stats. A pin is a **personal attention concept**, the target (layer/canvas) is a data concept — keep
them separate; the pin API stays renderer-agnostic so any UI is just another client (the "UI is
replaceable, data model renderer-agnostic" principle).

**What already exists (this is a promotion, not a greenfield build):**
- `useCanvasPins()` → `src/ui/web/src/components/home/pins-context.tsx` reads/writes
  `home.pinnedCanvases` in the **per-user webui config** (`getWebuiConfig`/`putWebuiConfig` →
  server `UserConfigStore`, one JSON doc per user). Entries: `{ workspaceName, treeName, path }`.
- Home page already unions them into tiles (`PinnedCanvasTile`, `pages/home/index.tsx`); the canvas
  header already has working Pin/Unpin (`onTogglePinCanvas` / `isCanvasPinned`, wired in
  `pages/workspaces/[workspaceName]/index.tsx`).
- So pins are ALREADY a per-user, server-persisted, cross-workspace flat list. Two gaps block a second
  client: (1) they live in the **`webui`** config namespace (renderer-specific blob, not a neutral
  API); (2) they're **canvas-only** (`pinnedCanvases`), not typed layer/canvas/(future dataset) pins.

**Placement decision — Model A (per-user registry), NOT per-workspace `/workspaces/:id/pinned`:**
A pin is personal ("MY pinned tasks") → identity is its natural home. Model A: union is free (already
one list), global order has one home, far less code (promote the existing store). Per-workspace
(Model B) would need an aggregator that opens every known workspace, per-user-within-workspace keying,
and STILL a per-user side-store for global order (state in two places); its only real win — pins travel
with a `tar+scp`'d workspace — isn't wanted here (pins are yours, not the workspace's). Reserve Model B
only if pins must travel with a handed-off workspace, and even then keep global order in user config.
Dangling pins (target deleted) are handled at read time: resolve each, flag `resolvable:false` — never
404 the whole list.

**Target API (renderer-agnostic — NOT under the `webui` config namespace):**
```
GET    /pins             -> PinnedItem[]        # target.type in {canvas, layer, dataset…}
POST   /pins             -> add { target: { type, workspaceName, treeName, path|layerId } }
DELETE /pins/:pinId
PATCH  /pins/order       -> reorder (global overlay order)
GET    /pins/summaries   -> PinnedTileSummary[] # per-tile live stats (new msgs, todos today, …)
```
- **`PinnedItem`** — discriminated on `target.type` (same type-driven-descriptor pattern as the
  layers grouping + backend descriptors). Pin layers/canvases (stable IDs); **skip pinned tree-paths**
  for now — a path has no stable identity, a rename dangles it.
- **`PinnedTileSummary`** — computed **server-side per target type**, so webui and desktop overlay
  render identical tiles without either re-deriving stats. This endpoint is what makes "same pinned
  items as my desktop overlay" literally true (both hit `/pins/summaries`).

Tasks:
- [ ] Lift the per-user pin list out of the `webui` config namespace into a first-class `/pins` API
      (its own user-scoped store or a neutral config doc), renderer-agnostic.
- [ ] Generalize entries from canvas-only to typed `PinnedItem` (canvas | layer | future dataset).
- [ ] `GET /pins/summaries` — per-target-type server-side tile stats.
- [ ] `PATCH /pins/order` — global overlay ordering (per-user).
- [ ] Read-time resolve + `resolvable:false` flag for dangling targets.
- [ ] Migrate existing `home.pinnedCanvases` (canvas targets) into `/pins`; repoint `useCanvasPins()`
      at the new endpoint (webui keeps working, overlay becomes just another caller).

## Remote workspaces

- [x] **Add Remote UI landed 2026-08-07** - the webui was the only missing piece: "Add Remote..."
  on the Workspaces page posts `{url, token}` to `POST /workspaces/import` (service fn
  `importWorkspaceFromRemote` in `services/workspace.ts`). Verified end-to-end against a second
  server instance. Known edge: importing from the SAME server as the SAME user fails, because the
  remote archive and the local download resolve to the same Exports file and the best-effort
  remote DELETE (portability.js) removes it before import; guard = skip the DELETE when the
  resolved paths match, if self-import should ever work.

### Remote workspaces as local entries + pull-through cache (design agreed 2026-08-07)

Driver: run canvas-server locally (systemd --user daemon or docker) while also using workspaces
hosted on another instance. A remote workspace is represented as a LOCAL index entry
(`workspace@remote.domain.tld`), not a separate client-side concept.

Load-bearing facts already in place:
- `WORKSPACE_ORIGINS.REMOTE` exists; entries carry `host` (`isRemote` at index.js:110) and an
  index-only `remote: null` slot; resolution currently throws NOT_IMPLEMENTED (index.js:553).
  Implementing = registering `origin: remote` + `remote: {url, token}` and replacing that throw.
- stored is content-addressed and blobs are immutable per checksum, so a pull-through BLOB cache
  needs no invalidation story at all. Mutable metadata (documents/tree/bitmaps) is the part that
  must NOT be cached naively.
- Share tokens are single-workspace-clamped principals; the edge-proxy middleware exists.

Agreed shape, in phases:
1. **In-process `RemoteWorkspace`** (same public surface as `Workspace`, registered by the
   manager - deliberately NOT gated on canvas-edge; building it forces the Workspace interface
   to become the contract canvas-edge needs anyway):
   - queries / tree / document metadata: live proxy to the remote REST API, uncached
     (unreachable remote = workspace shows offline, same as a stopped local one)
   - blob/content reads: pull-through cacache keyed by checksum, ONE shared cache across all
     remote workspaces (content addressing dedupes across hosts for free)
   - writes: read-only first (matches read-permission share tokens)
   - index entry keeps the remote's ORIGINAL workspace id (enables a later
     detach-into-local-copy and dedupe against a prior import)
2. Write-through via the stored SyncQueue pattern + offline reads served from cache.
3. canvas-edge process-per-workspace runtime for ALL workspaces; "remote" becomes a runtime
   flag (the same workspace runtime in pull-through cache mode).

Open questions: token storage form in the index entry (raw vs wrapped - entries surface through
admin/debug); live updates from the remote (socket subscription vs poll - deferred).

- [x] **FIXED 2026-08-02** — the share-token auth gap was the culprit: workspace share tokens
  (`canvas-workspace-*`) were rejected by both REST and websocket auth. They are now first-class,
  single-workspace-clamped principals (see `WorkspaceManager.resolveWorkspaceShareToken`,
  `enforceWorkspaceTokenScope`, `socket.workspaceBinding`). The transparent proxying middleware
  exists too (`middleware/edge-proxy.js` over the edge tunnel, `docs/canvas-edge-protocol.md`);
  protocol = existing http+socket.io. Cross-server pull also works:
  `POST /workspaces/import { url, token }`.

## Workspace sync (design notes, non-MVP — parked 2026-08-02)

Use-cases: (a) offline secondary copy / backup to remote, (b) work on the workstation, move to
the same-network laptop or a cloud instance. Files and db sync **separately**: files via
stored.syncd (per-backend targets, rsync/S3 semantics fine), the db never file-syncs live.

**Load-bearing data-model facts (why this is tractable):**
- **Bitmaps and indexes are derived state — never sync them.** Replicate documents + tree ops
  only; every replica re-derives its own indexes locally. Small sync surface, version-skew
  tolerant.
- **Documents are immutable — every edit creates a new document (new checksum).** So document
  replication is append-only content-addressed transfer: no in-place merge conflicts at the
  document level; "conflict" reduces to which checksum a tree/head reference points at.

**Three tiers, build in order, each subsumes the previous:**
1. **Backup (one-way, single-master)** — snapshot shipping, not replication. LMDB hot backup
   (`mdb_env_copy` — consistent copy while running) + stored file delta + workspace.json, shipped
   to a dumb receiver that never opens the copy for writes. Export/import is the cold version of
   this already; backup = "export without stopping, scheduled, incremental files". Declare in
   `remotes[]`: `{ url, token, role: "backup" }`.
2. **Handoff (sequential multi-master)** — mastership moves as a lease recorded in the index /
   workspace.json. Handoff = flush+stop on A → delta-ship (cheap when tier 1 keeps the replica
   warm) → start on B. Git-like: transfer, not merge; zero conflict logic. NB the same-network
   "move to laptop" case often needs **no sync at all** — the laptop is a client of the live
   workspace via the edge tunnel + share tokens (works today).
3. **Concurrent multi-master** — synapsd oplog: append-only feed of document-insert + tree ops
   with hybrid clocks, replicated peer-to-peer over the existing edge channel. Thanks to
   immutable documents this is mostly content-addressed set union + per-reference LWW. Only
   build on real offline-concurrent demand; design should fall out of the synapsd refactor,
   not precede it.

**Placement:** workspace-scoped syncd service (self-sufficiency: a `ws` edge binary must sync
without canvas-server; `remotes[]` travels with the workspace). canvas-server contributes only
transport (tunnel) + auth (share tokens). Edge-case to fix on the way: anything absolute in the
db becomes workspace-relative at write time (import/relocation already proves the folder moves).

## Workspace runtime

Future non-MVP direction: bundle a workspace (synapsd, stored, inferd) into one Bun binary runnable from a folder, with minimal REST and WebSocket endpoints, token auth, and an optional Tauri tray UI.
- Prerequisites: `canvas-edge` for the minimal API + autoregistration to a remote canvas-server

## Related with the workspace runtime, canvas-agent runtime

Non-MVP, `ag` or `hi`, minimal bun or tauri runtime you can start from a folder directly(I'm included to tauri, you rename `hi` to `lucy`, put it into `~/Agents/Lucy` folder, double-click and you get a nice miminal toolbox-like UI with a button for voice-input and a dynamic mcpui/agui canvas), agent already includes / runs its own workspace so synapsd and all the rag goodies are built-in, `canvas-edge` will help it to (auto-)register if needed, great for local inference, the original idea of the whole project was small self-contained "workspaces", we can run both in a docker container/sandbox

## Server

CORS proxy or "fetch-through" proxy
New `src/transports/routes/pdf-proxy.js`  endpoint for `/proxy/pdf` 
with `?url=`

To add/eval proxy_cache on /rest/v2/proxy/pdf to get CDN-ish caching for free
A future
  /proxy/preview for other types is the same call with a different content allowlist (and
  that allowlist matters: proxying arbitrary HTML same-origin would let hostile pages
  into your origin context — stick to passive media: images, PDF, audio/video). Also
  worth knowing you already have the ingest-side alternative for anything you want to
  keep: fetch-url.sh + stored. Proxy = preview without commitment; ingest = preview with
  retention.

## canvas-edge

Lets design a `canvas-edge` service module with the following functionality

- The main purpose it to be used as a thin transport layer for containerized roles, agents and workspaces
- Works behind NAT ()
- <tbd>

------------

## Workspaces

### (descoped for now) Isolate workspaces as separate local processes

#### Goals

- Unify Roles / Agents / Workspaces under one management module
- Common API / control plane / contract for Agents, Workspaces and Roles
- Runtime may run as:
  - local process (pm2 managed?)
  - Docker container
- Runtime owns:
  - workspace/agent local state
  - storage access
  - background workers
  - service-specific logic
  - local API
- Runtime API should be root-relative:
  - `/health`
  - `/info`
  - `/documents`
  - `/services/...`
  - `/events` or `/stream`
- external path prefixing belongs to proxy/control-plane

#### UX

- user should be able to:
  - download workspace
  - run local workspace runtime as a simple background service/app
  - talk to it via CLI + REST API
- local runtime should not need `canvas-server` for basic operation
- local runtime should optionally register behind `canvas-server` when connected

### Move ingestion services (IMAP, Graph) to separate workers

- define a generic runtime contract
- define launcher abstraction
- define proxy/routing model
- define event envelope
- extract one worker first
- best candidate: IMAP service
- fine-tune:
  - lifecycle
  - health
  - socket transport
  - logs
  - proxying
  - auth handoff

### Import/export workspace(s)

**LANDED 2026-08-02** — `src/core/workspace/lib/portability.js` + `routes/workspaces/portability.js`:
tar.gz export (streamed, stopped-only), `:id`-scoped download/delete (read-ACL, share-token
capable), import from Exports archive / server-side folder / **remote pull** `{url, token}`.
Workspace id (uuid in workspace.json) survives the move. Original sketch below for reference —
the zip format and owner-rewrite/rename-on-collision ideas were dropped (tar.gz only; same-id or
same-name collisions are rejected instead of auto-renamed).

Original: We need to reintroduce the importWorkspace() and exportWorkspace() methods in our workspace manager.

The design should be as follows(I'm open to suggestsions here):
- importWorkspace(): Takes a zip or tar/tar.gz as input. Server uploads it into the users workspaces dir with a random temporary name, once extracted, we'd search for a valid workspace.json, then rewrite the owner/sanitize the config, rename the workspace folder to the real workspace name or workspace.N if we colide and import that workspace into the index.

- exportWorkspace(nameOrId, format = zip|tar|gzip) would first stop the workspace, then create an archive in the users workspaces path - then make it available for download.

### Config file search paths for workspaces

```text
Workspace config search paths
    $WORKSPACE_ROOT/.workspace/config/workspace.json
    $WORKSPACE_ROOT/.workspace/workspace.json
    $WORKSPACE_ROOT/.workspace.json
    $WORKSPACE_ROOT/workspace.json    
```

### Configurable directory layout + workspace.json schema (design agreed 2026-07-19)

Driver: a workspace must be **movable** (stop, tar, scp, untar) and self-describing. canvas-edge
will wrap a workspace as a single bun binary dropped into a folder — on setup it asks where internal
data goes (default `.workspace/*`) and which dirs to index; canvas-server keeps the flat root layout.
So the loader must make **no assumptions**: all mandatory paths live in workspace.json (search order
already noted under "Config file search paths for workspaces", primarily canvas-edge).

**Two categories (the location-authority split):**
- **Workspace internals** — `db` (synapsd), `config`, `var`, `tmp`. Owned by an `internals` map.
- **Services** — engines with single responsibilities:
  - **stored** = STORAGE ONLY (SRP: bytes and nothing else). Owns its index (`root`), its in-workspace
    `cache`, and its **data backends** (`file` / `blob(cacache)` / `s3`) — re-fetchable addressable
    bytes (`stored://`, `file://<deviceId>/…` for out-of-root dirs). Supports N in-workspace `file`
    dirs + external device-scoped mounts (both already resolve today). `cache` is a first-class stored
    property, NOT a backend: it holds derived artifacts (thumbnails), pull-through copies (future S3),
    and the sync-staging area for `stored.syncd` (store→queue{src,targets}→push→emit `locations[]`).
  - **git** — a service (version control over the home file backend).
  - **messages** — imap / graph(Teams,mail) / slack / whatsapp / irc: discrete records pulled on a
    cadence, deduped, each → a doc. NOT stored's job — a separate service (today the mail service;
    imap accounts already live outside `dataBackends`, in `config/stored.json`). Poll + cursor
    (generalises UIDVALIDITY/lastUid).
  - **streams** — cameras / logs / sensors: windowed time-series, sample + sliding retention +
    trigger/emit ("re-surface relevant on a feed"), NOT blind ingest. Planned for the LLM-agents work;
    a separate service, shape left OPEN.

`home`/`data`/`cache` are **stored's storage, never internals** — this dissolves the earlier
double-authority: their location comes only from stored's config; the `homePath`/`dataPath`/
`cachePath` getters must DERIVE from the resolved paths so WebDAV, the `/home` API, and the indexer
can't diverge.

Target workspace.json shape:
```json
{ "internals": { "db": "{WORKSPACE_ROOT}/db", "config": "…", "var": "…", "tmp": "…" },
  "services": {
    "git":    { "enabled": false, "root": "{WORKSPACE_ROOT}/git" },
    "stored": { "root":  "{WORKSPACE_ROOT}/db/stored",       // index
                "cache": "{WORKSPACE_ROOT}/cache",            // derived + pull-through + sync staging
                "sync":  { "policies": [] },                  // future stored.syncd
                "backends": { "home": {"type":"file","root":"{WORKSPACE_ROOT}/home"},
                              "data": {"type":"blob","root":"{WORKSPACE_ROOT}/data"},
                              "downloads":{"type":"file","root":"file://<deviceId>/home/user/Downloads"} } }
    // messages (imap/…) + streams live under their own services, added when that work starts
  } }
```

DONE (foundation, 2026-07-19):
- [x] Config path resolvers `Workspace#resolveWorkspacePath` / `#resolveDir` / `#backendRoot`
      (absolute / workspace-relative / `{WORKSPACE_ROOT}`).
- [x] Killed the hidden `.stored/` dir — Stored roots at `db/stored` (blob cache redirected to `cache/`);
      idempotent migration moves legacy `.stored/index` → `db/stored/index`, drops the stale dir
      (`WorkspaceStoredIndex#migrateLegacyStoredLayout`).
- [x] Double-authority killed — `homePath`/`dataPath`/`cachePath` getters derive from the storage
      backend `root` (single source: dataBackends) via `Workspace#backendRoot`; storage is NOT in the
      `directories`/internals map. WebDAV, `/home` API, and stored's indexer can't diverge. Verified.
- [x] Thumbnail 500-on-cache-miss fixed — `WorkspaceStoredIndex#getThumbnail` passes `resolve().data`
      to sharp (resolve returns `{data,ranged}`, not raw bytes). Cache-miss thumbnails 200 + written to
      `cache/`.

- [x] Schema reshape LANDED (2026-07-19, plan `~/.claude/plans/effervescent-rolling-pebble.md`):
      `internals` map (db/config/var/tmp) + `services.stored` { root, cache, sync, backends } +
      `services.git.root`. `dataBackends` → `services.stored.backends` (storage only); `stored.cache`
      fake-backend killed → first-class `services.stored.cache`; empty `services.stored.sync` slot.
      Read path `Workspace#storedConfig` (legacy fallback), single write authority
      `#writeStoredBackends`. Idempotent `Workspace#migrateConfigSchema` in `#doStart` rewrites
      legacy workspace.json (verified on universe: migrate → restart no-op). Settings Data tab shows
      no cache-as-backend row; "Clear thumbnails" is a standalone Stored Cache control. Backends API,
      cache-miss thumbnails, unit tests all verified.
- [x] Legacy `/services/data-backends` routes RETIRED (2026-07-19). **`/:id/backends` is the ONE
      backend surface** — storage (file/cacache/s3) + connectors (imap), descriptors w/ capabilities;
      it was built to retire the data-backends/services-imap split, so don't add parallel routes.
      The home-toggle → stored-index lifecycle coupling and `exclude` validation moved into
      `Workspace#updateBackend` (the facade), `getDataBackendStatus`/`resyncDataBackend` went
      private (`#`-prefixed, descriptor plumbing only). NOTE: the stored **cache is integral to the
      backend logic** (cache-first writes, pull-through, thumbnails) — it's just not *presented* as a
      configurable backend; manage it via `DELETE /:id/thumbnails`. Principle: when a surface is
      superseded, delete it same-change — no dead code, no "kept for compat" routes nothing ships
      against.

canvas-edge run (deferred — runtime, not schema):
- [ ] Search-path loader (ROOT/workspace.json → .workspace.json → .workspace/workspace.json →
      .workspace/config/workspace.json) + mandatory-path validation (no load-time defaults).
- [ ] Creation-time defaults per mode, written INTO workspace.json: canvas-server = flat root;
      canvas-edge = internals under `.workspace/`, Home = root itself.

messages/streams runs (deferred): `services.messages` gets its OWN config home (imap currently squats
in `config/stored.json` = stored's config — that coupling is the very thing SRP removes; move it out
when the messages service is extracted); `services.streams` shape defined with the LLM-agents feed work.

### Extend workspaces API (partly blocked by synapsd)

- [] Add a workspaces/:workspace_id/db endpoint
  - [] /stats
  - [] /status
  - [] /dump
  - [] /snapshots
    - [] /:timestampOrSnapshotID?
      - [] /dump
      - [] /restore

### Storage policies (UNRESOLVED — blocks a real answer to "what does destroy mean")

Surfaced by the data-representation work (`docs/data-representation.md`, decision 4).
We have **no fine-grained storage policy layer** — not in `stored`, not in
`Workspace`, not in the UI. Today a document's placement is whatever wrote it:
`persistBlob()` always lands in `stored://workspace:data`, backends are
enable/disable + watch flags, and there is nothing that expresses *where a
document's bytes should live*, *how many copies*, or *which copies a delete may
touch*.

That gap is what forces the interim rule for emptying Trash: **purge the index +
canvas-owned `stored://` locations, never foreign ones (IMAP, mounted NAS, S3
someone else owns)**. It is defensible — content addressing makes `stored://`
destroy mean "drop the last reference", and we cannot ask an OS file manager
"which backend did you mean?" — but it is a default standing in for a policy.

What a policy layer would have to answer:
- **Placement on write** — which backend(s) a new document's bytes go to, by
  schema / mime / size / tree path / context (a photo → `photos` S3 bucket, a
  work note → the encrypted local blob store).
- **Copies and tiers** — N copies across which backends; what
  `stored.syncd` (`services.stored.sync.policies`, an empty slot today) pushes
  where; pull-through vs pinned.
- **Deletion authority per backend** — `owned` (we may destroy), `mirror` (we may
  drop our copy, never the source), `foreign` (never touched). This is the field
  that turns Empty-Trash from a hardcoded rule into a policy evaluation, and the
  same field WebDAV/canvas-fuse need to answer "what did `rm` just do".
- **Where it is declared** — per workspace in `workspace.json` under
  `services.stored` (travels with a `tar+scp`'d workspace, consistent with the
  layout schema work), overridable per backend.

Until this exists, do not add per-call backend-selection flags to the delete
paths — that is the policy leaking into every call site.

### Add support for additional data sources

#### Messaging
- `whatsapp`
- `slack`
- `teams/graph-api`

#### Services/Connectors
- `git`
  - Aim is to streamline our dotfiles management feature/extract git support into a separate module
  - Needs to support branches
- `sql`
  - We'd cache the result internally; you may want to create a canvas aggregating data from various sql db sources along with your emails etc, working with them in any tool would be a curl https://your-canvas-instance/workspaces/:wid/canvases/:cid/documents | jq .. away
- `generic REST endpoint`
  - Lets say a corporate backend with a specific REST API endpoint + query returning a list of non-compliant servers, again could be paired with a TTL for the localy cached result as metadata (this is a pure app concern,  not sure whether we should - at this point - add some form of data invalidation based on TTL to the DB)


#### "Stored" data sources
- `dropbox`

