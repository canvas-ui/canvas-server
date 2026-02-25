# API Reference

All REST endpoints are prefixed with `/rest/v2` unless noted otherwise.
All responses use the standard `ResponseObject` envelope (see [Response Format](#response-format)).

---

## Authentication

### Auth Configuration & Login

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth/config` | — | Get auth strategies & password policy |
| POST | `/auth/login` | Rate-limited | Login (local/IMAP/LDAP/auto) |
| POST | `/auth/logout` | — | Client-side logout (no-op server-side) |
| POST | `/auth/register` | Rate-limited | Register new user |
| GET | `/auth/me` | `authenticateCustom` | Current user profile |

### Password & Email Verification

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| PUT | `/auth/password` | `authenticate` | Change password |
| POST | `/auth/forgot-password` | Rate-limited | Request password reset email |
| POST | `/auth/reset-password` | — | Reset password with token |
| POST | `/auth/verify-email` | Rate-limited | Request verification email |
| GET | `/auth/verify-email/:token` | — | Verify email with token |

### API Tokens

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth/tokens` | `authenticate` | List user's API tokens |
| POST | `/auth/tokens` | `authenticate` | Create API token |
| PUT | `/auth/tokens/:tokenId` | `authenticate` | Update token name/description |
| DELETE | `/auth/tokens/:tokenId` | `authenticate` | Delete API token |
| POST | `/auth/token/verify` | — | Verify JWT or API token validity |

### Devices

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/devices/register` | `authenticate` | Register device, mint device token |
| GET | `/auth/devices` | `authenticate` | List user's devices |
| PATCH | `/auth/devices/:deviceId` | `authenticate` | Rename device |

---

## Workspaces

### Lifecycle

| Method | Path | Auth | ACL | Description |
|--------|------|------|-----|-------------|
| GET | `/workspaces` | `authenticate` | — | List user's workspaces |
| POST | `/workspaces` | `authenticate` | — | Create workspace |
| GET | `/workspaces/:id` | `authenticate` | read | Get workspace |
| PATCH | `/workspaces/:id` | `authenticate` | admin | Update workspace config |
| DELETE | `/workspaces/:id` | `authenticate` | admin | Delete workspace |
| GET | `/workspaces/:id/status` | `authenticate` | read | Get workspace status |
| POST | `/workspaces/:id/start` | `authenticate` | admin | Start workspace |
| POST | `/workspaces/:id/stop` | `authenticate` | admin | Stop workspace |
| POST | `/workspaces/:id/open` | `authenticate` | admin | Start workspace (alias) |
| POST | `/workspaces/:id/close` | `authenticate` | admin | Stop workspace (alias) |
| GET | `/workspaces/:id/contexts` | `authenticate` | read | List workspace's contexts |

### Documents

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:id/documents` | `authenticate` | List/search documents |
| POST | `/workspaces/:id/documents` | `authenticateClient` | Insert documents |
| PUT | `/workspaces/:id/documents` | `authenticateClient` | Update documents |
| DELETE | `/workspaces/:id/documents` | `authenticate` | Hard-delete documents |
| DELETE | `/workspaces/:id/documents/remove` | `authenticate` | Remove documents from context (soft) |
| GET | `/workspaces/:id/documents/by-id/:docId` | `authenticate` | Get document by ID |
| GET | `/workspaces/:id/documents/:docId` | `authenticate` | Get document by ID (shorthand) |
| GET | `/workspaces/:id/documents/by-abstraction/:abstraction` | `authenticate` | List by abstraction type |
| GET | `/workspaces/:id/documents/by-hash/:algo/:hash` | `authenticate` | Get document by checksum |
| DELETE | `/workspaces/:id/documents/clear-database` | `authenticate` | Clear all documents (dev only) |

**Query parameters for GET `/documents`:**
- `q` / `search` — Full-text search query
- `contextSpec` — Context specification filter
- `featureArray` — Feature array filter
- `filterArray` — Additional filters
- `limit`, `offset`, `page` — Pagination

### Tree Operations

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:id/tree` | `authenticate` | Get tree structure |
| POST | `/workspaces/:id/tree/paths` | `authenticate` | Insert path |
| DELETE | `/workspaces/:id/tree/paths` | `authenticate` | Remove path |
| POST | `/workspaces/:id/tree/paths/move` | `authenticate` | Move path |
| POST | `/workspaces/:id/tree/paths/copy` | `authenticate` | Copy path |
| POST | `/workspaces/:id/tree/paths/merge-up` | `authenticate` | Merge bitmaps upward |
| POST | `/workspaces/:id/tree/paths/merge-down` | `authenticate` | Merge bitmaps downward |
| POST | `/workspaces/:id/tree/paths/subtract-up` | `authenticate` | Subtract bitmaps upward |
| POST | `/workspaces/:id/tree/paths/subtract-down` | `authenticate` | Subtract bitmaps downward |
| POST | `/workspaces/:id/tree/layers/merge` | `authenticate` | Merge layer bitmaps |
| POST | `/workspaces/:id/tree/layers/subtract` | `authenticate` | Subtract layer bitmaps |

### Layers

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:id/layers` | `authenticate` | List layers |
| GET | `/workspaces/:id/layers/:layerId` | `authenticate` | Get layer |
| PATCH | `/workspaces/:id/layers/:layerId` | `authenticate` | Rename layer |
| POST | `/workspaces/:id/layers/:layerId/lock` | `authenticate` | Lock layer |
| POST | `/workspaces/:id/layers/:layerId/unlock` | `authenticate` | Unlock layer |
| DELETE | `/workspaces/:id/layers/:layerId` | `authenticate` | Delete layer |

### Bitmaps

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:id/bitmaps` | `authenticate` | List bitmaps |
| GET | `/workspaces/:id/bitmaps/*` | `authenticate` | Get bitmap by path (JSON or raw `.bitmap`) |

### Tokens (workspace sharing)

| Method | Path | Auth | ACL | Description |
|--------|------|------|-----|-------------|
| GET | `/workspaces/:id/tokens` | `authenticate` | admin | List access tokens |
| POST | `/workspaces/:id/tokens` | `authenticate` | admin | Create access token |
| GET | `/workspaces/:id/tokens/:tokenHash` | `authenticate` | admin | Get token details |
| PATCH | `/workspaces/:id/tokens/:tokenHash` | `authenticate` | admin | Update token permissions |
| DELETE | `/workspaces/:id/tokens/:tokenHash` | `authenticate` | admin | Delete token |

### Shares (email-based)

| Method | Path | Auth | ACL | Description |
|--------|------|------|-----|-------------|
| GET | `/workspaces/:id/shares` | `authenticate` | admin | List shares |
| POST | `/workspaces/:id/shares` | `authenticate` | admin | Grant access by email |
| PUT | `/workspaces/:id/shares/:userEmail` | `authenticate` | admin | Update share permissions |
| DELETE | `/workspaces/:id/shares/:userEmail` | `authenticate` | admin | Revoke share |

### Links

| Method | Path | Auth | ACL | Description |
|--------|------|------|-----|-------------|
| GET | `/workspaces/:id/links` | `authenticate` | read | List all links |
| GET | `/workspaces/:id/links/:type` | `authenticate` | read | List links by type |
| POST | `/workspaces/:id/links/:type` | `authenticate` | write | Add link(s) |
| DELETE | `/workspaces/:id/links/:type` | `authenticate` | write | Remove link(s) |

### Dotfiles

| Method | Path | Auth | ACL | Description |
|--------|------|------|-----|-------------|
| GET | `/workspaces/:id/dotfiles` | `authenticate` | read | List dotfiles |
| POST | `/workspaces/:id/dotfiles` | `authenticate` | write | Create dotfiles |
| PUT | `/workspaces/:id/dotfiles` | `authenticate` | write | Update dotfiles |
| DELETE | `/workspaces/:id/dotfiles` | `authenticate` | write | Delete dotfiles |
| GET | `/workspaces/:id/dotfiles/status` | `authenticate` | read | Git repository status |
| POST | `/workspaces/:id/dotfiles/init` | `authenticate` | write | Initialize git repository |
| GET/POST | `/workspaces/:id/dotfiles/git/*` | Basic/Bearer | read/write | Git HTTP backend |

### Services

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:id/services` | `authenticate` | List service statuses |
| POST | `/workspaces/:id/services/:name/enable` | `authenticate` | Enable service |
| POST | `/workspaces/:id/services/:name/disable` | `authenticate` | Disable service |
| GET | `/workspaces/:id/services/:name/config` | `authenticate` | Get service config |
| PUT | `/workspaces/:id/services/:name/config` | `authenticate` | Update service config |

### Settings

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:id/:workspaceId/settings` | — | Get workspace settings |
| PUT | `/workspaces/:id/:workspaceId/settings` | — | Update workspace settings |

> **Note:** Settings routes have known bugs — see API-REVIEW.md.

---

## Contexts

### Lifecycle

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/contexts` | `authenticate` | List user's contexts |
| POST | `/contexts` | `authenticate` | Create context |
| GET | `/contexts/:id` | `authenticate` | Get context |
| PUT | `/contexts/:id` | `authenticate` | Update context |
| DELETE | `/contexts/:id` | `authenticate` | Delete context |

### URL & Path

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/contexts/:id/url` | `authenticate` | Get context URL |
| POST | `/contexts/:id/url` | `authenticate` | Set context URL |
| GET | `/contexts/:id/path` | `authenticate` | Get context path |
| GET | `/contexts/:id/path-array` | `authenticate` | Get context path as array |

### Documents

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/contexts/:id/documents` | `authenticate` | List/search documents |
| POST | `/contexts/:id/documents` | `authenticate` | Insert documents |
| POST | `/contexts/:id/documents/batch` | `authenticate` | Insert documents (batch) |
| PUT | `/contexts/:id/documents` | `authenticate` | Update documents |
| DELETE | `/contexts/:id/documents` | `authenticate` | Hard-delete documents |
| DELETE | `/contexts/:id/documents/remove` | `authenticate` | Remove documents (soft) |
| GET | `/contexts/:id/documents/by-id/:docId` | `authenticate` | Get document by ID |
| GET | `/contexts/:id/documents/:docId` | `authenticate` | Get document by ID (shorthand) |
| DELETE | `/contexts/:id/documents/:docId` | `authenticate` | Delete single document |
| POST | `/contexts/:id/documents/delete` | `authenticate` | Delete documents (legacy) |
| GET | `/contexts/:id/documents/by-abstraction/:abstraction` | `authenticate` | List by abstraction |
| GET | `/contexts/:id/documents/by-hash/:algo/:hash` | `authenticate` | Get by checksum |

### Tree Operations

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/contexts/:id/tree` | `authenticate` | Get tree structure |
| POST | `/contexts/:id/tree/paths` | `authenticate` | Insert path |
| DELETE | `/contexts/:id/tree/paths` | `authenticate` | Remove path |
| POST | `/contexts/:id/tree/paths/move` | `authenticate` | Move path |
| POST | `/contexts/:id/tree/paths/copy` | `authenticate` | Copy path |
| POST | `/contexts/:id/tree/paths/merge-up` | `authenticate` | Merge bitmaps upward |
| POST | `/contexts/:id/tree/paths/merge-down` | `authenticate` | Merge bitmaps downward |
| POST | `/contexts/:id/tree/paths/subtract-up` | `authenticate` | Subtract bitmaps upward |
| POST | `/contexts/:id/tree/paths/subtract-down` | `authenticate` | Subtract bitmaps downward |
| POST | `/contexts/:id/tree/layers/merge` | `authenticate` | Merge layer bitmaps |
| POST | `/contexts/:id/tree/layers/subtract` | `authenticate` | Subtract layer bitmaps |

### Tokens (context sharing)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/contexts/:id/tokens` | `authenticate` | List access tokens |
| POST | `/contexts/:id/tokens` | `authenticate` | Create access token |
| DELETE | `/contexts/:id/tokens/:tokenHash` | `authenticate` | Delete token |

### Shares (email-based)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/contexts/:id/shares` | `authenticate` | List shares |
| POST | `/contexts/:id/shares` | `authenticate` | Grant access by email |
| PUT | `/contexts/:id/shares/:userEmail` | `authenticate` | Update share |
| DELETE | `/contexts/:id/shares/:userEmail` | `authenticate` | Revoke share |

### Dotfiles

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/contexts/:id/dotfiles` | `authenticate` | List dotfiles |
| POST | `/contexts/:id/dotfiles` | `authenticate` | Create dotfiles |
| PUT | `/contexts/:id/dotfiles` | `authenticate` | Update dotfiles |
| DELETE | `/contexts/:id/dotfiles` | `authenticate` | Delete dotfiles |

### Rules

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/contexts/:id/rules` | `authenticate` | List rules |
| POST | `/contexts/:id/rules` | `authenticate` | Create rule |
| PUT | `/contexts/:id/rules/:ruleId` | `authenticate` | Update rule |
| DELETE | `/contexts/:id/rules/:ruleId` | `authenticate` | Delete rule |

> **Note:** Rules routes have known bugs — see API-REVIEW.md.

---

## Public / Shared Access

### Token-Based Workspace Access

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/pub/workspaces/:id` | Bearer token | Get shared workspace |
| GET | `/pub/workspaces/:id/documents` | Bearer token | List documents |
| POST | `/pub/workspaces/:id/documents` | Bearer token | Insert documents |
| GET | `/pub/workspaces/:id/tree` | Bearer token | Get tree |
| POST | `/pub/workspaces/:id/start` | `authenticate` | Start shared workspace |
| POST | `/pub/workspaces/:id/stop` | `authenticate` | Stop shared workspace |

### Token-Based Context Access

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/pub/contexts/:id` | Bearer token / user ACL | Get shared context |
| GET | `/pub/contexts/:id/documents` | Bearer token / user ACL | List documents |
| POST | `/pub/contexts/:id/documents` | Bearer token / user ACL | Insert documents |
| PUT | `/pub/contexts/:id/documents` | Bearer token / user ACL | Update documents |

### Pub Token Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/pub/tokens/validate` | Bearer `canvas-*` | Validate token for resource |
| GET | `/pub/tokens/info` | Bearer `canvas-*` | Get token metadata |
| DELETE | `/pub/tokens/revoke` | `authenticate` | Revoke token (owner) |
| GET | `/pub/health` | — | Health check |

---

## Schemas

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/schemas` | — | List all schemas |
| GET | `/schemas/data/abstraction/:abstraction` | — | List schemas by abstraction |
| GET | `/schemas/data/abstraction/:abstraction.json` | — | Get JSON schema definition |

---

## Roles

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/roles` | `authenticate` | List roles (filter: type/userId/workspaceId/status) |
| POST | `/roles` | `authenticate` | Create role |
| GET | `/roles/:roleId` | `authenticate` | Get role |
| POST | `/roles/:roleId/start` | `authenticate` | Start role |
| POST | `/roles/:roleId/stop` | `authenticate` | Stop role |
| POST | `/roles/:roleId/restart` | `authenticate` | Restart role |
| DELETE | `/roles/:roleId` | `authenticate` | Delete role |
| GET | `/roles/:roleId/logs` | `authenticate` | Get role logs |
| GET | `/roles/:roleId/stats` | `authenticate` | Get role stats |
| GET | `/roles/:roleId/health` | `authenticate` | Get role health |

## Role Templates

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/role-templates` | `authenticate` | List templates |
| GET | `/role-templates/:name` | `authenticate` | Get template |

---

## Agents

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/agents` | `authenticate` | List agents |
| POST | `/agents` | `authenticate` | Create agent |
| GET | `/agents/:id` | `authenticate` | Get agent |
| PUT | `/agents/:id` | `authenticate` | Update agent |
| DELETE | `/agents/:id` | `authenticate` | Delete agent |
| POST | `/agents/:id/start` | `authenticate` | Start agent |
| POST | `/agents/:id/stop` | `authenticate` | Stop agent |
| GET | `/agents/:id/status` | `authenticate` | Get agent status |
| POST | `/agents/:id/chat` | `authenticate` | Chat (non-streaming) |
| POST | `/agents/:id/chat/stream` | `authenticate` | Chat (SSE streaming) |
| GET | `/agents/:id/memory` | `authenticate` | Query agent memory |
| DELETE | `/agents/:id/memory` | `authenticate` | Clear agent memory |
| GET | `/agents/:id/mcp/tools` | `authenticate` | List MCP tools |
| POST | `/agents/:id/mcp/tools/:toolName` | `authenticate` | Call MCP tool |

---

## Admin

All admin routes require `authenticate` + admin role.

### Users

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/admin/users` | admin | List users |
| POST | `/admin/users` | admin | Create user |
| GET | `/admin/users/:userId` | admin | Get user |
| PUT | `/admin/users/:userId` | admin | Update user |
| DELETE | `/admin/users/:userId` | admin | Delete user |
| GET | `/admin/users/:userId/ssh-keys` | admin | List SSH keys |
| POST | `/admin/users/:userId/ssh-keys` | admin | Add SSH key |
| GET | `/admin/users/:userId/ssh-keys/:keyId` | admin | Get SSH key |
| DELETE | `/admin/users/:userId/ssh-keys/:keyId` | admin | Delete SSH key |

### Workspaces

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/admin/workspaces` | admin | List all workspaces |
| POST | `/admin/workspaces` | admin | Create workspace for any user |
| GET | `/admin/workspaces/:id` | admin | Get workspace |
| PUT | `/admin/workspaces/:id` | admin | Update workspace |
| DELETE | `/admin/workspaces/:id` | admin | Delete workspace |
| POST | `/admin/workspaces/:id/reindex-features` | admin | Reindex feature bitmaps |

---

## WebDAV

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| All WebDAV methods | `/workspaces/:workspace/dav/*` | Basic/Bearer | WebDAV filesystem for workspaces |
| PROPFIND/GET/HEAD | `/contexts/:context/dav/*` | Basic/Bearer | Read-only WebDAV for contexts |

---

## Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/ping` (no prefix) | — | Simple ping |
| GET | `/debug` (no prefix) | `authenticate` | Debug info |
| GET | `/ping` | — | Structured status with version/uptime |
| GET | `/menu` | `authenticate` | Dynamic menu based on user role |

---

## WebSocket API

Push-only model over Socket.IO. Clients subscribe to channels to receive scoped events.

### Connection

```javascript
const socket = io(serverUrl, {
  auth: { token: 'your-jwt-or-api-token' }
});
```

### Subscription

```javascript
socket.emit('subscribe', { channel: 'workspace:<id>' });
socket.emit('subscribe', { channel: 'context:<id>' });
socket.emit('unsubscribe', { channel: 'workspace:<id>' });
```

### Workspace Events

| Event | Payload | Description |
|-------|---------|-------------|
| `workspace.status.changed` | `{ workspaceId, status }` | Status changed |
| `workspace.created` | workspace data | Workspace created |
| `workspace.updated` | workspace data | Workspace updated |
| `workspace.deleted` | `{ workspaceId }` | Workspace deleted |
| `workspace.documents.inserted` | `{ workspaceId, documents }` | Documents inserted |
| `workspace.documents.updated` | `{ workspaceId, documents }` | Documents updated |
| `workspace.documents.removed` | `{ workspaceId, documentIds }` | Documents removed (soft) |
| `workspace.documents.deleted` | `{ workspaceId, documentIds }` | Documents deleted (hard) |
| `workspace.tree.path.inserted` | `{ workspaceId, path }` | Tree path inserted |
| `workspace.tree.path.removed` | `{ workspaceId, path }` | Tree path removed |
| `workspace.tree.path.moved` | `{ workspaceId, from, to }` | Tree path moved |
| `workspace.tree.path.copied` | `{ workspaceId, from, to }` | Tree path copied |

### Context Events

| Event | Payload | Description |
|-------|---------|-------------|
| `context.url.set` | `{ contextId, url }` | URL changed |
| `context.updated` | context data | Context updated |
| `context.locked` | `{ contextId }` | Context locked |
| `context.unlocked` | `{ contextId }` | Context unlocked |
| `context.acl.updated` | `{ contextId, acl }` | ACL updated |
| `context.acl.revoked` | `{ contextId }` | ACL revoked |
| `document.inserted` | `{ contextId, documents }` | Documents inserted |
| `document.updated` | `{ contextId, documents }` | Documents updated |
| `document.removed` | `{ contextId, documentId }` | Document removed |
| `document.removed.batch` | `{ contextId, documentIds }` | Documents removed (batch) |
| `document.deleted` | `{ contextId, documentId }` | Document deleted |
| `document.deleted.batch` | `{ contextId, documentIds }` | Documents deleted (batch) |
| `context.tree.path.inserted` | `{ contextId, path }` | Tree path inserted |
| `context.tree.path.removed` | `{ contextId, path }` | Tree path removed |
| `context.tree.path.moved` | `{ contextId, from, to }` | Tree path moved |
| `context.tree.path.copied` | `{ contextId, from, to }` | Tree path copied |

### Agent Events

```javascript
socket.emit('agent:subscribe', { agentId: '<id>' });
socket.emit('agent:unsubscribe', { agentId: '<id>' });
socket.emit('agent:chat:stream', { agentId: '<id>', message: '...' });
```

Agent responses arrive as `agent:chat:chunk` and `agent:chat:done` events.

---

## Response Format

All responses use the `ResponseObject` envelope:

```json
{
  "status": "success | error",
  "statusCode": 200,
  "message": "Human-readable message",
  "payload": {},
  "count": null,
  "totalCount": null
}
```

## Authentication Methods

| Method | Token Format | Use Case |
|--------|-------------|----------|
| JWT | Standard Bearer token | Web UI, short-lived (default: 1 day) |
| API Token | `canvas-*` prefix | Programmatic access, long-lived |
| Device Token | `canvas-*` prefix | Device integrations |

## Access Control

### Workspace ACL Cascade

1. **Owner** — full access
2. **Token-based** (API tokens only) — SHA-256 hash matched against `workspace.acl.tokens`
3. **Email-based** (JWT only) — user email matched against `workspace.acl.users`

### Context ACL

- **Owner** — full access
- **Token-based** — configurable permissions per token
- **Email-based** — access levels: `documentRead`, `documentWrite`, `documentReadWrite`

### Permission Levels

- `read` — view resources
- `write` — create/update/delete resources
- `admin` — full control including ACL management
