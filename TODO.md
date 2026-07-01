# TODO List


Our webUI has one important issue, it is useless. 
It was never meant as a product, it started and continued its life as an adhoc LLM and canvas-server feature testing bed. 
There are some usable configuration features but one simple question that points out the uselessness of the current implementation - would a user want to have canvas open as his home-page? Answer is no, not even I would and I'm the one who put the whole thing together. Added to that, the whole UI was never meant to look as it does now, I did some sketches, copy-pasted them to older models and everything they came up with was exactly a standard boring react website regardless of how many times I repeated the exercise and refined my sketches.

I was postponing a real UX-focused refactor for a long time becacuse the integrations (browser extensions, cli, now canvas-fuse)  - for me - were more imporant, but I need to move to mobile and noticed that one can install a website - our website - as a PWA and even found some nice mdn docs that claim one can use native android features to "send a link" to canvas or copy some text and save it as a note in canvas or take a photo and upload it etc - over a PWA!

So, short list of what functionality we need:
- Send a link, text selection, photo/video or a file to canvas
  - We should re-use OS native features and register our PWA as a endpoint for all of those
- Record video or sound and wire it through our PWA to our agent runtime(take into account, deffer for now, backend not implemented yet)
- Talk to a selected agent directly - iow make a webrtc call through our PWA to the agent runtime(deffered for now)

Now with all of that, lets start to craft a usable webui
- Our home page (the current "Control Center" place-holder) should be just the menu left and a round button near the bottom right that would toggle a separate card-like toolbox
- Obove the main toolbox button, there should be smaller buttons 
  - Add Note
  - Add Link
  - Upload file
  - Take a photo/video (if available)
- All of those should open a B5 formatted canvas

Layout
- Canvas
  - Material-design v2 card-like design
  - B5 format
    - Landscape or Portrait orientation
    - Full-screen mode (fills viewport)
    - Full-screen mode - separate website for that particular canvas
- New content B5 format vertically scrollable canvases 


- Update manifest to allow native PWA features on Android
  - Share Link
  - Share Text snippet
  - Share Photo/Video/File
- 
  - Send to Canvas
    - Opens the 

Optional 
 - OS based speach-to-text for writing notes/chats with agents
 - OS based text-to-speach for reading out loud
 - Record audio/video and send it to an agent real-time
 - 
  
- 

Create Canvas #1
 - Aligned in the middle
Add a new canvas #2
 - Gets added to the right, first canvas moves left
Add a new canvas #3
 - Gets added to the right, enable vertical scroll





## .incoming backend layers + active-backend delete guard

Land these two together — (3)'s clean form depends on (4)'s single per-backend node.

- [ ] **(4) Normalize the .incoming tree to `.incoming/<driver>/<backend>`.** One stable node per backend (e.g. `.incoming/imap/user@domain.com`, `.incoming/s3/<host>/<bucket>`). Update the context builders in `src/utils/incoming-documents.js` (currently variable-depth: `.incoming/<provider>/<account>/<folder>`, `.incoming/file/<provider>/<account>/…`) + migrate existing trees. Backend layer maps to the `data/backend/<backend>` feature bitmap (already tagged at ingest).
- [ ] **(3) Lock the backend layer tracking enable/disable state (active-backend delete guard).** Lock the `<driver>`/`<backend>` node while the backend is enabled → can't delete/purge an active backend's folder (stop/remove the backend first); unlock on disable/remove. Hook the lifecycle (`setDataBackendConfig`, `enableImap`/`disableImap`, `saveMailbox`/`removeMailbox`). Needs (4)'s single node — with non-cascading `system:*` locks, locking a variable-depth path only protects one node and leaves its folders deletable (half-guarantee). Brittle standalone, hence coupled to (4).

Context: `system:incoming` now locks only the `.incoming` root (non-cascading); subfolders are remove/purge-able. Remove vs Remove-and-purge wired server-side (`?purge=true`, path-scoped). Source-backend tag `data/backend/<backend>` added at ingest (observability/selection, NOT a purge driver). See memory `project_incoming_lock_semantics`.

- [ ] **webui "Purge All" ignores treeType.** `purgeWorkspaceDocuments` (`src/ui/web/src/services/workspace.ts:675`) calls `appendWorkspaceContext(params, contextSpec)` with no `treeName`/`treeType` → always queries the CONTEXT tree. On any directory-tree path it targets the wrong tree and no-ops (or worse, purges the wrong scope). Already hidden in `/.incoming` (button gated off via `isIncomingPath` in `pages/workspaces/[workspaceName]/index.tsx`), but still wrong for other directory-tree paths where the button shows. Fix: thread `treeName`/`treeType` through `purgeWorkspaceDocuments` + `handlePurgeDocuments` like `deleteWorkspaceDocuments` already does (server `/documents/purge` accepts `treeType=directory`).

Fine-tune .cursor/prompts/20260613-hooks+agents.md

## Stored

Implement a local blob store "workspace:data" in {WORKSPACE_ROOT}/data based on cacache
? Content-Defined Chunking (CDC) > block-level dedup on top (Rabin Fingerprints / Buzhash chunking algo)


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
  - [ ] Webdav for workspace/home
  - [ ] canvas-fuse
  - [ ] (optional) dotfiles endpoint via
    - git repo (git clone/push/pull) http(s)://host/workspaces/<workspace>/git/
    - dotfiles(app logic) http(s)://host/workspaces/<workspace>/dotfiles/
    - hooks http(s)://host/workspaces/<workspace>/hooks/

- [ ] Contextualized data 
  - [ ] Files
  - [ ] Notes
  - [ ] Browser tabs
  - [ ] (optional) Dotfile

- [ ] Workspace hooks
- [ ] Agent runtime

## Tasks

{WORKSPACE_ROOT}
  /.stored
  /config
  /db
  /home                # Roaming profile exported via SMB and Webdav
  /data                # Intarnal data/blob store
  /git
    bare.git/          # canonical bare remote (HTTP git targets this)
    hooks/             # deployed files only — HookService reads here
    # no dotfiles/ on server unless you add a server-side apply feature later
  /workspace.json


## Storage API schema

/rest/v2/contexts/:context_id/documents or
/rest/v2/workspaces/:workspace_id/documents 
both return a list

/rest/v2/workspaces/:workspace_id/documents/:docId or /documents/by-id/docId 
/rest/v2/workspaces/:workspace_id/documents/by-hash/algo/hash 
return a specific document

Now if a document is stored on multiple backends - lets say a file is stored in s3, some internal cifs share and localy on a file://deviceId/path
Retrieving of the raw document could be done by appending /content?backend=s3

or as ../documents/by-id/docId/content?backend=foo&token=bar
GET /documents/by-id/:id                     # metadata (locations[] w/ ids + backends)
GET /documents/by-hash/:algo/:hash           # same, hash-addressed
GET /documents/by-id/:id/content?location=<id>&token=<jwt>   # raw bytes / 302 to device
GET /documents/by-id/:id/content?prefer=s3,cifs,file


### Add support for hooks

- We **need** to support hooks for all canvas actions, for example I want to run a hook that automatically sorts all URLs I throw into the to-sort context path. qwen3:latest is really good at this (give it context paths or the whole tree, url title and a few simple instructions how the tree is structures and done)
- I want to run my youtube downloader whenever a youtube link is thrown into home://downloads and download videos to either my S3 or workspace home file backends
- Same for website backups/analytics, file postprocessing etc



Review and refine(if required) all websocket events and their integration across webui and browser-extension to properly handle at least:
- all tree events (both, context + directory)
- all document events
Make sure all active connections are properly shut down on server restart, active ws connections currently prevent a clean server restart (a bug that resurfaced recently)


## MVP Scope (deadline EO 06/26)

### 

### Storage backend (stored)

- Rename fs:home and fs:data to workspace:home and workspace:data
- Ensure 



## WebUI cosmetics

Lets update our current webui @src/ui/web as follows:
- Content area section should be tabbed
- Workspace name should pre prepended with the workspace icon, tab should have a bottom border of the color of the workspace or layer

## Phase #4 - Modular widget/applet systems and Canvas UI

We need to implement a proper, modular, extendible widget/applet system that could be shared between our electron and tauri desktop and android UIs and our main webui. It has to be easily extendible, hence, have a developer-friendly architecture - it should take only a few minutes to create a widget that for example displays a list of recent notes.
Lets not reinvent the wheel and re-use an existing framework that can seamlessly work with agents - A2UI / AGUI / CopilotKit
- https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/
- https://github.com/ag-ui-protocol/ag-ui
- https://www.copilotkit.ai/

### Widgets/Applets

- Central component for the "Canvas" and "Toolbox" elements
- Widgets are self-contained, they can show a clock, video or audio player, a list of recent emails or messages with a specific filter or a list of recently added files or notes or direct messages from your agents
- Widgets can write or update documents or trigger actions(lets say to add a note or quick-reply to a message - chat, email or agent)
- Widgets should be movable and resizeable metro-ui style with a default, minimum and (optional) maximum size configuration, api  should also support auto-resize on screen change(if widgets implement it)
- Widgets should support placement on a Canvas(canvas-server Canvas), Toolbox or both
- Widgets need to store their configuration
  - Each Canvas and Context object has a metadata section, we can store the canvas layout information in metadata.ui.layout and specific canvas widget configuration in metadata.ui.applets (or .widgets) .widget-name {}
- Widgets need to be controllable by agents - "Lucy, show me yesterdays emails related to the migration project on my tv canvas" 

### Toolbox

- Has a global section that contains widgets that are always visible, and a contextualized section that only shows elements related to the current bound/selected context OR chosen/selected canvas
- Good place to store data may be in canvas.metadata.ui.toolbox or context.metadata.ui.toolbox 

## Phase #5
- WebUI should have a "Pinned" section next to Context/Directory tree and Lyers. It should be a nice list of "pinned" folder shortcuts with folder names pointing to any of the 2 supported trees. This seems like a UI/App concern even though we'll rely on that feature in our tauri/electron UIs/desktop overlays too. OK, might not be, maybe we should implement it on the DB level or probably better in the workspace as pinned paths. Not sure whether pinning of a path should lock it or whether we'd just return some "Path not found" error if a pinned path changes. Internally a pinned "DC-Migration" layer points to /work/customer-foo/projects/DC-Migration so behaviour would be exactly the same as when traversing the full path. Having multiple pinned layers with the same name is allowed - its a user-concern to mitigate this.


- Copy/Cut-Paste in layer view (selecting a specific layer > copy > selecting layer B > paste) always uses "/", we should support copy-paste between layers too
- .incoming tree mirrors the backend layout and is immutable but we should still allow removing data within that tree from the backend(s). 
In general, we need to design a backend removal dialog with tick boxes for each backend, which will require a stored queue(persistent) since some backends may take time.
- Removing a object from all its backens will also wipe it from the DB
- .incoming tree should show a "Sync" button for each backend or directory, so that users can trigger a refresh (and sync all newly coppied or renamed files for example)
- .icoming tree should not have a import option nor 






View
/workspaces

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


## Contexts

- Load icon + color from bound path, default to icon + color of a bound workspace

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

## Agents

Agents should be running as self-contained docker containers but for now, we'll implement them the same way as we workspaces

### Memory

### Folder structure

-
- connectors



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

### Add support for additional data sources

- `git`
  - Aim is to streamline our dotfiles management feature/extract git support into a separate module
  - Needs to support branches
- `sql`
  - We'd cache the result internally; you may want to create a canvas aggregating data from various sql db sources along with your emails etc, working with them in any tool would be a curl https://your-canvas-instance/workspaces/:wid/canvases/:cid/documents | jq .. away
- `generic REST endpoint`
  - Lets say a corporate backend with a specific REST API endpoint + query returning a list of non-compliant servers, again could be paired with a TTL for the localy cached result as metadata (this is a pure app concern,  not sure whether we should - at this point - add some form of data invalidation based on TTL to the DB)

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

- Add a workspaces/:workspace_id/db endpoint
  - /stats
  - /status
  - /dump
  - /snapshots
    - /:timestampOrSnapshotID?
      - /dump
      - /restore

## Implement proper sharing functionality for Workspaces, Contexts and Canvases

- Token based (does not require a local user)
- User email based (requires a local user to exist on the same canvas-server instance)
