# TODO List

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

- `/workspaces`
- `/contexts`
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

## Workspaces

### Simplify workspace module

- We should auto-create 2 trees
  - Tree of type "contextTree" named "context", this should be the default
  - Tree of type "directoryTree" named "directory" that also contains a /.incoming folder with the current ingestion code

### Update Workspaces REST API

The API shape should be as follows:
- /workspaces/:workspaceNameOrId
  - /documents
  - /trees
    - /:treeNameOrId
      - /layers
        - /<layer-ops-endpoints>
      - /paths (getter for tree paths)
      - /path/<>
    - /tree points to the defautl context tree for backward compatiblity
  - /contexts
    - /:contextId
      - /documents
    - /tree points to the currently-selected context tree (there is always only one)
  - /canvases
    - /:canvasNameOrId
      - /documents

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

#### 

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

### Add support for hooks

- We **need** to support hooks for all canvas actions, for example I want to run a hook that automatically sorts all URLs I throw into the to-sort context. qwen3:latest is really good at this (give it context paths or the whole tree, url title and a few simple instructions how the tree is structures and done)
- I want to run my youtube downloader whenever a youtube link is thrown into home://downloads and download videos to either my S3 or workspace home file backends
- Same for website backups/analytics, file postprocessing etc

workspace
  .hooks
  .storage
    .backends
  .index
  .tree

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
