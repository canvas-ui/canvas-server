# Components map (what exists, where it lives)

This is the “index” of the architecture docs: if a component exists, it should be listed here with its primary entry points.

## Runtime entry points

- **Process boot**: `src/init.js`
- **Composition root / DI**: `src/Server.js`
- **Environment config**: `src/env.js`

## Transport layer (HTTP/WebSocket/WebDAV/UI)

- **Fastify server**: `src/transports/index.js`
  - **REST routes**: `src/transports/routes/*`
  - **Auth strategies**: `src/transports/auth/strategies.js`
  - **Auth service**: `src/transports/auth/service.js`
  - **WebSocket handlers**: `src/transports/websocket/*`
  - **MCP transport (currently disabled)**: `src/transports/mcp/*`
  - **Static Web UI**: served from `src/ui/web/dist/`
  - **WebDAV routes**: `src/transports/routes/webdav.js`

## Core domain (singletons)

- **Users manager**: `src/core/user/index.js`
  - Entity: `src/core/user/User.js`
- **Workspace manager**: `src/core/workspace/index.js`
  - Entity: `src/core/workspace/Workspace.js`
  - Workspace services (feature-ish modules):
    - Dotfiles: `src/core/workspace/services/dotfile/`
    - Home sync/index: `src/core/workspace/services/home/`
    - Hooks: `src/core/workspace/services/hook/`
    - IMAP: `src/core/workspace/services/imap/`
    - Graph: `src/core/workspace/services/graph/`
    - Chat: `src/core/workspace/services/chat/`
- **Context manager**: `src/core/context/index.js`
  - Entity: `src/core/context/lib/Context.js`
  - URL model: `src/core/context/lib/Url.js`
- **Roles manager**: `src/core/role/index.js`
  - Base: `src/core/role/Role.js`
  - Types: `src/core/role/GlobalRole.js`, `src/core/role/WorkspaceRole.js`
  - Docker IO + security helpers: `src/core/role/*`
- **Agents manager**: `src/core/agent/index.js`
  - Entity: `src/core/agent/Agent.js`

## Storage engines (libraries shipped in-repo)

- **SynapsD (document DB + indexes + tree view)**: `src/services/synapsd/`
  - Used by: `Workspace` (`workspace/db/`) and `Agent` (`agent/db/`)
- **Stored (file storage/index/cache)**: `src/services/stored/`
  - Used by: workspace `HomeService`

## UI + extensions

- **Web UI**: `src/ui/web/` (built output served by Fastify)
- **Browser extensions**: `extensions/browser-extensions/`

## Docker roles (templates)

- Role templates live in `extensions/roles/*` and are instantiated by the Roles manager.

