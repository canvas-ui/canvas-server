# TODO List

## WebUI cosmetics

Lets update our current webui @src/ui/web as follows:

### Content
- (deffered) Content area section should support tabs 

### Workspaces
- Workspace name should pre prepended with the workspace icon, tab should have a bottom border of the color of the workspace or layer

### Contexts
- Load icon + color from bound path, default to icon + color of a bound workspace

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




Lets extend our pi-mono based agent pipeline, we could (continue to) use pi-mono because of the somehow well-tested ecosystem but I'm open to suggestions given the requirements
- Agents should be self-contained, they will eventually run in their own containers
- Eventually we'll create a canvas-edge runtime that will be used for docker based (service) roles, agents and workspaces, with injected tokens/configuration and maybe autoregistration to configured canvas-server instances
- Agents should be assignable to context and workspaces, we should reuse/extend our current ACL model and allow it to lock a agent to a specific workspace or workspace path or context
- Maybe they can re-use our existing canvas-cli, workspace module(with its git capabilities) and our transports but this is a canvas-edge topic, lets aim for the simplest MVP implementation with the current runtime which runs directly from canvas-server
- Agent runtime support
  - Onnx 
  - Ollama/openAI compatible API
  - Anthropic
- WebRTC/speech support, there are many pi-mono speech modules ready to be used (or servers like kokoro or piper), I'd like to be able to send photos and files or talk to an agent directly
- Whatsapp and slack support, the work here was already done (openclaw and all its 1000+ derivates), lets say I have a agent bound to my work workspace, I should be able to call him and ask whether we had any new emails, agent should be able to use canvas-cli or direct api calls wrapped in SKILLS/tools to query latest ingested emails from canvas. Canvas should be the main interface how agents interract with user data, all user data will be indexed in canvas, user defines what parts an agent should manage(or sets up hooks that trigger agent actions), agent should be able to send a whatsapp notification to a user in a example scenario - user configures a hook in his workspace to watch for emails with email.subject.contains(MSFT-TICKET-1234) - on hit trigger an agent action with "Given the context information in work://projects/foo/bar, check whether we finally got that ticket resolved and notify me if yes"

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

- [ ] Workspace hooks
- [ ] Agent runtime


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
- .backends tree mirrors the backend layout (/.backends/<driver>/<resource-address>/<resource-path>) and is immutable but we should still allow removing data within that tree from the backend(s). DONE server-side: DELETE tree path with ?destroy=true (rw backends only, per-backend readOnly config flag, enable-locked backend nodes return 409). Still pending: 
In general, we need to design a backend removal dialog with tick boxes for each backend, which will require a stored queue(persistent) since some backends may take time.
- Removing a object from all its backens will also wipe it from the DB
- .backends tree should show a "Sync" button for each backend or directory, so that users can trigger a refresh (and sync all newly coppied or renamed files for example)
- .backends tree should not have a import option nor 

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
