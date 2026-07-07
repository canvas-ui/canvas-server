# TODO List

## WebUI cosmetics

We **need** to replace those bluish ie6 like document list/document icons with something more colorfull and nicer, people associate those blue links/icons with 200x and since our UI is black-and-white, a color is not some extra but a very important part of the UI => we will introduce more vibrant colors covering larger sections of our buttons and header areas in the near future and use colors as visual cues for our context/directory paths once we start supporting the to-be vertically and horizontally scrollable multi-context multi-focus layout

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


---

## Workspace Hooks

One of the major functionalities are workspace hooks

### Usecase #1: Plain ol' hooks

Note: We do not autoindex/autoingest/auto-process hidden files (dotfiles => files starting with a dot), regardless where they are placed

1. User syncs/indexes a link from his browser(browser tab - data/abstraction/tab schema document)
2. A hook from gets triggered, parses the data.url and finds out the link is a youtube video, 
3. spins up a bash script from WORKSPACE_ROOT/git/scripts and downloads that video into WORKSPACE_ROOT/home/Videos/some-name.mp4 using ytdl or 
3.1 to a temporary location (WORKSPACE_ROOT/var/tmp?) then inserts it to ws:data or some other backend 
3.2 it creates a synapse between 
3.2 it also inserts it into a virtual context tree /to-sort
4. A document.inserted hook gets triggered, path is /to-sort, data is a file/blob, a categorizer agent gets triggered, fetches doc synapses and tries to categorize the newly added document into one of the existing tree paths (or - if configured - creates a new one, fallbacks to /to-sort/unsure or whatever the user configured) 

I already need a simillar implementation for picture URLs/photos and arxiv papers, I may want to trigger an agent to summarize each arxiv paper I index and store that summary as a note linking it to the paper

Another hook example, emails from foo@bar.baz that contain subject "DC Migration" are to be linked under /projects/dc-migration, emais from bar@baf.baz to /path/to-read and /path/something/else and tagged custom/tag/urgent - sky is the limit

### Usecase #2: Hooks + Agents

We already partly covered this use-case above  
A bunch of browser tabs get synced into the /to-sort virtual context or directory tree, triggering a documents.inserted hook. Hook checks the path and triggers a categorizer agent to organize those tabs, fetches the current workspace tree paths array, optionaly uses a web tool to analyze those pages if url title or url does not provide enough context and links those tabs to respective context paths, removing them from to-sort once done.

document.inserted into /projects/dc-migration triggers an agent to read that email(with optional prompt/instructions) to evaluate whether to notify me over slack or teams or by sending an in-app notification ("please let me know if any emails about foo bar and baz arrive, also notify me when I get any comm regarding that intune ts case")

### Usecase #3: Agentic workloads

I bind my "Lucy" secretary agents to my "mbag" context. Switching my context url(focus) to /projects/dc-migration/fmo will update all my context-bound apps (browsers will load relevant tabs, obsidian will show relecant notes etc), since Lucy is also allowed to access my context, asking "Do we have any new emails?" or "can you tell me to what server ldap master was migrated to" - should trigger a targetted in-context search of all emails or a query across all documents pre-filted for the current context url for a standard RAG reply

I'd try to do as much of the logic with code, clasifier can have isText(), isImage(), isBlob(), isPdf(), isWebsite or isLink() etc methods (not sure whether to implement this on the Workspace layer or within synapsd, since this is related to the actual data I'd say stored or workspace, we'd just store whatever data we need in the db but open to suggestions here)

### Agent runtime integration

SKILLS.md or an MCP surface mirroring canvas-cli for agent access setup is a
  clean idea: the PUT /agents/:id/access flow is exactly one call, so a skill/tool
  wrapping "bind agent X to workspace Y path Z" would make hook-triggered agents

--

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
