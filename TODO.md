# TODO List

List of WebUI bugs to chew through:

- Delete-key for documents/objects isn't wired — the document list uses per-row delete buttons with no multi-row keyboard-selection model, so that's a separate, larger change. 
Delete key → Remove (MenuTreeView.tsx) Delete/Backspace on the selected layer triggers a confirmed remove. Scoped to the tree container via tabIndex/onKeyDown (not a global window listener) so it can't fire while you're in the document list. Locked layers are blocked with a notice. Caveat: this covers layers. Delete-key for documents/objects isn't wired — the document list uses per-row delete buttons with no multi-row keyboard-selection model, so that's a separate, larger change. Flag it if you want it next.

## Phase #3
- Our side-by-side midnight-command like view is unusable, the idea was to be able to easily tick/untick items
  - Lets say I add "work" to "/home/Hudba/playlist/work" but work layer already contains all data tagged as work including some work music, I should be able to open the "work" layer on one side and the - by default empty - "/home/Hudba/Playlists/work" path on the other, select - in work - what documents I want to link to the path and F5/copy/insert them so that only a subset would ever be merged. We are essentially building a graph using bitmap-based trees

## Phase #4
- WebUI should have a "Pinned" section with pinned paths, it should be a nice list with folder names pointing to any of the 2 supported trees. This seems like a UI/App concern even though we'll rely on that feature in our tauri/electron UIs too. OK, might not be, maybe we should implement it on the DB level as a abstraction on top of the tree abstraction or better, in the workspace as pinned paths. Not sure whether pinning of a path should lock it or whether we'd just return some "Path not found" error. Internally "DC-Migration" -> /work/customer-foo/projects/DC-Migration so behaviour would be exactly the same as when traversing the full path

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

- The main purpose it to be used as a thin transport layer 
  - Workspace -> WorkspaceD

- Works behind NAT
- Re
-
-
- Offline icon cache for offline-only mode

- Workspace type: local, remote
- Agent type: local, remote
- Role type: local, remote

Backend bugs observed (not CLI):
1. dot init says "already initialized" when target dir exists but isn't a valid bare repo (silent no-op) — fixed manually by rm -rf + reinit
2. ws start on inactive workspace hung past 30s, caused server crash earlier in session — couldn't repro after restart


## Contexts

- Load icon + color from bound path, default to icon + color of a bound workspace


## WebUI .2

- Esc to close all boxes/menus
- .incoming tree should not show any actions that require rw access as that subtree is ro by default
- locked layers should show rw opts as greyed out (or we can implement the same on all locked layers but incoming subtree does not allow creation of directories


### Workspaces

- Workspace dirs should contain /cache
  - Cache should be the default cacache dir for remote resources for stored
  - StoreD should always be configured with a default file backend in /data and a cache backend in /cache, local files would not be cached but it may make sense to cache uploads in /cache first and treat is as "incoming"
- We need to re-intorduce both workspace services
  - Webdav (already present in the webui)
  - Git dotfile access (currently missing)
  - We should provide the user commands for windows(if possible, webdav is tricky these days), mac-os and linux how to mount those folders
  - We should also provide rclone commands directly for each workspace, logging on and creating a workspace should have a "Mount locally" button that would either navigate the user how to do that or do it for him (probably a is the MVP option here)
 

### Toolbox and Canvas(es)

- Toolbox is one of the main elements the user will interact with
- Our main menu(left) is where you select what you want to focus on - the workspace, context or directory path or a specific canvas or context - representing the task you work on (lets say work://projects/customer-foo/devops/jira-1234), toolbox on the other hand is - as the name suggest - what you use to work with your data.
- A toolbox should inherently be exportable, meaning, you should be able to open your toolbox in a separate browser window or on your phone or tablet and use touch gestures to dynamically amend what you see on your computer screen(electron or web-based canvas elements) or use those devices to talk to your agents

Toolbox layout:
- Toolbox should by default be placed on the rigth side as a extendible side-panel
- Toolbox layout should be as follows:
  - TL: Launcher mode, cca 40px "dot" element near the right-bottom side of the screen to trigger voice mode or toggle the toolbox, electron-specific(omit for now)
  - T0: Panel mode, slim dark panel with buttons and a small widget area
    - Buttons(icon-only, default setup):
      - Home
        - A toolbox should have a "home screen" or "notification area" - a place where you could put a clock and/or audio player widget, get notifications and display various data, maybe we can extend T0 - keeping the nice dark color - for the Home area and shrink it and display white-background content when switching between different sections
      - Tools (Would open a tabbed T1 section with the following tabs
        - Timeline
          - Vertical zoomable timeline element on the left, first click selects start date, second click end data, Material design v2 styled toggle switches on the right for ad-hoc filters:
            - Index actions:
                - Created
                - Updated
                - Deleted
            - Content related (single toggle whether to also search through indexed events based on document content)
            - Quick filter
                - Today
                - Yesterday
                - This week
                - This month
                - This year
        - Features
          - Material design v2 styled toggle switches for all feature bitmaps
      - Agents: Opens a list of agents in T1 simillar that we do for Contexts or Workspaces, selecting an agent will start a chat with that agent in T2 **we 
      - Toggle toolbox mode or voice mode - button at the bottom of the panel, placeholder for now
  - T1: Extended mode, cca 500px wide panel with controlls - main toolbox area
  - T2: Content mode - Can overlay on top of T1 for things like ad-hoc note taking, replies to messages or chat with agents

 
- As with every other integration, there are 2 modi operandi that we need to take into account - context and workspace mode - or in the context of our toolbox, elements that change(or load) when you navigate to a Context or Canvas and elements that are global - iow always available.
  - I would probably opt for a highligted button right under the Home icon in T0 that would appear when a user navigates to a Context or a Canvas (clicking on it would load T1 with context-relevant widgets)
  
### Widgets

- A central component for the "Canvas" and "Toolbox" elements are "applets" or a better more common term "widgets"
  - Widgets are self-contained elements that can show a clock, video or audio player, a list of recent emails or messages with a specific filter or recently added files etc; we should also support widgets that can write or update documents or trigger actions(lets say to add a note or quick-reply to a message - chat, email or agent)
  - Widgets should be movable and resizeable metro-ui style with a default, minimum and (optional) maximum size configuration, they should also support auto-resize
  - Widgets should support being placed on a Canvas(canvas-server Canvas), Toolbox or both
  - Widgets need to store their configuration
    - Each Canvas and Context object has a metadata section, we can store the canvas layout information in metadata.layout and specific canvas widget configuration in metadata.applets (or .widgets) .widget-name {}
      - The difference here is, storing layout / widget data in a Canvas moves witht he canvas, storing it in a Context moves with the context - you can have one layout and traverse various parts of the tree to display data across various paths with the same UI    
    - Toolbox widgets that are "context-specific" can also be loaded from canvas or context - as a ad-hoc example, if .metadata.toolbox exists, load related widget
  - Lets first create a bare-bones toolbox and then revisit this point

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
  - Aim is to streamline our dotfiles management feature
  - Needs to support branches  
- `sql`
  - We'd cache the result internally as a JSON document(with some TTL?); you may want to create a canvas aggregating data from various sql db sources along with your emails etc, working with them in any tool would be a curl https://your-canvas-instance/workspaces/:wid/canvases/:cid/documents | jq .. away
- `generic REST endpoint`
  - Lets say a corporate backend with a specific REST API endpoint + query returning a list of non-compliant servers, again could be paired with a TTL for the localy cached result as metadata (this is a pure app concern,  not sure whether we should - at this point - add some form of data invalidation based on TTL to the DB)

### Add support for a different (internal) data abstraction - map (2d topological radial surface)

### Add support for hooks

- We **need** to support hooks for all canvas actions, for example I want to run a hook that automatically sorts all URLs I throw into the to-sort context. qwen3:latest is really good at this (give it context paths or the whole tree, url title and a few simple instructions how the tree is structures and done)
- I want to run my youtube downloader whenever a youtube link is thrown into home://downloads and download videos to either my S3 or workspace home file backends
- Same for website backups/analytics, file postprocessing etc

### Import/export workspace(s)

We need to reintroduce the importWorkspace(workspacePath, destroyExisting = bool) and exportWorkspace(nameOrID, destinationPath) methods in our workspace manager.

The design should be as follows(I'm open to suggestsions here):
- importWorkspace(workspacePath, ): Takes a extracted local folder path or a zip or tar file. If the path is a zip or tar/tar.gz we'd first extract it to a temporary folder (not sure where, maybe in users "home" but users "home" is actually his Universe workspace which would prevent the user from ever bee able to import(and replace)/export his universe) - once extracted or in case a path is supplied, we'd check if there is a workspace.json and fail if its not found or not correct. We'd rewrite the original owner with the current owner
ID, update rootPath, configPath and the updatedAt timestamp. store the original owner and details into metadata: {}. On success we'd initialize it the same way as we do for a new workspace

- exportWorkspace(nameOrId, dstPath, format = zip|tar|gzip) would first stop the workspace, then create a archive - again question is where to store it, "cache" folder which would be excluded from zip

### Config file search paths for workspaces

```text
Workspace config paths
    $WORKSPACE_ROOT/.canvas/config/workspace.json
    $WORKSPACE_ROOT/.canvas/workspace.json
    $WORKSPACE_ROOT/.workspace.json
    $WORKSPACE_ROOT/workspace.json

    workspace directories relative to the workspace.json location
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
