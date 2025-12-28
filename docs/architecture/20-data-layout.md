# Data layout (portable vs server-only)

The project intentionally splits data into:

- **Portable user data** (copyable between servers; the “truth”)
- **Server-only state** (runtime indexes, secrets, operational state)

## Portable data

### User home (portable)

Root: `CANVAS_USER_HOME` (see `src/env.js`)

Typical layout:

- Note: **the API may accept `user.email` (and sometimes name) as a convenient identifier**, but **`user.id` is the internal primary key**. The email-named folder is a filesystem convention for admin sanity (SMB mounts, grep-ability), not a data model decision.

- `{user_home}/config/`
  - `tokens.json` (user API tokens)
  - `contexts.json` (user contexts)
  - other user config
- `{user_home}/workspaces/`
  - `universe/` (special personal workspace)
  - `{workspace-name}/` (other workspaces)
- `{user_home}/agents/` (if/when agents are stored per-user in the FS)

### Workspace directory (portable unit)

- `{workspace}/config/workspace.json`
  - Workspace metadata
  - ACL, including `acl.tokens` (workspace resource tokens)
  - service toggles (e.g. `services.home.enabled`)
- `{workspace}/db/`
  - SynapsD storage for documents, indexes, tree view
- `{workspace}/home/`
  - user files / WebDAV mount target
- `{workspace}/roles/`
  - workspace-scoped role configs + sockets/runtime files (implementation dependent)

### Agent directory (portable unit)

Agents are stored as directories with a config file and a SynapsD DB:

- `{agent}/config/agent.json`
- `{agent}/db/` (SynapsD)
- `{agent}/data/`, `{agent}/tmp/` (agent-specific)

## Server-only state (not portable)

Root: `CANVAS_SERVER_HOME` (see `src/env.js`)

- `{server_home}/db/*.json`
  - users/workspaces/contexts/roles/agents indexes (rebuildable-ish)
  - `passwords.json` (should never “travel” by default; security boundary)
  - rate limits
- `{server_home}/config/*.json`
  - `roles.json` (global roles + autostart list)
  - `auth.json`, `smtp.json` (deployment config)

## Sanity rules

- **If it’s user-owned and should survive migration → it belongs in `{user_home}` or inside the workspace/agent directory.**
- **If it’s runtime bookkeeping or server secrets → it belongs in `{server_home}`.**

