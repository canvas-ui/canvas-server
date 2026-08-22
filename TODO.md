# TODO List

## Target topology (monorepo + server + services)

```
canvas                  AGPL-only     monorepo (public — decided Slice 1)
  apps/
    web                               ← canvas-web
    cli                               ← canvas-cli (bun for build/compile)
    desktop                           ← canvas-desktop (tauri)
    browser-extension                 ← canvas-browser-extensions
    shell                             ← canvas-shell
  packages/
    protocol                          ← wire contracts + transport adapters, new
    api-client                        ← ergonomic client over protocol, new
    schemas                           ← extracted, new
    plugin-api                        ← integration/adapter interfaces, new
    messaging                         ← src/services/messaging
    voice                             ← src/services/voice

canvas-stored           AGPL+comm     standalone, ad-hoc reuse
canvas-fuse             AGPL-only     standalone (Rust — no npm workspace fit)
canvas-synapsd          AGPL+comm     standalone, ad-hoc reuse
canvas-server           AGPL+comm     src/{core,transports,utils} · agentd · edge
```

Only open cross-repository work belongs here. Implemented behavior belongs in
the owning package's README.

## Docs

- [ ] Refactor `docs/hooks.md` + nice screenshots, OR better: a short youtube
      video / animated gif walkthrough of the hooks + automation panel.

Eval `/workspace/ingest/<driver>/<format>` ?stream?
https://canvas.idnc.sk/home/pinned


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

## IMAP / email
- [ ] SMTP reply: per-mailbox smtp{} config, nodemailer send route, Reply button in EmailRenderer.
  - Sent-folder: postfix/dovecot does NOT copy sent mail into Sent — that's the client's job
    via IMAP APPEND (Gmail-style auto-append is a provider exception). So reply needs send +
    APPEND (ImapBackend is write:false today), or the MVP shortcut: ingest the sent message
    directly at send time (persistBlob + Email doc filed under the account's Sent path) and
    APPEND best-effort so other mail clients see it. `Workspace.ingestEmailMessage(payload)`
    is that entry point — hand it the raw RFC822 bytes and it files the Email + its
    attachments.
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

Geotagging landed 2026-07-15 (`metadata.geo`, precedence manual > exif > device — see README; owner `src/core/workspace/lib/geo.js` `pickGeo`). Open gaps:

- [ ] **Nothing writes `source:'manual'` yet** — manual is the top rank precisely so a hand-fixed pin survives re-indexing, but the UI that would set it (drag-a-pin / edit geo in the doc modal) doesn't exist. The rank is in place ahead of the feature that needs it.
- [ ] **No backfill of sentinel geo already in the S2 index** — the guard self-heals a doc only on re-put. Existing `{lat:null,lon:null}` docs stay indexed at 0,0 until touched. Candidate for the admin reindex endpoints.
- [ ] Geotag toggle covers note/todo only — files/photos (FileForm/FileCardBody/share-target) still send no device geo. EXIF outranks it anyway, so this only matters for photos with no GPS.
- [ ] `data/media/has-gps` feature is still watch-path-only (see also the extraction gaps in the blob metadata notes) — derive it server-side from `metadata.geo` on insert instead.
- [ ] `alt` is inert — stored but nothing reads it (index + renderers use lat/lon only). Either surface it or drop the pretence.

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

### Phase 1 LANDED 2026-08-22 (server 2.5.64, web 2.7.58) — see README → "Remote workspaces"

A remote workspace is a LOCAL index entry named `<name>@<host>` (origin `remote`, the
remote's original id kept unless a local entry already owns it; share token in the
per-user `remote-workspaces.json` credential store, never in the entry). Resolving it
yields a `RemoteWorkspace` facade (`src/core/workspace/lib/RemoteWorkspace.js`: status
mirrors the remote via a TTL'd probe, `offline` when unreachable). Every
`/rest/v2/workspaces/<name@host>/*` request is streamed to the remote by the scope-level
onRequest forwarder (`transports/middleware/remote-proxy.js`) with the share token —
the remote's routes answer, nothing is re-implemented. Content + thumbnail bytes go
through ONE shared pull-through cacache (`<serverHome>/cache/remote-workspaces`,
ETag/If-None-Match revalidation, stale serve when the remote is down, content-deduped
across hosts by cacache's integrity store). `DELETE`/`PATCH /:id` stay local (unlink /
presentation overrides).

Deliberately NOT done in phase 1 (next steps, in order):
- [ ] Live updates: the remote's `workspace:<id>` socket events are not relayed — the
      web shows the remote's state on navigation/refresh only. Relay = one socket.io
      client per RemoteWorkspace subscribing `workspace:<remoteId>`, re-broadcast on
      `workspace:<local id>`.
- [ ] In-process consumers (contexts spanning a remote workspace, agentd tools, WebDAV
      `/dav/<ws>`) still only see the facade's identity — `RemoteWorkspace` needs the
      read subset of the Workspace surface (`get`, `list`, `getTree`, `search`,
      `resolveDocument` via the cache) built on `RemoteWorkspace.api()`.
- [ ] Offline reads beyond bytes: cache `GET /documents*` + `/tree` responses
      (metadata is mutable — serve stale only when the remote is unreachable and mark it).
- [ ] Write-through queue (stored SyncQueue pattern) for writes while offline.
- [ ] Token storage form: the credential store is plaintext JSON today — fold into the
      `WorkspaceCrypto`/`secret://` work (secrets design below).
- [ ] Forwarded `PATCH /:id` for remote-side config (description, acl, …): today PATCH
      edits the local presentation only; a "push to remote" needs its own route.
- [ ] Web: the list card shows `Remote · host`; settings pages for a remote entry are
      the remote's own (forwarded) — token/share management there acts on the remote.
- [ ] Phase 3 (canvas-edge): process-per-workspace runtime; "remote" becomes a runtime
      flag — the forwarder already takes `edges.proxyRequest` OR a direct URL, so an
      edge-exported workspace and a URL remote share the same path.

### Original design notes (2026-08-07)

Driver: run canvas-server locally (systemd --user daemon or docker) while also using workspaces
hosted on another instance. A remote workspace is represented as a LOCAL index entry
(`workspace@remote.domain.tld`), not a separate client-side concept.

Load-bearing facts:
- stored is content-addressed and blobs are immutable per checksum, so a pull-through BLOB cache
  needs no invalidation story at all. Mutable metadata (documents/tree/bitmaps) is the part that
  must NOT be cached naively.
- Share tokens are single-workspace-clamped principals.

Phases: 1. in-process entry + forwarder + blob cache (DONE) → 2. write-through via the stored
SyncQueue pattern + offline reads served from cache → 3. canvas-edge process-per-workspace
runtime for ALL workspaces; "remote" becomes a runtime flag.

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

- [ ] Add `ids` filtering to context document routes (moved from canvas/TODO.md;
      `transports/routes/contexts/documents.js` has only `idsOnly` today).
- [ ] Verify image-query distance calibration with real query images —
      image→image distances run much tighter than text→image; the 0.945
      text-calibrated floor is loose for frame queries (search-by-vector applies
      no implicit floor, clients pass maxDistance).
- [ ] Eval a small batch-of-frames variant of `POST /search/image` (amortize
      HTTP, server-side vector averaging) — measure whether 1 req/frame at
      2 FPS is actually a problem first.

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

Schema + foundation landed 2026-07-19 (`internals` map, `services.stored`
{ root, cache, sync, backends }, `/:id/backends` as the one backend surface —
see README → Architecture). Still open:

canvas-edge run (deferred — runtime, not schema):
- [ ] Search-path loader (ROOT/workspace.json → .workspace.json → .workspace/workspace.json →
      .workspace/config/workspace.json) + mandatory-path validation (no load-time defaults).
- [ ] Creation-time defaults per mode, written INTO workspace.json: canvas-server = flat root;
      canvas-edge = internals under `.workspace/`, Home = root itself.

messages/streams runs (deferred): `services.messages` gets its OWN config home (imap currently squats
in `config/stored.json` = stored's config — that coupling is the very thing SRP removes; move it out
when the messages service is extracted); `services.streams` shape defined with the LLM-agents feed work.

### Workspace secrets + per-workspace encryption (design agreed 2026-08-21)

Driver: on shared canvas-server instances every service credential — IMAP passwords, connector
tokens (github/slack/gcal/teams/caldav), Google Drive refresh tokens, inferd provider API keys —
sits in plaintext in `workspace.json` (`services.stored.backends.*`). Reads are already redacted,
but the file itself, its backups and every `tar | scp` carry the secrets. Workspaces must stay
movable between instances and runnable standalone (canvas-edge), so the key must travel with the
workspace, not live on a server.

**Principle — a running workspace is a statement the user made.** Starting a workspace is a
user act and is the only place a passphrase is supplied. Nothing automated (agents, schedulers,
connector pollers, the server after an update) may start a stopped workspace. If a workspace is
stopped, for whatever reason, callers get a truthful status and the user decides. No "locked"
third state: **stopped = locked**; keys exist only in the memory of a running workspace and are
zeroed on stop. A workspace a user started and left running for months is the normal case.

**Integrations are not critical to a running workspace.** An unreachable IMAP server or Google
Drive means no new mail / no access to those bytes — non-blocking, reported as per-backend status
(`backend:state`, `lastError`), exactly like an unmounted NAS today. The ONLY thing that blocks a
start is a passphrase that cannot open the keyslot (wrong passphrase, corrupt keyslot file) —
and that is a refusal with a clear reason, never a silent plaintext fallback.

Consequences:
- After a server restart/update, protected workspaces come up **stopped** with
  `lastStopReason: 'server-restart'` and wait for their owner. Unprotected workspaces (no
  passphrase configured) keep today's auto-resume. Admin view shows "N workspaces waiting for
  their owners" so an update is not misread as an outage.
- Control-plane calls (REST, agentd tools, MCP later) against a stopped workspace return a
  structured, non-retryable error — `423 Locked`,
  `{ code: 'WORKSPACE_STOPPED', reason, stoppedAt, hint: 'Ask the owner to start workspace X' }`.
  Agents surface it verbatim and tell the user; there is **no start-workspace tool** for agents.
- Shared workspaces: whoever starts it holds the passphrase; members use it through ACL while it
  runs. Per-member keyslots ("any member may start it") are an additive later feature.

**Module: `WorkspaceCrypto`** (one per workspace, owned by the Workspace, travels in the folder):
```
.workspace/keyslots.json   (0600)            .workspace/secrets.json   (0600)
{ version: 1,                                 { "stored.backends.gdrive:Work-Drive.refreshToken":
  kdf: { alg: 'scrypt'|'argon2id', params },      { iv, ct, tag },
  slots: [                                      "stored.backends.imap:me@x.password": { … } }
    { type: 'passphrase', salt, wrapped },     workspace.json keeps only references:
    { type: 'recovery',   salt, wrapped } ] }     "refreshToken": "secret://stored.backends.gdrive:Work-Drive.refreshToken"
```
- Random 256-bit DEK per workspace; slots wrap the DEK (LUKS-style); `passphrase` mandatory,
  `recovery` (printable key shown once at creation) strongly recommended — without it a forgotten
  passphrase = every connector re-authorised and every encrypted payload gone.
- HKDF sub-keys from the DEK by purpose — `k_secrets`, `k_blobs`, `k_fields`, `k_dotfiles` — so
  rotation and blast radius are scoped and the secrets file never shares a key with data.
- AES-256-GCM `seal/open` (Node `crypto`, no new dependency). Keys live in `Buffer`s that are
  `fill(0)`'d on stop, never in strings, never in env/argv/logs, main thread only (the stored
  SyncQueue worker only ever sees cache paths). When workspaces become their own processes the
  DEK is handed over once via IPC on start, not at spawn.
- Passphrase source is a per-workspace choice with no architectural weight: separate passphrase
  by default; UI may offer "use my login password" as convenience (then a password change must
  re-wrap the slot; token/SSO logins can't unlock — they reach an already-running workspace).
- Secrets are keyed by **config path**, not by backend, so inferd API keys, webhook secrets, ACL
  tokens etc. slot into the same store without a second mechanism.

**Same module for data (step 2, same keys, honest limits):**
- YES: managed blob stores (`workspace:data` cacache, stored cache, thumbnails) — stored identity
  stays `sha256(plaintext)`, bytes at rest are ciphertext; nobody reads those dirs directly.
- YES: selected document payload fields (`private` schemas, `data.note`, credential-bearing
  docs) — per-field nonce, marked `encrypted: true`, and **excluded from FTS/embeddings** (that
  exclusion is the point and must be explicit).
- YES: `.workspace/*` dotfiles the workspace alone reads.
- NO: whole-db encryption of synapsd — LMDB is mmap'd and the indexes (bitmaps, FTS, timelines,
  checksum index) are plaintext derivatives; encrypted payload + plaintext index is encryption in
  name only. At-rest DB protection on shared hosts is a volume/fscrypt concern — document it.
- NO: user-facing file mounts (`workspace:home`, device mounts exported via Samba) — defeats them.
- LATER, own project: client-side encryption before upload to Drive/S3 ("zero-knowledge
  remote") — breaks the gdrive key model (Drive hashes ciphertext; plaintext sha256 must ride
  along in `appProperties` and the watcher reconcile both).

Tasks:
- [ ] `WorkspaceCrypto`: DEK, keyslot file, `passphrase` + `recovery` slots, HKDF sub-keys,
      `seal/open`, `start(passphrase)` → keys in memory, `stop()` → zeroed.
- [ ] `secret://` refs in `workspace.json` + sealed `secrets.json`; lazy migration on the first
      protected start; the secret-key lists already exist (`connectors/index.js` `#redactConfig`,
      `Workspace.#GDRIVE_SECRETS`, imap `passwordConfigured`) — resolve refs at driver/connector
      construction, which is where config is read today.
- [ ] Start paths: UI passphrase prompt, CLI flag, REST body (TLS) — one unlock path.
- [ ] Error contract: `423 WORKSPACE_STOPPED` on every control-plane route + agentd tool results;
      `lastStopReason` on the workspace record; no auto-resume for protected workspaces after a
      server restart; admin "waiting for owner" summary.
- [ ] Protection is per-workspace opt-in ("Protect secrets with a passphrase"), server policy may
      default it on for shared instances.
- [ ] Step 2: `k_blobs` for managed stores, `k_fields` for marked payload fields (+ FTS
      exclusion), `k_dotfiles`.
- [ ] Later: per-member slots, KMS/Vault as an optional slot source, audit log of secret reads.

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

