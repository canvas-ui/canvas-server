# TODO List

Eval `/workspace/ingest/<driver>/<format>` ?stream?
https://canvas.idnc.sk/home/pinned

## Workspace hook TODO items in `TODO.hooks.md`

## Refactor `embedd` (coupled to the workspace runtime)

We want to leverage battle-tested `https://github.com/StarlightSearch/EmbedAnything` to generate embeddings. Question is how deep we should integrate it into the current embedd(maybe we can fully rewrite it or make it just a thin wrapper around EA). We need to use external runtimes like vllm/ollama or antrhopic&co which is already taken care of by EA

It should be possible to seamlessly add new embedding models per modality + fine-tune their settings, revert back to a previous model or remove all vectors for a superseeded model.

Origina TODO item:  

Today `embedd` is a single **per-server singleton**: one shared model runtime + ONE serial queue + one server-wide router. Consequences to fix as part of the runtime split:
- **Queue is global + serial** — the "Embedding queue" count in workspace settings is server-wide (re-indexing a 3-doc workspace can show 800 pending from other workspaces). Each workspace runtime should own its own queue.
- **Embeddable schemas/mimes are router-driven and server-wide, NOT per-workspace-configurable.** Reconcile uses `router.candidateSchemas(sp)` and the live path routes by the shared `DEFAULT_RULES` — synapsd's per-workspace `embeddableSchemas` is only a gap-ledger fallback. So "text-embeddable schemas" and "image-embeddable schema+mime" can only become real workspace settings once the router is per-workspace (make the router rules the configurable surface). Until then the UI should stay read-only/informational (done: labelled "Text-embeddable schemas" + "Image-embeddable: data/abstraction/file · image/*").
- **Model cache**: per-workspace embedd with a cache **search path** (workspace-local dir → server-shared cache fallback) so containerized/standalone workspaces don't re-download models.
- **Throughput**: image (CLIP) runs in a **single forked child, serialized** (`clip-worker.js` request chain) → photo embedding is strictly one-at-a-time and CPU-bound (fp32 default is slow; q8 ~2-4x faster). Real fix = a small **worker pool** (~nCPUs-2) with ORT intra-op threads **capped** per child so pool × threads ≈ nCPUs (naive nCPUs-2 pool would oversubscribe — ORT already grabs all cores per single inference).
- **Model dtype configurable**: `CANVAS_CLIP_DTYPE` (fp32/q8/…) is env-only today. Make it a proper config option — globally for now (server-wide embedd), per-workspace once the runtime is split. Low priority (boilerplate vs value).
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

### Datasets (synapsd core SHIPPED 2026-07-17, v2 timeline-style selection; REST + UI pending)

Design (user, 2026-07-17): datasets work like the timelines — every doc implicitly belongs to the
VIRTUAL `data/dataset/default` dataset (= stamped with no dataset; computed as
candidate \ OR(all dataset bitmaps), never physically ticked). Every query intersects with
OR(selected datasets); `default` starts selected. So in the features vocabulary:
**anyOf `data/dataset/X` ADDS the dataset to the mix, allOf shows only it, noneOf deselects it
(incl. `noneOf data/dataset/default`)**. Dataset keys are partitioned out of the generic
anyOf/noneOf buckets in `#resolveParsed` so they can't bypass other feature filters. Dataset
subtree views = ordinary CANVAS layers saving `data/dataset/*` keys in querySpec (existing
machinery, nothing new). A rejected first cut (dedicated dataset layer type with mount-like
window semantics) was reverted same day — canvas + querySpec covers it.

- [x] `data/dataset/<name>` protected prefix — stamped via `spec.features` at ingest;
      `BitmapIndex.deleteBitmap` refuses the prefix without force. Provenance, path-independent.
- [x] Selection algebra in `#resolveParsed` (single query funnel; no-op until the first dataset
      exists). Tests: synapsd tests/datasets.test.js (5 cases incl. filter-bypass guard and
      multi-stamped docs).
- [x] Lifecycle: `db.listDatasets()`, `db.deleteDataset(name, {dropDocuments})` → trash-and-repipe.
- [x] REST surface — SHIPPED 2026-07-18: `GET /workspaces/:id/datasets`,
      `DELETE /workspaces/:id/datasets/*` (wildcard: names may contain @ . /; `?dropDocuments=false`
      unstamps only; deleting 'default' → 400). Workspace.listDatasets/deleteDataset passthroughs.
      Verified end-to-end on the live dev server (universe ws): stamp via documents API →
      default view hides (209), anyOf adds (211), allOf isolates (2), drop deletes 2 docs,
      default view unharmed (209). allOf-'default' engine bug found+fixed on the way (virtual key
      must not reach bitmapIndex.AND — resolves as selection {default}; regression test added).
- [x] "Datasets" group in Features tab — SHIPPED 2026-07-18: dedicated group (data/dataset prefix
      split), synthesized virtual 'default' row (labelled "virtual · on by default", tri-state:
      not = hide unstamped, all = only unstamped), named dataset rows get a trash action wired to
      the dataset lifecycle (confirm warns documents are deleted; refreshes open doc lists via
      workspace:documents:refresh). Dead 'server'/'user' prefix labels dropped. tsc clean.
      NOT yet visually verified in a browser — check on next dev session.
- [ ] Canvas creation flow: offer dataset keys in the querySpec feature picker (small; the engine
      side already composes canvas querySpec features into the dataset selection).
- [x] **Perf prerequisite for the 7M wikipedia ingest** — DONE 2026-07-18: maintained
      `internal/docs/all` bitmap (ticked on every put, unticked on delete UNCONDITIONALLY — i.e.
      even when failed lance cleanup blocks free-pool admission, so no phantoms). One-time
      backfill on start for pre-feature stores. `#buildAllDocumentsBitmap` is now an O(1) clone,
      which also closes the old noneOf-only full-scan follow-up. Decision: `default` stays
      VIRTUAL (= allDocs \ OR(named)) — a physical default bitmap was considered and rejected
      (write-path invariant maintenance = drift risk; virtual is consistent by construction).
      Tests: synapsd tests/all-docs-bitmap.test.js. Not done (deemed cheap enough):
      `listBitmaps('data/dataset/')` per query is an LMDB key-range read of a handful of keys —
      cache only if profiling ever says so.
- [x] Reserved name guard (2026-07-17): stamping `data/dataset/default` is refused at write
      (`#normalizeWriteFeatures`) — a physical bitmap under the virtual dataset's name would make
      its docs permanently invisible to the selection.



## Geotagging follow-ups

Landed 2026-07-15: `metadata.geo = {lat, lon, alt?, accuracy?, source?}` with `source` = `device|exif|manual`, precedence **manual > exif > device** (rank, not write order → re-upserts idempotent). Owner: `src/core/workspace/lib/geo.js` (`pickGeo`). Opt-in device geotag toggle (default off) on note/todo create. Null-Island guard in synapsd `#indexDocumentGeo` (`Number(null) === 0` and is finite → `{lat:null,lon:null}` used to get indexed at 0,0 and answer bbox queries there).

- [ ] **Nothing writes `source:'manual'` yet** — manual is the top rank precisely so a hand-fixed pin survives re-indexing, but the UI that would set it (drag-a-pin / edit geo in the doc modal) doesn't exist. The rank is in place ahead of the feature that needs it.
- [ ] **No backfill of sentinel geo already in the S2 index** — the guard self-heals a doc only on re-put. Existing `{lat:null,lon:null}` docs stay indexed at 0,0 until touched. Candidate for the admin reindex endpoints.
- [ ] Geotag toggle covers note/todo only — files/photos (FileForm/FileCardBody/share-target) still send no device geo. EXIF outranks it anyway, so this only matters for photos with no GPS.
- [ ] `data/media/has-gps` feature is still watch-path-only (see also the extraction gaps in the blob metadata notes) — derive it server-side from `metadata.geo` on insert instead.
- [ ] `alt` is inert — stored but nothing reads it (index + renderers use lat/lon only). Either surface it or drop the pretence.

## WebUI cosmetics

- [ ] (deffered) Content area section should support tabs 

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

### Configurable directory layout (partly DONE 2026-07-19)

- [x] On-disk layout is config-driven: a `directories` map in workspace.json overrides
      `WORKSPACE_DIRECTORIES` defaults via `Workspace#resolveDir` (absolute / workspace-relative /
      `{WORKSPACE_ROOT}` template). All internal getters (cache/data/home/db/stored/git/hooks) go
      through it, so a local runtime can stash everything under `.workspace/{cache,data,…}` and keep
      the root as the user's Home.
- [x] Killed the hidden `.stored/` dir — Stored roots at `db/stored` (its blob cache is redirected to
      `cache/`); one-time idempotent migration moves any legacy `.stored/index` → `db/stored/index`
      and drops the stale dir (`WorkspaceStoredIndex#migrateLegacyStoredLayout`).
- [ ] Built-in backend roots (`workspace:home`/`data`) still resolve via their own
      `{WORKSPACE_ROOT}/…` templates in `dataBackends` (`#resolveBackendRoot`), a separate key from
      `directories`. Defaults agree; to make `directories.home`/`.data` authoritative for those
      backends too, that resolver should prefer the getters. (`stored.cache` already follows
      `directories.cache` — it isn't a separate backend.)

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
