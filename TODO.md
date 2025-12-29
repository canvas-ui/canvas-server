workspace
  - config
    - workspace.json
    - acl.json
    - storage.json
  -- 
  - acl
  --
  - db -> synapsd
  - tree -> synapsd.tree
    - layers -> synapsd.tree.layers
  - storage -> stored
  - hooks
  --
  - dotfiles 
  - home 

home extends workspace
  - config
    - universe.json
    - acl.json
    - agents.json
    - storage.json
    - 
  --
  - acl
  --
  - agents -> agentd
  - contexts -> contextManager
  - roles -> 
  - tokens
  - identities
  - devices
  - peers

- transports
  - rest
  - websocket
  - webdav


# Roaming home profiles / local file backend

- Each workspace should have a "home" folder
- This home folder should be used as a standard remote drive, users will be able to mount their "home" for each workspace and manage files as they would in onedrive/googledrive & co.
- This home folder should therefor be accessible using a separate apache2 based webdav "canvas role" (we wont implement it yet) and our REST API, endpoint /workspaces/workspace.name/home.
At some point we will have to rewrite our API+synapsd backend to have a common pattern, but for now lets create a simple API in ./api/routes/workspaces/

# Add support for hooks

- We **need** to support hooks for all canvas actions, for example I want to run a hook that automatically sorts all URLs I throw into the to-sort context. qwen3:latest is really good at this (give it context paths or the whole tree, url title and a few simple instructions how the tree is structures and done)
- I want to run my youtube downloader whenever a youtube link is thrown into home://downloads and download videos to either my S3 or workspace home file backends
- Same for website backups/analytics, file postprocessing etc

workspace
  .hooks
  .storage
    .backends
  .index
  .tree

# Import/export workspace(s)

We need to reintroduce the importWorkspace(workspacePath, destroyExisting = bool) and exportWorkspace(nameOrID, destinationPath) methods in our workspace manager.

The design should be as follows(I'm open to suggestsions here):
- importWorkspace(workspacePath, ): Takes a extracted local folder path or a zip or tar file. If the path is a zip or tar/tar.gz we'd first extract it to a temporary folder (not sure where, maybe in users "home" but users "home" is actually his Universe workspace which would prevent the user from ever bee able to import(and replace)/export his universe) - once extracted or in case a path is supplied, we'd check if there is a workspace.json and fail if its not found or not correct. We'd rewrite the original owner with the current owner
ID, update rootPath, configPath and the updatedAt timestamp. store the original owner and details into metadata: {}. On success we'd initialize it the same way as we do for a new workspace

- exportWorkspace(nameOrId, dstPath, format = zip|tar|gzip) would first stop the workspace, then create a archive - again question is where to store it, "cache" folder which would be excluded from zip

# Config file search paths for workspaces

```text
Workspace config paths
    $WORKSPACE_ROOT/.canvas/config/workspace.json
    $WORKSPACE_ROOT/.canvas/workspace.json
    $WORKSPACE_ROOT/.workspace.json
    $WORKSPACE_ROOT/workspace.json

    workspace directories relative to the workspace.json location
```

# Extend workspaces API (partly blocked by synapsd)

- Add a workspaces/:workspace_id/db endpoint
  - /stats
  - /status
  - /dump
  - /snapshots
    - /timestamp
      - /dump
      - /restore

# Add Canvas support

  GET /contexts/:cid/canvases/foo  will create a context-bound canvas within context cid(cid.url) with ID foo
  GET /workspaces/:wid/canvases/foo will create a unbound canvas with contextPath / (or ?contextPath=/foo/bar/baz) with ID "foo"
  
  canvas IDs have to be unique 
  Every canvas will setup a websocket connection to canvas-server
  Canvas open on your tablet, another on your phone, another on your desktop and laptop can all be controllable centraly
  $ hi lucy "can you play me that podcast we started listening to yesterday evening on the tv" # canvas ID "tv"
  $ hi carmack "show me the last emails from that idiot yesterday on my laptop" # canvas ID "laptop"

Add Task support
  - Useful for episodic memory / agentic workloads and AI integration
  - Simillar semantics as Canvas


Context
- /documents
- /agents
- /dotfiles
    in-repo index .dot/index
      - repoPath:type:encryption

    local
      - localPath:remotePath:type:encryption

    db
      - localPath:remotePath:type:encryption:priority
    

ctx dotfiles // ctx = /
  ~/.bashrc -> common/shell/bashrc priority 0
  ~/.bashrc -> mb/shell/bashrc priority 1

ctx dotfiles // ctx = /work/mb
  ~/.bashrc -> mb/shell/bashrc


We need to change the interface for Tree operations in

# Fix Sharing functionality

Sharing functionality for Workspaces and Contexts is no longer working, we will need a 2 punch process, one for the backend implementation and one for the webui. Lets start with the backend (phase #1).

The following sharing options should be updated/implemented, please do not implement any changes yet, lets fine-tune the design first:

- Token based sharing: User creates a R/RW token for a resource and shares it together with the resource URL with another user
  - a pub route currently looks like follows:
    https://canvas-server-url/rest/v2/pub/user@email.tld/workspaces/:workspace_id
    https://canvas-server-url/rest/v2/pub/user@email.tld/contexts/:context_id
    the above is meant to be user/cli friendly, but may require a design tweak
    
  - For workspaces:
    - User - regardless if he is server-local(registered on the current canvas-server remote) or remote - should be able to open a shared workspace / context or even add it via his webUI by specifying the URL and access token. He does not need to be a user on the remote hosting the workspace
    - Workspace would then be added to his index and appear as a normal workspace with type: remote
    - Workspace sharing tokens should be stored within the actual workspace.json(in the workspace root folder), hence, when a workspace is exported from canvas-server/remoteA and imported to remoteB, it will still allow access (assuming consumer/user updates its URL)
    
  - For contexts:
    - Same applies for contexts, a user should be able to generate a sharing token for his context
    
  - Q1: Should we support ad-hoc secret links under our pub endpoint with expiration? 
        
- Username based sharing: User can allow access to his contexts or workspaces based on user email. User email has to be canvas-server local for now but this is not really a requirement given the floating nature of workspaces(one can freely migrate them between a local NAS instance, AWS or some canvas SaaS provider) - with that being said, it may present a security risk so I guess we should not allow arbitrary email IDs to be added

Sharing a workspace or a context this way makes them available to the target user right away due to the way the backend is implemented. As mentioned above, this type of sharing is not portable - iow - if a workspace gets exported, email based permissions would have to be recreated (this may change in the future)


# Architectural changes

## Utils/config

- Use consistently across the canvas-server app
- fix the config class to properly normalize paths(windoze + *nix)
- Remove user + server priority logic, does not make sense in the current setup

## Context handling

- Support contexts on top of remote workspaces
- We need to ensure
  - Context layers will get locked when open in a context
  - Layers will need to have a in-memory map of userid/contextid locks - brrr complexity

