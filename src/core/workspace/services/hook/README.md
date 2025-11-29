# Workspace Hooks Manager

- Hooks placed in WORKSPACE_ROOT/hooks
- Same as with dotfiles, hooks are by default a git repo
- Available through a dedicated /workspaces/<ws.id || ws.name>/hooks endpoint for management ops
- /workspaces/<ws.id || ws.name>/hooks/git to access hooks via git
- Hooks run in a container
- You can bind hooks to all events available for your workspace or contexts/canvases(which are based on contexts)
- Examples: Download all yt videos linked in universe://home/to-downlaod or Sort all emails based on the current context tree from work://customer-foo/project-bar

## Hook connectors

## Predefined hooks / hook templates


