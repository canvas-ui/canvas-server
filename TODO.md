# TODO List

## WebUI cosmetics

We will need tointroduce more vibrant colors covering larger sections of our buttons and header areas in the near future and use colors as visual cues for our context/directory paths once we start supporting the to-be vertically and horizontally scrollable multi-context multi-focus layout

### Content
- (deffered) Content area section should support tabs 

### Workspaces
- Workspace name should pre prepended with the workspace icon, tab should have a bottom border of the color of the workspace or layer

### Contexts
- Load icon + color from bound path, defaults/fallbacks to icon + color of the bound workspace

---


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
