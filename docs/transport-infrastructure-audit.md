# Transport Infrastructure Audit

**Date:** 2026-02-25  
**Scope:** `src/transports/` — shared transport layer (Fastify HTTP + Socket.IO WebSocket)

---

## 1. WebSocket Channels → Core Module Events

### Architecture

The WebSocket layer is a **push-only** design built on Socket.IO, bootstrapped in `src/transports/websocket/index.js`. Three channel modules are registered per socket on connection:

| Channel module | Source file | Core manager listened | Listener pattern |
|---|---|---|---|
| **context** | `channels/context.js` | `contextManager` | Wildcard `**` via EventEmitter2 |
| **workspace** | `channels/workspace.js` | `workspaceManager` | Wildcard `**` via EventEmitter2 |
| **agent** | `channels/agent.js` | *(none — event-driven via socket RPC)* | Socket event handlers only |

### Context Channel (`channels/context.js`)

- Binds a single `**` wildcard listener to `contextManager`.
- For each event, extracts `contextId` from `payload.contextId || payload.id`.
- Performs ACL check via `contextManager.getContext(userId, contextId)`.
- Only forwards if the socket has explicitly subscribed to `context:<contextId>`.
- Events without a `contextId` are forwarded to **all** users unconditionally (potential over-broadcast — see Issues).

### Workspace Channel (`channels/workspace.js`)

- Binds a single `**` wildcard listener to `workspaceManager`.
- For events with a `workspaceId`, runs `validateWorkspaceAccess()` (owner check → token-based ACL fallback).
- Events **without** a `workspaceId` are forwarded unconditionally (no subscription check).
- Does **not** check the socket's subscription set for workspace events (unlike context channel).

### Agent Channel (`channels/agent.js`)

- Does **not** listen to any core manager events.
- Instead, implements socket-level RPC:
  - `agent:subscribe` / `agent:unsubscribe` — manage room membership.
  - `agent:chat:stream` — full streaming chat over WebSocket with chunk-by-chunk emission.
- Agent access is verified via `fastify.agents.open(userId, agentId, userId)`.

### Event Relay in `transports/index.js`

In addition to the per-socket channel modules, `index.js` directly subscribes to four `contextManager` events and broadcasts via `broadcastToContext()`:

| Event | Broadcast target |
|---|---|
| `context.url.set` | `broadcastToContext(id, ...)` |
| `context.updated` | `broadcastToContext(id, ...)` |
| `context.locked` | `broadcastToContext(id, ...)` |
| `context.unlocked` | `broadcastToContext(id, ...)` |

**Issue:** These four events are relayed **both** by the direct listeners in `index.js` AND by the wildcard listener in `channels/context.js`, causing **duplicate event delivery** to subscribed sockets.

### Subscription Model

Generic `subscribe`/`unsubscribe` socket events (in `websocket/index.js`) handle `context:<id>` and `workspace:<id>` channels with ACL checks. The agent channel uses its own `agent:subscribe`/`agent:unsubscribe` events (parallel mechanism, not unified).

### Broadcast Helpers

Decorated on the Fastify instance:

| Helper | Mechanism |
|---|---|
| `broadcastToUser(userId, event, payload)` | Iterates all connections, matches `conn.user.id` |
| `broadcastToWorkspace(wsId, event, payload)` | Matches `socket.subscriptions.has('workspace:<id>')` |
| `broadcastToContext(ctxId, event, payload)` | Matches `socket.subscriptions.has('context:<id>')` |
| `getUserConnectionCount(userId)` | Count of user connections |

---

## 2. Middleware

### Address Resolver (`middleware/address-resolver.js`)

**Purpose:** Translates human-readable `user/resource` style identifiers in URL params (`:id`) into internal UUIDs.

**How it works:**
1. If `request.params.id` contains `/`, it's treated as a `user/resource` simple identifier.
2. Calls `workspaceManager.resolveWorkspaceIdFromSimpleIdentifier()` or `contextManager.resolveContextIdFromSimpleIdentifier()` depending on `resourceType`.
3. Replaces `request.params.id` with the resolved UUID.
4. Also supports `?ownerId=<userId>` query param for disambiguation of shared resources.
5. If resolution fails, responds with 404 or 400 directly.

**Exports:**
- `resolveWorkspaceAddress` — pre-configured for workspace resources.
- `resolveContextAddress` — pre-configured for context resources.

**Application:** Applied by workspace/context route files as `onRequest` hooks (not visible in this audit, but expected in `routes/workspaces/` and `routes/contexts/`).

### Workspace ACL (`middleware/workspace-acl.js`)

**Purpose:** Multi-layer workspace access control enforcement for REST routes.

**Access check cascade (in order):**
1. **Owner access** — `workspaceManager.getWorkspace(id, userId)`.
2. **Token-based access** (API tokens only) — SHA-256 hash of Bearer token matched against `workspace.acl.tokens[hash]`. Checks expiration + required permission.
3. **Email-based user access** (JWT only) — looks up user email in `workspace.acl.users[email]`. Checks permission.
4. If all fail → 403 Forbidden.

**Decorates request with:**
- `request.workspace` — the resolved Workspace instance.
- `request.workspaceAccess` — `{ permissions, isOwner, description }`.

**Exports convenience factories:**
- `requireWorkspaceRead()`, `requireWorkspaceWrite()`, `requireWorkspaceAdmin()`.

**Performance concern:** Token-based and email-based access both call `workspaceManager.listWorkspaces()` which scans ALL workspaces. This is O(n) per request and could be slow at scale.

---

## 3. Auth Flow

### Strategies (`auth/strategies.js`)

Three Fastify-level verification functions, all following the same pattern: extract Bearer token → classify → verify → load user → set `request.user`.

| Strategy function | Token type | Sets on request |
|---|---|---|
| `verifyJWT` | Standard JWT (non `canvas-` prefix) | `request.user`, `request.client` |
| `verifyApiToken` | `canvas-*` API tokens | `request.user`, `request.token`, optionally `request.resourceToken` |
| `verifyDeviceToken` | `canvas-*` device tokens | `request.user`, `request.client`, `request.token` |

### Authentication Decorators (in `index.js`)

| Decorator | Strategies (OR relation) | Usage |
|---|---|---|
| `authenticate` | `verifyJWT` \|\| `verifyApiToken` | Most routes |
| `authenticateDevice` | `verifyDeviceToken` | Integration/device routes |
| `authenticateClient` | `verifyJWT` \|\| `verifyDeviceToken` | Client ingestion routes |
| `authenticateCustom` | Manual try/catch of JWT → API token | `/auth/me` only |

### Auth Service (`auth/service.js`)

Singleton `AuthService` class managing:

- **Password hashing:** bcrypt with 10 salt rounds.
- **Token storage:** Hybrid — file-based `TokenManager` (per-user `tokens.json`) with `jim` index fallback.
- **Token types:** `api`, `device`, `refresh`, `verification`, `password_reset`.
- **JWT generation:** Signs with `env.auth.jwtSecret`, includes `sub`, `email`, `userType`, `ver` (timestamp-based version for invalidation).
- **Token verification:** Linear scan of all users' tokens to find hash match (O(users × tokens) — see Issues).
- **Rate limiting:** Persistent via `jim` index store.
- **Email:** Nodemailer with SMTP or sendmail fallback.
- **Config files:** Auto-creates `server/config/auth.json` and `server/config/smtp.json` with defaults.

### Login Flow (`strategies.js → login()`)

1. Auto-detect strategy: check existing user's `authMethod` → try LDAP → try IMAP → default to `local`.
2. For `local`: verify password via `authService.verifyPassword()`.
3. For `imap`/`ldap`: authenticate against external server, auto-create/update user.
4. On success: ensure Universe workspace running + default context exists.
5. Route handler (`routes/auth.js`) generates JWT via `authService.generateJWT()`.

### Registration Flow

1. Validate password complexity first.
2. Create user (status: `pending` if email verification required, else `active`).
3. Set password (rollback user on failure).
4. Create email verification token (non-fatal on failure).
5. Send verification email if SMTP configured.

### WebSocket Auth

Separate from REST auth — done in Socket.IO middleware (`websocket/index.js`):
1. Rate-limit handshake attempts per IP (max 10/minute).
2. Extract token from `socket.handshake.auth.token` or `Authorization` header.
3. If `canvas-*`: try device token → try API token.
4. Otherwise: verify as JWT via `authService.verifyToken()`.
5. Check user status is `active`.

---

## 4. Route Endpoints

### Auth Routes (`/rest/v2/auth`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/config` | None | Get auth configuration (strategies, password policy) |
| POST | `/login` | Rate-limited | Login with email/password (local/IMAP/LDAP/auto) |
| POST | `/logout` | None | No-op (client-side logout) |
| POST | `/register` | Rate-limited | Register new user account |
| PUT | `/password` | `authenticate` | Change password (requires current password) |
| POST | `/forgot-password` | Rate-limited | Request password reset email |
| POST | `/reset-password` | None | Reset password with token |
| POST | `/verify-email` | Rate-limited | Request verification email |
| GET | `/verify-email/:token` | None | Verify email with token |
| GET | `/tokens` | `authenticate` | List user's API tokens |
| POST | `/tokens` | `authenticate` | Create API token |
| PUT | `/tokens/:tokenId` | `authenticate` | Update API token (name/description) |
| DELETE | `/tokens/:tokenId` | `authenticate` | Delete API token |
| POST | `/token/verify` | None | Verify any token (JWT or API) |
| POST | `/devices/register` | `authenticate` | Register device, mint device token |
| GET | `/devices` | `authenticate` | List user's devices |
| PATCH | `/devices/:deviceId` | `authenticate` | Rename device |
| GET | `/me` | `authenticateCustom` | Get current user profile |

### Ping Routes (no prefix)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/ping` | None | Simple health check |
| GET | `/debug` | `authenticate` | Debug info (decorators, auth state) |
| GET | `/rest/v2/ping` | None | Structured ping with version/uptime |

### Schema Routes (`/rest/v2/schemas`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | None | List all data schemas |
| GET | `/data/abstraction/:abstraction` | None | Get schema by abstraction type |
| GET | `/data/abstraction/:abstraction.json` | None | Get JSON schema definition |

### Menu Routes (`/rest/v2/menu`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/menu` | `authenticate` | Get dynamic menu structure based on user role |

### Role Routes (`/rest/v2/roles`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | `authenticate` | List roles (filterable by type/userId/workspaceId/status) |
| POST | `/` | `authenticate` | Create new role (admin required for global roles) |
| GET | `/:roleId` | `authenticate` | Get role by ID |
| POST | `/:roleId/start` | `authenticate` | Start role |
| POST | `/:roleId/stop` | `authenticate` | Stop role |
| POST | `/:roleId/restart` | `authenticate` | Restart role |
| DELETE | `/:roleId` | `authenticate` | Delete role (with optional `?force=true`) |
| GET | `/:roleId/logs` | `authenticate` | Get role logs (with `?tail=N`) |
| GET | `/:roleId/stats` | `authenticate` | Get role resource stats |
| GET | `/:roleId/health` | `authenticate` | Get role health status |

### Role Template Routes (`/rest/v2/role-templates`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | `authenticate` | List available role templates from `extensions/roles/` |
| GET | `/:templateName` | `authenticate` | Get specific role template |

### Agent Routes (`/rest/v2/agents`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | `authenticate` | List user's agents (with optional `?host=` filter) |
| POST | `/` | `authenticate` | Create agent |
| GET | `/:agentIdentifier` | `authenticate` | Get agent by ID or name |
| PUT | `/:agentIdentifier` | `authenticate` | Update agent configuration |
| DELETE | `/:agentIdentifier` | `authenticate` | Delete agent (stops first if active) |
| POST | `/:agentIdentifier/start` | `authenticate` | Start agent |
| POST | `/:agentIdentifier/stop` | `authenticate` | Stop agent |
| GET | `/:agentIdentifier/status` | `authenticate` | Get agent status |
| POST | `/:agentIdentifier/chat` | `authenticate` | Chat with agent (non-streaming) |
| POST | `/:agentIdentifier/chat/stream` | `authenticate` | Chat with agent (SSE streaming) |
| GET | `/:agentIdentifier/memory` | `authenticate` | Query/list agent memory |
| DELETE | `/:agentIdentifier/memory` | `authenticate` | Clear agent memory |
| GET | `/:agentIdentifier/mcp/tools` | `authenticate` | List agent's MCP tools |
| POST | `/:agentIdentifier/mcp/tools/:toolName` | `authenticate` | Call an MCP tool |

### Pub Routes (`/rest/v2/pub`)

**Sub-routes:**

#### Pub Token Routes (`/rest/v2/pub/tokens`)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/validate` | Bearer token (canvas-*) | Validate token for resource + permission |
| GET | `/info` | Bearer token (canvas-*) | Get token metadata |
| DELETE | `/revoke` | `authenticate` | Revoke a token (owner only) |

#### Pub Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | None | Pub routes health check |

*(Workspace and context pub sub-routes are registered but defined in separate files not listed in scope.)*

### Admin Routes (`/rest/v2/admin`)

All routes require `authenticate` + `requireAdmin`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/users` | Admin | List all users (filterable by status/userType) |
| POST | `/users` | Admin | Create user (with optional password) |
| GET | `/users/:userId` | Admin | Get user by ID |
| PUT | `/users/:userId` | Admin | Update user (including password) |
| DELETE | `/users/:userId` | Admin | Delete user (self-delete prevented) |
| POST | `/workspaces/:workspaceId/reindex-features` | Admin | Reindex workspace feature bitmaps |
| GET | `/workspaces` | Admin | List all workspaces across all users |
| POST | `/workspaces` | Admin | Create workspace for any user |
| DELETE | `/workspaces/:workspaceId` | Admin | Delete any workspace |

### Admin Users Routes (`/rest/v2/admin/users` — separate plugin)

These appear to be a **duplicate/overlapping** set of admin user routes (see Issues):

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Admin (hook) | List all users |
| GET | `/:userId` | Admin (hook) | Get user details |
| PUT | `/:userId` | Admin (hook) | Update user |
| DELETE | `/:userId` | Admin (hook) | Delete user |
| GET | `/:userId/ssh-keys` | Admin (hook) | List user's SSH keys |
| POST | `/:userId/ssh-keys` | Admin (hook) | Add SSH public key |
| GET | `/:userId/ssh-keys/:keyId` | Admin (hook) | Get specific SSH key |
| DELETE | `/:userId/ssh-keys/:keyId` | Admin (hook) | Delete SSH key |

---

## 5. Issues, Dead Code, and Inconsistencies

### Critical Issues

1. **Duplicate context event delivery.** `index.js` lines 252-280 subscribe to `context.url.set`, `context.updated`, `context.locked`, `context.unlocked` and broadcast them via `broadcastToContext()`. Meanwhile, `channels/context.js` uses a `**` wildcard that catches these same events and forwards them per-socket. Every subscribed socket receives each of these four events **twice**.

2. **Token verification is O(n×m).** Both `verifyApiToken()` and `verifyDeviceToken()` in `auth/service.js` iterate through ALL users and ALL their tokens to find a hash match. With many users/tokens, this becomes a significant per-request bottleneck.

3. **Workspace ACL scans all workspaces.** `workspace-acl.js` calls `workspaceManager.listWorkspaces()` for both token-based and email-based access checks, scanning the entire workspace index for each request.

4. **Workspace channel doesn't check subscriptions.** Unlike the context channel (which checks `socket.subscriptions.has('context:<id>')`), the workspace wildcard listener in `channels/workspace.js` forwards events to any socket where the user has owner/token access — even if the socket never subscribed to that workspace. This could leak events the client didn't ask for.

### Inconsistencies

5. **Duplicate admin user routes.** `routes/admin/index.js` defines CRUD endpoints for `/users` (GET, POST, GET/:id, PUT/:id, DELETE/:id). `routes/admin/users.js` defines an overlapping set of user CRUD endpoints. The `users.js` file additionally provides SSH key management. It's unclear how these are mounted — if both are active at `/rest/v2/admin/users`, route conflicts will occur.

6. **`admin/users.js` uses `ResponseObject` as static methods** (e.g., `ResponseObject.success(...)`, `ResponseObject.error(...)`), but `ResponseObject` is a class with instance methods. These calls will return `undefined` and send broken responses. Every other route file correctly uses `new ResponseObject().method(...)`.

7. **`menu.js` also uses `ResponseObject` as static methods** (`ResponseObject.success(...)`, `ResponseObject.error(...)`), exhibiting the same bug as `admin/users.js`.

8. **`menu.js` receives `users` from plugin options** (`const { users } = options`) but it's registered with `{ prefix: '/rest/v2', onRequest: [server.authenticate] }` — the `users` option is never passed. The `fastify.users` decorator exists but `options.users` will be undefined, causing a crash on the first request.

9. **Agent subscribe/unsubscribe is a separate mechanism.** The generic `subscribe`/`unsubscribe` handler in `websocket/index.js` doesn't handle `agent:` prefixed channels. The agent channel implements its own `agent:subscribe`/`agent:unsubscribe` events. This means two parallel subscription systems exist without a unified interface.

10. **Inconsistent workspace ID format detection.** Different files use different heuristics:
    - `workspace-acl.js` and `websocket/index.js` generic subscribe: UUID regex (`/^[0-9a-f]{8}-...$/i`)
    - `channels/workspace.js` `validateWorkspaceAccess`: 12-char alphanumeric check (`workspaceIdentifier.length === 12`)
    - These will disagree for the same identifier.

### Potential Issues

11. **`authenticateCustom` swallows errors.** The custom auth decorator in `index.js` catches all errors, sends a response, force-closes the socket, and returns without throwing. This means if it fails, the route handler still executes (with `request.user` unset), potentially causing undefined-reference errors. The `/me` route partially mitigates this by checking `reply.sent`, but it's fragile.

12. **Connection cleanup uses `lastActivity` but never updates it.** The periodic cleanup in `websocket/index.js` evicts connections where `now - conn.lastActivity > 30 minutes`, but `lastActivity` is only set at connection time. The `ping` handler doesn't update it. All connections will be force-disconnected after 30 minutes regardless of activity.

13. **No-op logout endpoint.** `POST /auth/logout` does nothing server-side. Since JWTs are stateless and there's no token blacklist, the token remains valid until expiry. This is documented as "client-side only" but could be a security concern.

14. **`ResponseObject` imports `crypto` but never uses it.** Line 3 of `ResponseObject.js` imports `crypto` — it's dead code.

15. **Redundant JWT secret ternary.** `index.js` line 79: `(authService.getJwtExpiry && env.auth.jwtSecret) ? env.auth.jwtSecret : env.auth.jwtSecret` — both branches evaluate to the same value, making the ternary pointless.

16. **`validateUserWithResponse` in `agents/index.js` is broken.** `validateUser()` from `strategies.js` either returns a validated user object (truthy) or throws. It never returns a falsy value. The `if (!validateUser(...))` check will never trigger — exceptions from validation will bubble up as 500 errors instead of the intended 401.

17. **Rate limit fallback uses `tooManyRequests()`.** The `rateLimit()` function in `routes/auth.js` calls `new ResponseObject().tooManyRequests(...)`, but `ResponseObject` has no `tooManyRequests` method. This will throw a TypeError at runtime, causing rate-limited requests to get a 500 instead of 429.

18. **Schema routes have no authentication.** All three schema endpoints are publicly accessible with no auth middleware, which may be intentional for public API documentation but is worth noting.

19. **`channels/workspace.js` imports `crypto` at module level** but only uses it inside `validateWorkspaceAccess()` — minor, but could be a lazy import instead.

20. **Debug endpoint exposes server internals.** `GET /debug` returns all Fastify decorator keys and auth state. This should be restricted to development environments.

### Dead Code

21. **Disabled MCP plugin.** `index.js` line 37 and 303 have commented-out MCP plugin registration.

22. **Unused `crypto` import in `ResponseObject.js`.** The `crypto` module is imported but never referenced.

23. **`register()` in `strategies.js` has commented-out `firstName`/`lastName` fields** (lines 615-616).

24. **`isResourceToken` logic in `verifyApiToken`.** The workspace-level token verification (lines 252-279) attempts `request.server.workspaceManager.get(workspaceName)` which may not match the actual WorkspaceManager API (other code uses `getWorkspace`, `getWorkspaceById`, etc.). This code path may be dead in practice.
