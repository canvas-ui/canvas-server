# TODO List

## Workspace/SynapsD tree refactor

We should change our workspace tree logic 
- We should pre-create 2 trees as is the case today
  - Context tree (type context/ctx)
  - Directory tree (type directory/dir)
    - webui bug: It should be possible to click to the "root" folder in a directory tree and  insert data into it, currently we switch to context tree on click
- Change: All backends should live in their own 3rd tree dedicated exclusively to the backends(with full CRUD semantics where the backend allows that => stored may need to support fetching the whole tree from a local or remote backend - like s3) - structure should be the same, we'd just move .backend into a "backends" tree (type directory)
  - Sync populates the index and the backend tree, user freely decides which documents to move to his cherrished context or directory tree
  - Agentic memory running synapsd as its own memory backend will create multiple semantic context-type trees for anchor based memory so the logic above should live on the Workspace level, synapsd should be as generic as possible(where it needs to be)

The ordering in our webui should therefor be
- Context tree(icon only)
- Context layers(icon only)
- Directory tree(icon only)
- Backends tree(type dir, icon only)

Couple of notes
- The ".incoming" handler/logic is I guess obsolete, we index documents from backends in a separate tree so no tree polution, we should be able to fetch all documents that are indexed in a tree (or not indexed - iow deamed not important and safe to purge from a backend - lets say a imap mailbox)
- workspace:home toggle for read-only is very important, one may not want to enable CRUD semantics over the web if the roaming workspaces home folder is exported via samba
- we need to be careful with documents stored only in workspace:data, removing those from index if workspace:data is the only location should also remove them from workspace:data since this cacache blob store is not browseable(by design)


## WebUI cosmetics

- Uploads to workspaces other than "Universe dont seem to work"
OK the issue seems to be refresh,
Ah, no, it seems to be some initialization issue(stored?cacache) - no, refresh indeed
- "Incoming" should not be an option for workspace:data (blob store) in workspaces > workspace > settings > Data Backends, disabling it also not an option, enabled by default
- Picking a color + icon always resets the state of the form, one currently can not do both in one go 
- link-to menu should also have an option to add a folder(long press/touch or context menu)
- We will need to introduce more vibrant colors covering larger sections of our buttons and header areas in the near future and use colors as visual cues for our context/directory paths once we start supporting the to-be vertically and horizontally scrollable multi-context multi-focus layout
- content area "grid" view should have nice mosaic pattern, we are not in 200x

### Content
- (deffered) Content area section should support tabs 

### Workspaces
- Workspace name should pre prepended with the workspace icon, tab should have a bottom border of the color of the workspace or layer, lets use css to ensure white-on-white use-case is covered

### Contexts
- Load icon + color from bound path, defaults/fallbacks to icon + color of the bound workspace

## Remote workspaces

Open a remote workspace functionality does not work, either the share tokens do not work or the api endpoints do not work, regardless, workspaces are not really required to sit locally on the server, we will soon implement our canvas-edge runtime which will autoregister to a canvas-server instance and will presumably run locally at the user - we should handle that scenario transparently (maybe a think middleware that would keep all integration talkint to the same rest api but handle proxying to remote workspaces transparently)
Question is what protocol(s) to support, we currently use http+ws

## Workspace runtime

Future non-MVP direction, bundle workspace(synapsd, stored, embedd) in a single bun binary runnable from a folder in a standalone fashion(`ws`, would start a pm2 based daemon and use the same `ws` binary as the CLI), minimal REST+WS endpoints (only token auth), optional tauri UI frontend with a tray app
- Prerequisites: `canvas-edge` for the minimal API + autoregistration to a remote canvas-server

### Refactor `embedd` (coupled to the workspace runtime)

Today `embedd` is a single **per-server singleton**: one shared model runtime + ONE serial queue + one server-wide router. Consequences to fix as part of the runtime split:
- **Queue is global + serial** — the "Embedding queue" count in workspace settings is server-wide (re-indexing a 3-doc workspace can show 800 pending from other workspaces). Each workspace runtime should own its own queue.
- **Embeddable schemas/mimes are router-driven and server-wide, NOT per-workspace-configurable.** Reconcile uses `router.candidateSchemas(sp)` and the live path routes by the shared `DEFAULT_RULES` — synapsd's per-workspace `embeddableSchemas` is only a gap-ledger fallback. So "text-embeddable schemas" and "image-embeddable schema+mime" can only become real workspace settings once the router is per-workspace (make the router rules the configurable surface). Until then the UI should stay read-only/informational (done: labelled "Text-embeddable schemas" + "Image-embeddable: data/abstraction/file · image/*").
- **Model cache**: per-workspace embedd with a cache **search path** (workspace-local dir → server-shared cache fallback) so containerized/standalone workspaces don't re-download models.
- **Throughput**: image (CLIP) runs in a **single forked child, serialized** (`clip-worker.js` request chain) → photo embedding is strictly one-at-a-time and CPU-bound (fp32 default is slow; q8 ~2-4x faster). Real fix = a small **worker pool** (~nCPUs-2) with ORT intra-op threads **capped** per child so pool × threads ≈ nCPUs (naive nCPUs-2 pool would oversubscribe — ORT already grabs all cores per single inference).
- **Model dtype configurable**: `CANVAS_CLIP_DTYPE` (fp32/q8/…) is env-only today. Make it a proper config option — globally for now (server-wide embedd), per-workspace once the runtime is split. Low priority (boilerplate vs value).
- **Text embedding is broader than the UI implies**: we embed notes + emails + **text-file blobs** (`data/abstraction/file` with `text/*` mime), driven by the router's `DEFAULT_RULES`, not just `data/abstraction/note` (which is only synapsd's gap fallback default). The settings UI should reflect the router's real routing (done: `getStats().embedder.routing` surfaces per-space schema+mime rules; read-only until the router is per-workspace).

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


## MVP Scope

MVP deployment has to happen before **30.06.2026**!

### Canvas server runtime

- [ ] canvas-server deployed at the customers LAB environment (proxmox LXC)
  - [ ] 24.04, auto-updates, git fetch check-for-update script over LAB proxy
  - [ ] AD/LDAP auth
  - [ ] Samba-exported workspace home folders (simple for bash loop over user workspaces config + reload, domain perms, facl)
  - [ ] (optional) per-user docker runtime (VM)
  - [ ] (optional) CNAME or shortlink

### Target functionality/features

- [ ] UI
  - [x] canvas-cli
  - [x] canvas-web 
  - [x] canvas-browser-extension
  - [ ] basic desktop overlay (tauri)

- [ ] Roaming profiles
  - [x] Webdav for workspace/home
  - [x] canvas-fuse
  - [ ] (optional) dotfiles endpoint via
    - git repo (git clone/push/pull) http(s)://host/workspaces/<workspace>/git/
    - dotfiles(app logic) http(s)://host/workspaces/<workspace>/dotfiles/
    - hooks http(s)://host/workspaces/<workspace>/hooks/

- [x] Contextualized data 
  - [x] Files
  - [x] Notes
  - [x] Browser tabs
  - [ ] (optional) Dotfile

- [x] Workspace hooks
- [ ] Agent runtime

## canvas-edge

Lets design a `canvas-edge` service module with the following functionality

- The main purpose it to be used as a thin transport layer for containerized roles, agents and workspaces
- Works behind NAT
- Re
-
-
- Offline icon cache for offline-only mode

## Canvas Roles

Role runtime:
  - docker
  - pm2
Role type
  - canvas-agent
  - canvas-workspace
  - generic
 
Backend bugs observed (not CLI):
1. dot init says "already initialized" when target dir exists but isn't a valid bare repo (silent no-op) — fixed manually by rm -rf + reinit
2. ws start on inactive workspace hung past 30s, caused server crash earlier in session — couldn't repro after restart


## UUID + ULID channges

- User ID should be uuid
- Workspace ID should be uuid
- Agent ID should be uuid
- Role ID should be uuid
We should support resolving all those resources by name (workspace "universe" is far easier to live with in CLI mode than some random uuid)

## Auth methods

- Token based
- Local (user+pass)
- Email (IMAP, autocreates users on auth, requires server-side configuration for each IMAP domain)
- AD, LDAP (autocreates users on auth, requires server-side configuration for each AD and/or LDAP domain)

## Main API endpoints

### Auth + management

- `/auth`
- `/admin`
- `/server` ? to merge with admin?

### Main modules

- `/contexts`
- `/workspaces`
- `/canvases`
- `/agents`
- `/roles`

### Shared resources

- `/pub`: A easy-to-use scheme is desired here, maybe with some /pub/9f94ccd3-05e6-473d-bd76-54d21a82bda6/qr endpoint to generate a qr
- `/schemas`: To eval if this is the right mount point as schemas are read from synapsd(db backend)

### Utils

- `/ping`: Public endpoint, no auth required
- `/status`: Detailed server status, auth required, user-accessible

### Queries

- To eval: We need to simplify our query patterns to make them more curl-friendly
  - `Path based queries`
    - /workspaces/:workspaceId/trees/:treeId/path/foo/bar/baz/baf
  - `Basic filtering patterns`
    - ?filter=foo&filter=bar&filter=baz
    - ?feature=data/abstraction/tab&feature=data/abstraction/note&!tag/deleted
  - `Agent queries`
    - ?agent=foo&agent_query=bar
    - /rest/v2/contexts/default?agent=lucy&agent_query="any new emails from nvidia"


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

### Add support for a different (internal) data abstraction - map (2d topological radial surface)

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

### Extend workspaces API (partly blocked by synapsd)

- [] Add a workspaces/:workspace_id/db endpoint
  - [] /stats
  - [] /status
  - [] /dump
  - [] /snapshots
    - [] /:timestampOrSnapshotID?
      - [] /dump
      - [] /restore

### Implement proper sharing functionality for Workspaces, Contexts and Canvases

- Token based (does not require a local user)
- User email based (requires a local user to exist on the same canvas-server instance)

### Add support for additional data sources

- `git`
  - Aim is to streamline our dotfiles management feature/extract git support into a separate module
  - Needs to support branches
- `sql`
  - We'd cache the result internally; you may want to create a canvas aggregating data from various sql db sources along with your emails etc, working with them in any tool would be a curl https://your-canvas-instance/workspaces/:wid/canvases/:cid/documents | jq .. away
- `generic REST endpoint`
  - Lets say a corporate backend with a specific REST API endpoint + query returning a list of non-compliant servers, again could be paired with a TTL for the localy cached result as metadata (this is a pure app concern,  not sure whether we should - at this point - add some form of data invalidation based on TTL to the DB)
