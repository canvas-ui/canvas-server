# TODO List

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

Lets do a couple of cosmetics (because there is no time for the interesting stuff now) - but our old-school 
react(yuck) UI is just temporary, a new AR-like canvas-centric UI is being shaped as you sleep ;) first, lets 
update our Layers M2 view to first show canvases then normal layers - or even better, since we may introduce a
layer of type dataset - lets divide the boring list of layers per layer type. Additionally, there is one more 
feature related solely to the UI which may become prominent and should be available across integrations - 
pinned layers(stored per-workspace but listable globally) - this is not a task, more a design question, 
justification is simple - you logon to your computer(idealy nfc - phone nearby, ask and confirm on phone - 
login shows you a simple, beatiful round control element on the bottom right that would default to voice input
and a nice dynamic wallpaper, nithing else, simplicity at its purest form, you made a gesture tracked by your 
camera with your left hand which opens a list of all your pinned tasks (nice semi-transparent AR-design 
compatible tiles of layers or canvases displaying the most imporatnt stats of each - if its a pinned canvas, 
you get whatever data is available for that canvas (number of new messages, todo tasks for today, missed 
calls), for pinned tree paths(not sure we should implement this) - workspace where the pin came from, number of
documents per type, last updated) - move left again and you get a list of workspaces > select > a flaoting 
workspace tree, hand rotation(or kb shortcut) would switch between trees) - select what you want to work on and
you are greeted by a beautiful empty canvas with your trusty toolbox button on the right - tick to voice input
- Lucy, show me the latest comm for the AG merger -> a2ui/mcpui canvas shows the content, "whats on plan for 
today" - adds a todo list "move it to a separate canvas" -> creates a separate canvas -> "move that canvas to 
my tv" - opens the canvas in a connected device tagged "tv" (this can be a simple tv web browser) => toolbox 
will have global part and a context part - want to edit an email, toolbox will have controls for emails, want 
to edit text, toolbox will have controls for text - besides the global filter and agent views and controlls" =>
this is where we are heading +/-, whats our opinion (all of this is relatively easy to implement - well, nfs 
login not but I used to work on my own linux-based OS before and I can do all kinds of trickery to make that 
experience very near)

- Storage: per-workspace, as you said — a pin is { layerId, pinnedAt, order? } living in the workspace (it
  references a layer that already belongs to that workspace, so it stays movable with tar + scp). Do not store pins
  in a global file; that breaks the "workspace is self-contained and portable" principle we just spent a session
  defending.
- Global listing: derived, not stored. The server enumerates open/known workspaces and concatenates their pins →
  one global list. This means a pin's identity is always (workspaceId, layerId); the global view is a projection.
  Fits the AR "move-left → all my pinned tiles across everything" gesture exactly.
- The tile is a view contract, not a layer field. A pinned canvas tile shows "3 new messages, 5 todos today, 2
  missed calls"; a pinned context/tree tile shows "workspace, doc counts per type, last updated." That's a small
  PinnedTileSummary the server computes per layer type — a discriminated union keyed on layer type. This is the
  same taxonomy work as the schema reshape: the layer type drives the descriptor. Same pattern as
  #storageBackendDescriptor.
- Skip pinned tree-paths for now (you flagged the doubt yourself). A path isn't a stable identity — rename/move
  and the pin dangles. Pin layers and canvases (both have IDs); revisit paths only if a real need shows up.


## Refactor `embedd` (coupled to the workspace runtime)

**LANDED 2026-07-27 — providers + routing are config, queues are per-workspace, models are
swappable.** The blocker was never the provider set: `DEFAULT_RULES` was a const in router.js,
`Server.js` never passed `options.rules`, and the provider map was three hardcoded constructors,
so pointing embedd at the GPU box meant editing source. All three are now data.

- **Config-driven providers + rules** — `src/services/embedd/src/config.js`; optional
  `$SERVER_HOME/config/embedd.json` (`CANVAS_EMBEDD_CONFIG` overrides the path,
  `server/config/embedd.example.json` documents the shape). Providers are `{ type, ...opts }`
  under a caller-chosen id; `onnx`/`ollama`/`clip` always exist and are overridable by
  re-declaring the id. JSON matchers accept an exact string, a `type/*` prefix, or
  `/regex/flags`. Defaults reproduce the old routing exactly. Misconfiguration throws at boot
  on purpose — a typo'd provider id would otherwise degrade dense search silently.
- **`OpenAIProvider`** (`providers/openai.js`) — `POST {baseUrl}/v1/embeddings`, so one provider
  covers vllm, TEI, infinity, LM Studio, OpenAI **and an EmbedAnything sidecar**. Images are
  configurable rather than guessed: `imageInput: 'data-uri'` (infinity/TEI-style batched `input`)
  or `'messages'` (vLLM multimodal, one request per image). Responses are re-paired by
  `data[].index` and a short response throws — silently dropping documents is worse than failing.
- **Model swap / revert / reclaim** — the router owns each space's model+dim, and
  `Embedd#spaceConfigs()` feeds them to synapsd. A space on its **baseline** model keeps
  `vec_text`/`vec_image` and its original bitmap keys (nothing existing is orphaned); any other
  model gets its own `vec_<space>__<slug>__<dim>` table **plus its own presence/seen ledger**.
  That last part is what makes a revert free: switch back and the old vectors are still there and
  still marked embedded, so nothing re-embeds. Reclaim a superseded model via
  `GET|DELETE /rest/v2/admin/workspaces/:id/vector-tables[/:table]` (refuses the live table).
- **Per-workspace queues** — one `Queue` per registered workspace behind a shared `Semaphore`
  (`CANVAS_EMBEDD_CONCURRENCY`, default 1 = byte-for-byte the old serial behaviour; raise it once
  inference is remote). Per-workspace `pause`/`resume`/`drained`/`workspaceStatus`;
  `/admin/embedd/{pause,resume}?workspaceId=` narrows to one. `onQueueDrained` now fires only for
  the workspace that drained — the shared queue used to trigger a compact + ANN rebuild in EVERY
  workspace on any drain. Settings → Database shows this workspace's own backlog (the
  "· all workspaces" caveat is gone) plus the provider/model per space.
- **`CANVAS_CLIP_MODEL` / `CANVAS_CLIP_DTYPE` are proper config** — `ClipProvider` takes
  `model`/`dtype` and passes them to the worker, so the routing rule is authoritative and env is
  just the fallback. (Changing dtype shifts the embeddings — re-embed the image space after.)
- **Embedding ledger keys unified + renamed** (follow-up, same day). Both per-space ledgers now
  live under one root and are always keyed `(space, model)` with the **model slug as the leaf**:
  `internal/embed/vectors/<space>/<slug>` (presence) and `internal/embed/seen/<space>/<slug>`
  (processed). This fixes a live defect, not just a naming wart: the legacy text presence bitmap
  sat at `internal/lance/vectors`, which was **also the parent path of the image one**, and
  `listBitmaps()` range-scans strictly below `prefix + '/'` — so listing `internal/lance/vectors`
  returned image and silently omitted text, including through
  `GET /workspaces/:id/bitmaps/internal/lance/vectors`. The rule the rest of synapsd already
  follows (`internal/ts/…`, `data/mime/…`, `feature/…`): **a namespace is a directory, never also
  a key.** Migration is idempotent via the existing `BitmapIndex.migrateKey`, runs at start before
  any VectorIndex latches its key, and maps legacy → the *baseline* slug (not the configured one),
  so a workspace upgrading straight onto a new model keeps its old vectors correctly attributed
  and reachable on a revert. `presenceKey()`/`seenKey()` in embedd's constants.js are the single
  source; a new modality (audio, spatial) slots in with no code change.
- Tests: `tests/services/embedd/{config,openai-provider,queue-split}.test.js` (39 new).

**On EmbedAnything: do NOT take it as an in-process dependency.** It's a Rust crate with Python
bindings and no maintained Node/NAPI binding, so integrating it means either building and
maintaining a NAPI shim or running it as a sidecar — and a sidecar is just another endpoint
behind `OpenAIProvider`. embedd stays a thin router+queue; model lifecycle lives on the inference
host. EA is now a deployment choice (one `baseUrl`), not a rewrite.

Remaining on this thread:
- [ ] Point the in-office GPU box at it for real and verify an image model end-to-end — the
      `imageInput` modes are written against the documented shapes but only tested against a
      local fake server.
- [ ] Rules are still server-wide. Making them **per-workspace** is what would finally let the
      settings UI stop being read-only (see the router bullet below).
- [ ] Model cache **search path** (workspace-local dir → server-shared fallback) for
      containerized/standalone workspaces.
- [ ] CLIP worker **pool** (~nCPUs-2, ORT intra-op threads capped so pool × threads ≈ nCPUs).
      Much lower priority now: with remote providers the local CLIP child is the fallback path,
      and the shared semaphore already bounds it.

Original context below.

**Remote/GPU-backed inference is the priority direction (2026-07-20).** Running CLIP/ONNX fp32
on the server's CPU is what pins the whole box during a photo-mount ingest (Fotky incident:
23.5k photos → serialized CLIP child saturates every core, server starves). A GPU workstation
is available in-office for testing remote vllm/ollama-powered embedding models — target: the
embedd provider layer points at that box (OllamaProvider exists; add/verify a vllm-compatible
OpenAI-endpoint provider, incl. image models), CPU-local ONNX/CLIP becomes the fallback, not
the default. This also derisks the EA question: if providers are remote, embedd stays a thin
router/queue and EA (or nothing) handles model lifecycle on the inference host.

**Stopgaps landed (2026-07-20)** so a bulk ingest can't take the server down meanwhile:
- Queue **pause/resume** — `POST /rest/v2/admin/embedd/{pause,resume}` (+ `GET /admin/embedd/status`),
  Pause/Resume button on the queue row in Settings → Database. Holds the backlog after the
  in-flight batch; runtime-only (restart clears; reconcile re-drives).
- **`CANVAS_EMBEDD_INGEST_DISABLED=true`** — soft gate: enqueue+reconcile no-op, existing vectors
  still serve dense search. (`CANVAS_EMBEDD_ENABLED=false` stays the hard switch.)
- Backend resyncs are now **cancellable** (`POST .../backends/:driver/:address/sync/cancel`,
  Stop-sync button) — stops the scan feeding the queue.

Origina TODO item:  

Today `embedd` is a single **per-server singleton**: one shared model runtime + ONE serial queue + one server-wide router. Consequences to fix as part of the runtime split:
- [x] **Queue is global + serial** — the "Embedding queue" count in workspace settings is server-wide (re-indexing a 3-doc workspace can show 800 pending from other workspaces). Each workspace runtime should own its own queue. **(done 2026-07-27: one Queue per workspace behind a shared concurrency semaphore.)**
- **Embeddable schemas/mimes are router-driven and server-wide, NOT per-workspace-configurable.** Reconcile uses `router.candidateSchemas(sp)` and the live path routes by the shared `DEFAULT_RULES` — synapsd's per-workspace `embeddableSchemas` is only a gap-ledger fallback. So "text-embeddable schemas" and "image-embeddable schema+mime" can only become real workspace settings once the router is per-workspace (make the router rules the configurable surface). Until then the UI should stay read-only/informational (done: labelled "Text-embeddable schemas" + "Image-embeddable: data/abstraction/file · image/*"). **(2026-07-27: rules are now config — but SERVER-wide config. Per-workspace rules are still the unlock for a writable UI.)**
- **Model cache**: per-workspace embedd with a cache **search path** (workspace-local dir → server-shared cache fallback) so containerized/standalone workspaces don't re-download models.
- **Throughput**: image (CLIP) runs in a **single forked child, serialized** (`clip-worker.js` request chain) → photo embedding is strictly one-at-a-time and CPU-bound (fp32 default is slow; q8 ~2-4x faster). Real fix = a small **worker pool** (~nCPUs-2) with ORT intra-op threads **capped** per child so pool × threads ≈ nCPUs (naive nCPUs-2 pool would oversubscribe — ORT already grabs all cores per single inference).
- [x] **Model dtype configurable**: `CANVAS_CLIP_DTYPE` (fp32/q8/…) is env-only today. Make it a proper config option — globally for now (server-wide embedd), per-workspace once the runtime is split. Low priority (boilerplate vs value). **(done 2026-07-27: `model`/`dtype` are ClipProvider options fed from the routing rule; env is the fallback.)**
- **Text embedding is broader than the UI implies**: we embed notes + emails + **text-file blobs** (`data/abstraction/file` with `text/*` mime), driven by the router's `DEFAULT_RULES`, not just `data/abstraction/note` (which is only synapsd's gap fallback default). The settings UI should reflect the router's real routing (done: `getStats().embedder.routing` surfaces per-space schema+mime rules; read-only until the router is per-workspace).

This relates to "### Vectors & modalities" in `src/services/synapsd/TODO.md`


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

- Open a remote workspace functionality does not work, either the share tokens do not work or the api endpoints do not work, regardless, workspaces are not really required to sit locally on the server, we will soon implement our canvas-edge runtime which will autoregister to a canvas-server instance and will presumably run locally at the user - we should handle that scenario transparently (maybe a think middleware that would keep all integration talkint to the same rest api but handle proxying to remote workspaces transparently)
Question is what protocol(s) to support, we currently use http+ws

## Workspace runtime

Future non-MVP direction, bundle workspace(synapsd, stored, embedd) in a single bun binary runnable from a folder in a standalone fashion(`ws`, would start a pm2 based daemon and use the same `ws` binary as the CLI), minimal REST+WS endpoints (only token auth), optional tauri UI frontend with a tray app
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

We need to reintroduce the importWorkspace() and exportWorkspace() methods in our workspace manager.

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

### Add support for additional data sources

- `git`
  - Aim is to streamline our dotfiles management feature/extract git support into a separate module
  - Needs to support branches
- `sql`
  - We'd cache the result internally; you may want to create a canvas aggregating data from various sql db sources along with your emails etc, working with them in any tool would be a curl https://your-canvas-instance/workspaces/:wid/canvases/:cid/documents | jq .. away
- `generic REST endpoint`
  - Lets say a corporate backend with a specific REST API endpoint + query returning a list of non-compliant servers, again could be paired with a TTL for the localy cached result as metadata (this is a pure app concern,  not sure whether we should - at this point - add some form of data invalidation based on TTL to the DB)
