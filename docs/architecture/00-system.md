# Canvas Server Architecture (5‑minute overview)

Goal: keep a **correct birds‑eye view** of the system so humans + AI agents can reason about it without re-reading the whole repo.

## One ASCII diagram

```
Clients
  - Web UI (SPA)          - CLI               - Browser extension
          |                 |                         |
          | HTTP/WS         | HTTP                    | WS (socket.io)
          v                 v                         v
   Fastify Transport Server (src/transports/index.js)
     - REST (/rest/v2/*)
     - WebSocket (socket.io)
     - Static UI (dist/)
     - WebDAV (/webdav/:workspace/home/*)
                    |
                    | (calls into)
                    v
   Core Managers (singletons; src/core/*)
     - Users      -> owns user home folders + user index
     - Workspaces -> owns workspace folders + workspace index + workspace services
     - Contexts   -> user-scoped “focus” across workspaces; event source for WS
     - Roles      -> Docker containers as “roles” (global + workspace-scoped)
     - Agents     -> autonomous agents (config + synapsd db per agent)
                    |
                    | (persist into)
                    v
   Storage Layers
     - Portable user data: {CANVAS_USER_HOME}/... (per-user configs + workspaces + agents)
     - Server indexes:     {CANVAS_SERVER_HOME}/db/*.json (rebuildable-ish runtime indexes)
     - SynapsD DB:         workspace/db/  and agent/db/ (documents, tree/indexes)
     - Stored:             used by HomeService for file indexing/cache
```

## Core concepts (nouns, not implementations)

- **User**: an identity with a *portable home directory* (email-named folder today).
- **User Home**: the portable “truth” (configs + workspaces + agents). If you copy it, you basically copied the user (minus server-only secrets).
- **Workspace**: a unit of data + files. Has `config/workspace.json`, `db/` (SynapsD), `home/` (files), and optional `roles/`.
- **Universe workspace**: the user’s special personal workspace (`workspaces/universe/`).
- **Context**: a user-scoped *view/focus* into a workspace + URL state. Contexts emit events; WS relays them.
- **Role**: a Dockerized service. Two scopes:
  - **Global role**: server-wide container (admin-ish, shared).
  - **Workspace role**: container scoped to a workspace (data + socket lives under that workspace).
- **Agent**: an autonomous worker with its own config + SynapsD database, owned by a user.
- **Token**: authentication material. There are user tokens and resource tokens (e.g. workspace ACL tokens).

## Runtime shape (what runs where)

- **Single Node process**: composition root is `src/Server.js`, booted by `src/init.js`.
- **One HTTP server**: `src/transports/index.js` (Fastify + socket.io + static + WebDAV + REST routes).
- **Managers are singletons**: `Server.initialize()` constructs all managers once and injects references.

## Key data boundaries (protect your sanity)

- **Transport layer (Fastify routes + WS)**:
  - Does auth, parses inputs, calls managers.
  - Should not contain business rules.
- **Core managers (`src/core/*`)**:
  - Own the domain rules + ACL decisions.
  - Emit events (especially contexts) that get forwarded to clients.
- **Portable data vs server-only state**:
  - Portable: `{user_home}/...` and `{workspace}/...`.
  - Server-only: `{server_home}/db/passwords.json`, rate limits, runtime role/container state.

## “Happy path” flows (high level)

- **Boot**: `init.js` → `server.initialize()` → managers init → authService init → (optional) admin user creation → start Fastify server.
- **Login**: `/rest/v2/auth/*` → JWT session *or* API token.
- **Open workspace**: workspace manager loads config and starts SynapsD DB (`workspace/db/`).
- **Create context**: context manager ensures workspace is active → creates Context instance → emits `context.created` and forwards context events using wildcard (`**`).
- **WebSocket updates**: socket.io clients join, then receive forwarded manager/context events.

## Files to start reading (onboarding shortcut)

- **Composition root**: `src/Server.js`, `src/init.js`
- **HTTP + WS server**: `src/transports/index.js`, `src/transports/websocket/*`, `src/transports/routes/*`
- **Core managers**: `src/core/user/index.js`, `src/core/workspace/index.js`, `src/core/context/index.js`, `src/core/role/index.js`, `src/core/agent/index.js`
- **Storage engines**: `src/services/synapsd/`, `src/services/stored/`

## Read next (deeper dives)

- `docs/architecture/10-components.md`
- `docs/architecture/20-data-layout.md`
- `docs/architecture/30-auth.md`
- `docs/architecture/40-events-and-realtime.md`
- `docs/architecture/50-decisions-and-boundaries.md`

## Known sharp edges (documented, not excused)

- Internally, the system should be **user.id-first**. **Email is used only for user-home filesystem layout** (admin sanity + portability + SMB mounts). Treat that as a strict boundary.
- UX/CLI prefer **names** over IDs (workspace/context by name) even if internals sometimes still use IDs.

