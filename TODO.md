# Add support for git as a data source

Lets add a git schema to support git repos and branches. The idea is - lets say I have a canvas created in /work/customer-a/devops/jira-1234, to this canvas I linked all email threads related to that case + all browser tabs + all files ad-hoc created when working on it aand all notes. I would like to also link a specific git branch to that canvas so that I can share the whole canvas with a colleague to work on OR assign a AI agent to complete the task giving him access to all related files.  Now the question becomes, I assume git repos - same as with files, S3 and imap - should be treated as a separate data source on the workspace level

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

Sharing functionality for Workspaces and Contexts is no longer working - we will need a 2 punch process, one for the backend implementation and one for the webui.

The following sharing options should be updated/implemented, please do not implement any changes yet, lets fine-tune the design first:

- Token based sharing: User creates a RO, read+append or a full rw token for a resource and shares it together with the resource URL with another user
  - a pub route currently looks like follows:
    https://canvas-server-url/rest/v2/pub/user@email.tld/workspaces/:workspace_id
    https://canvas-server-url/rest/v2/pub/user@email.tld/contexts/:context_id
    the above is meant to be user/cli friendly, but may require a design tweak due to leakeage of user emails - never leak user emails a wise someone once mentioned
    
  - For workspaces:
    - User - regardless if he is server-local(registered on the current canvas-server remote) or remote - should be able to open a shared workspace / context or even add it via his webUI by specifying the URL and access token. He does not need to be a user on the remote hosting the workspace
    - Workspace would then be added to his index and appear as a normal workspace with type: remote, this part is important, listWorkspaces should return all workspaces including remote / foreign ones
    - Workspace sharing tokens should be stored within the workspace folder so that when a workspace is exported from canvas-server/remoteA and imported to remoteB, it will still allow access (assuming consumer/user updates its URL)
    
  - For contexts:
    - Same applies for contexts, a user should be able to generate a sharing token for his context
    
  - Q1: Should we support ad-hoc secret links under our pub endpoint with expiration? 
        
- User email based sharing: User can allow access to his contexts or workspaces based on user email. User can freely migrate his workspace(s) between a local NAS instance, AWS or some canvas SaaS provider - with that being said, it may present a security risk so no idea whether we should implement it at all

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

