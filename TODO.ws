Workspace 

Data Sources

Global
- Workspace manager
- Role manager
- Agent manager
- User manager
- StoreD

Workspace Local
- Home
- Dotfiles
- Roles
- Agents
-

Workspace
// Parameters
- rootPath
- configPath
- config
- id
- name
- label
- icon
- description
- color
- type
- owner
- acl - maybe we should rename it to permissions in the future (lets add a TOOD for now)

// Runtime
- status
- stats
- size
- lastAccessed

// Data/Services
- tree
- documents
- roles
- dotfiles
- home
- agents



Lets add a firefox sidebar / chrome side panel to our browser extension.
The design should loosly copy our popup but implement the following changes:

First tab would be a directory tree icon containing the context tree
- Tree foders/nodes should have a small [+] sign, on click we should load the list of tabs intothe tree directly, the whole implementation should talk to the workspace REST API
- User should be able to create a subfolder or to rename a folder using a context menu, API is implemented here: https://github.com/canvas-ai/canvas-server/blob/dev/src/api/routes/workspaces/tree.js
- Same should be implemented in the popup for the Tree view

browserToCanvasTab should group all tabs by window
- We should additionally implement "Sync All" and "Close All" buttons for the windowsID titleto sync/close all tabs of a particular window

canvasToBrowserTab works the same

A workspace should manage the following:
- JSON Documents/global index stored within its local LMDB database
- JSON Documents for resources may point to other data backends like local files, S3, IMAP, remote github repos etc
- Roles scoped for the workspace
- Agents/Minions
- Hooks
- Dotfiles
- Workspace-local roaming data (every workspace should have a WORKSPACE_ROOT/home folder that will be accessible over REST and apache2 based webdav)
- Share options

How should such a module be structured?
