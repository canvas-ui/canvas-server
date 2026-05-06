# API Reference

All REST endpoints are prefixed with `/rest/v2` unless noted otherwise.
All responses use the standard `ResponseObject` envelope (see [Response Format](#response-format)).

Auth column shorthand: **`authenticate`** = JWT or API token; **`authenticateClient`** = JWT or **device** token (used for ingestion from the web UI or registered devices).

## Domain Model

A **Workspace** is a bucket for indexing data from any backend (local FS, IMAP, S3, NAS, CIFS, HTTP, streaming sources). Each workspace has:

- **SynapsD** (index/DB) — stores document metadata, checksums, schemas, and bitmap indexes
- **Stored** (storage) — manages backends where actual data lives. A backend is a driver+config pair (e.g. `fs:home`, `s3:archive`). Currently supports local FS; S3, IMAP, etc. planned.
- **Trees** — named virtual views built on bitmap indexes. Two tree types are supported:
  - `context` — layered/intersection semantics
  - `directory` — folder semantics with unique node IDs

A **Document** is a checksum-addressed indexed object. A single `greatestSongEver.mp3`:
- Is indexed **once** by checksum (e.g. `sha256/abc123...`)
- Can be **stored** on multiple backends simultaneously (tracked via `locations[]`, e.g. `stored://fs:workspace/…`, `s3://…`, `http://…`)
- Can be **linked** to multiple virtual paths in the tree via bitmap indexes

A **Context** is a user's current position/scope within a workspace — like a cursor pointing at a URL (e.g. `universe://music/concerts`). A context is always bound to exactly one `context` tree. When the context moves from one path to another, bound applications and devices should show only the data relevant to that path inside that bound tree.

A **ContextTree** is not the same thing as a **Context**:
- **Context** = runtime focus/navigation state for a user and bound devices
- **ContextTree** = indexed tree view used to resolve/query context paths

### Three Levels of Document Operations

| Operation | What happens | Data in index | Data on backends |
|-----------|-------------|---------------|------------------|
| **Unlink** (`/remove`) | Remove bitmap link between document and virtual path | Stays | Stays |
| **Delete from index** (`DELETE /documents`) | Remove document record from SynapsD | Removed | Stays |
| **Evict / Destroy** (`DELETE /documents/evict`) | Remove data from one or all storage backends; removes from index when all backends are cleared | Removed if all backends cleared | Removed from specified (or all) backends |

### Insert Flow

When a document is inserted (e.g. drag-and-drop of a file to `/home/music/concerts/foo`):

1. **Store** — data is persisted to one or more backends (default: configured backends for that data type)
2. **Index** — document metadata + checksum registered in SynapsD
3. **Link** — bitmap index updated to link the document to the target virtual path(s)

The API should accept optional `paths[]` and `backends[]` parameters; when omitted, sensible defaults apply (current context path, configured default backends).

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
| PATCH | `/auth/devices/:deviceId` | `authenticate` | Update device `name` / `description` |

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
| GET | `/workspaces/:id/stats` | `authenticate` | read | Get workspace database stats |
| POST | `/workspaces/:id/start` | `authenticate` | admin | Start workspace |
| POST | `/workspaces/:id/stop` | `authenticate` | admin | Stop workspace |
| GET | `/workspaces/:id/contexts` | `authenticate` | read | List workspace's contexts |

### Documents

**Query:**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:id/documents` | `authenticate` | List/search documents |
| GET | `/workspaces/:id/documents/by-id/:docId` | `authenticate` | Get document by ID scoped to `treeNameOrTreeId` / `context` query (same filters as list) |
| GET | `/workspaces/:id/documents/:docId` | `authenticate` | Get document by ID |
| GET | `/workspaces/:id/documents/by-abstraction/:abstraction` | `authenticate` | List by abstraction type |
| GET | `/workspaces/:id/documents/by-hash/:algo/:hash` | `authenticate` | Get document by checksum |

**Mutate:**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/workspaces/:id/documents` | `authenticateClient` | Index + store + link documents (body may use `documents` or `documentIds` + tree/context) |
| PUT | `/workspaces/:id/documents` | `authenticateClient` | Update document metadata (`documents` or `documentIds`) |

**Three-level removal:**

| Method | Path | Auth | Level | Description |
|--------|------|------|-------|-------------|
| DELETE | `/workspaces/:id/documents/remove` | `authenticate` | Unlink | JSON body: array of document IDs; removes bitmap link for optional `treeNameOrTreeId` / `context` scope |
| DELETE | `/workspaces/:id/documents` | `authenticate` | Index | JSON body: array of document IDs; removes from SynapsD |
| DELETE | `/workspaces/:id/documents/purge` | `authenticate` | Index | Deletes **all** documents matching list query params (no body); same filters as GET list |
| DELETE | `/workspaces/:id/documents/evict` | `authenticate` | Storage | JSON body `{ documentIds, backends? }`; remove from backend(s); deletes from index when all backends cleared |

**DELETE `/documents/evict` body:**
```json
{
  "documentIds": [1, 2, 3],
  "backends": ["fs:workspace"]
}
```
`backends` is optional. If omitted, evicts from **all** backends — rejected with a descriptive error when more than one distinct backend is detected (caller must be explicit to avoid orphaning data on remote storage). When all backends are cleared the document is automatically removed from the index. When only some backends are cleared the index record is updated to reflect remaining locations.

**Evict response payload:**
```json
{
  "successful": [{ "id": 1, "action": "db-deleted", "backendsCleared": ["fs:workspace"] }],
  "failed":     [{ "id": 2, "reason": "multiple backends detected — specify backends explicitly", "backends": ["fs:workspace", "s3:archive"] }],
  "skipped":    [{ "id": 3, "reason": "no matching backends found to evict" }]
}
```

**Dev:**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| DELETE | `/workspaces/:id/documents/clear-database` | `authenticate` | Clear all documents (dev only) |

**Query parameters (GET `/documents`, GET `/documents/by-abstraction/:abstraction`, GET `/documents/by-id/:docId`, DELETE `/documents/purge`):**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` / `search` | string | — | Full-text search query |
| `treeNameOrTreeId` | string | — | Context tree to query against |
| `context` | string | `/` | Path inside the selected context tree |
| `allOf` | string[] | `[]` | Documents must have **all** of these features |
| `noneOf` | string[] | `[]` | Documents must have **none** of these features |
| `anyOf` | string[] | `[]` | Documents must have **at least one** of these features |
| `filters` | string[] | `[]` | Additional filters (e.g. `datetime:updated:today`) |
| `includeIncoming` | boolean | `false` | Include incoming documents |
| `limit`, `offset`, `page` | integer | — | Pagination |

Example: `GET /documents?allOf[]=data/abstraction/file&noneOf[]=tag/deleted&filters[]=datetime:updated:today`

**POST `/documents` body:**
```json
{
  "treeNameOrTreeId": "projects",
  "context": "/music/concerts/foo",
  "documents": [{}],
  "features": ["data/abstraction/file"]
}
```
`treeNameOrTreeId` and `context` are optional. If omitted, the default context tree and `/` are used.

**PUT `/documents` body:**
```json
{
  "context": "/",
  "features": ["data/abstraction/file"],
  "documents": [{ "id": "123", ... }]
}
```

**DELETE `/documents/remove`:** JSON body is a **non-empty array** of document IDs. Query parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `treeNameOrTreeId` | string | — | Tree for unlink scope |
| `context` | string | `/` | Path inside the selected context tree |
| `allOf` | string[] | `[]` | Attribute filter for unlink scope |
| `noneOf` | string[] | `[]` | Attribute filter for unlink scope |
| `anyOf` | string[] | `[]` | Attribute filter for unlink scope |

> **Note on `features` vs `allOf`/`noneOf`/`anyOf`:** Write operations (POST/PUT) use `features` — a flat array of tags to **apply** to documents on insert/update. Read operations (GET/DELETE) use `allOf`, `noneOf`, `anyOf` — structured attribute filters to **query** documents. These map directly to the SynapsD `attributes` query spec.

### Trees

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:id/trees` | `authenticate` | List trees |
| POST | `/workspaces/:id/trees` | `authenticate` | Create tree |
| PATCH | `/workspaces/:id/trees/:treeNameOrTreeId` | `authenticate` | Rename tree |
| DELETE | `/workspaces/:id/trees/:treeNameOrTreeId` | `authenticate` | Destroy tree |
| GET | `/workspaces/:id/trees/:treeNameOrTreeId` | `authenticate` | Get tree structure |
| POST | `/workspaces/:id/trees/:treeNameOrTreeId/paths` | `authenticate` | Insert path |
| DELETE | `/workspaces/:id/trees/:treeNameOrTreeId/paths` | `authenticate` | Remove path |
| POST | `/workspaces/:id/trees/:treeNameOrTreeId/paths/move` | `authenticate` | Move path |
| POST | `/workspaces/:id/trees/:treeNameOrTreeId/paths/copy` | `authenticate` | Copy path |
| POST | `/workspaces/:id/trees/:treeNameOrTreeId/layers/merge` | `authenticate` | Merge layer bitmaps (`context` trees only) |
| POST | `/workspaces/:id/trees/:treeNameOrTreeId/layers/subtract` | `authenticate` | Subtract layer bitmaps (`context` trees only) |

`DELETE .../paths` takes the target path as a **query** parameter (`path`, optional `recursive`), not a JSON body. `POST .../paths` accepts `path`, optional `data`, `autoCreateLayers`.

The same path handlers are mounted on **`/workspaces/:id/tree/...`** with no `:treeNameOrTreeId` segment — that alias uses the workspace **preferred default context tree**.

**Context-tree layers** (under `.../trees/:treeId/...` or `.../tree/...`; `context` trees only for layer ops):

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `.../layers` | `authenticate` | List layers |
| GET | `.../layers/:layerId` | `authenticate` | Get layer by id or name |
| GET | `.../layers/:layerId/documents` | `authenticate` | List documents in layer bitmap |
| PATCH | `.../layers/:layerId` | `authenticate` | Update / rename layer |
| POST | `.../layers/:layerId/lock` | `authenticate` | Lock layer (`lockBy` in body) |
| POST | `.../layers/:layerId/unlock` | `authenticate` | Unlock layer (`lockBy` in body) |
| DELETE | `.../layers/:layerId` | `authenticate` | Delete layer |

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

### IMAP service (nested)

Mounted under **`/workspaces/:id/services/imap`** (same `authenticate` as other workspace routes).

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:id/services/imap/mailboxes` | `authenticate` | List IMAP mailboxes |
| POST | `/workspaces/:id/services/imap/mailboxes` | `authenticate` | Add mailbox |
| GET | `/workspaces/:id/services/imap/mailboxes/:mailboxId` | `authenticate` | Get mailbox |
| PATCH | `/workspaces/:id/services/imap/mailboxes/:mailboxId` | `authenticate` | Update mailbox |
| DELETE | `/workspaces/:id/services/imap/mailboxes/:mailboxId` | `authenticate` | Remove mailbox |
| POST | `/workspaces/:id/services/imap/mailboxes/:mailboxId/test` | `authenticate` | Test connection |
| POST | `/workspaces/:id/services/imap/mailboxes/:mailboxId/sync` | `authenticate` | Trigger sync |
| POST | `/workspaces/:id/services/imap/mailboxes/:mailboxId/start` | `authenticate` | Start mailbox worker |
| POST | `/workspaces/:id/services/imap/mailboxes/:mailboxId/stop` | `authenticate` | Stop mailbox worker |

### Home backend (workspace `home/` filesystem)

| Method | Path | Auth | ACL | Description |
|--------|------|------|-----|-------------|
| GET | `/workspaces/:id/home` | `authenticate` | read | List root of home dir |
| GET | `/workspaces/:id/home/*` | `authenticate` | read | Directory listing or file metadata (`?download` for raw file stream) |
| PUT | `/workspaces/:id/home/*` | `authenticate` | write | Upload/replace file (raw body streamed to path) |
| POST | `/workspaces/:id/home/mkdir` | `authenticate` | write | Create directory (`{ "path" }` body) |
| DELETE | `/workspaces/:id/home/*` | `authenticate` | write | Delete file or directory |
| POST | `/workspaces/:id/home/actions/index` | `authenticate` | write | Promote `home/` paths into SynapsD (`{ files[], context? }`) |

### Hooks (workspace JS hooks)

| Method | Path | Auth | ACL | Description |
|--------|------|------|-----|-------------|
| GET | `/workspaces/:id/hooks` | `authenticate` | read | List hook files under workspace hooks dir |
| GET | `/workspaces/:id/hooks/*` | `authenticate` | read | Get hook source (`.js` at root or under `lib/`) |
| PUT | `/workspaces/:id/hooks/*` | `authenticate` | write | Save hook (`{ "content" }`) |
| DELETE | `/workspaces/:id/hooks/*` | `authenticate` | write | Delete hook file |

### Devices (workspace ↔ device binding)

Indexed device documents (`data/abstraction/device`) for linking registered devices to a workspace.

| Method | Path | Auth | ACL | Description |
|--------|------|------|-----|-------------|
| GET | `/workspaces/:id/devices` | `authenticate` | read | List device bindings (`limit` / `offset` / `page`) |
| GET | `/workspaces/:id/devices/:deviceId` | `authenticate` | read | Get one binding |
| POST | `/workspaces/:id/devices` | `authenticate` | write | Link `deviceId` or `deviceIds[]` from server device registry |
| DELETE | `/workspaces/:id/devices/:deviceId` | `authenticate` | write | Unlink device from workspace |

### Canvases (workspace-scoped)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/workspaces/:id/canvases` | `authenticate` | List canvas layers (`?tree=` optional; default context tree) |
| POST | `/workspaces/:id/canvases` | `authenticate` | Create canvas at `path` (`tree`, `querySpec`, `metadata` in body) |
| GET | `/workspaces/:id/canvases/:canvasIdOrName` | `authenticate` | Get canvas (`?tree=`) |
| PATCH | `/workspaces/:id/canvases/:canvasIdOrName` | `authenticate` | Update canvas (`?tree=`) |
| DELETE | `/workspaces/:id/canvases/:canvasIdOrName` | `authenticate` | Delete canvas layer (`?tree=`) |
| GET | `/workspaces/:id/canvases/:canvasIdOrName/documents` | `authenticate` | List/search documents through canvas spec (`?tree=`, same query shape as top-level canvases) |

Canvas layers store a `querySpec`, so they work well as portable filtered views over mixed data. For example: ingest emails, tag/sort them with features, create a canvas at `/mail/to-review`, then read the same filtered view through REST or a public short code.

---

## Canvases (top-level lookup)

Read-only shortcuts: resolve a canvas by **id** (layer id, ULID, UUID) or **name** across workspaces the user can open. Optional **`?workspace=`** (`id` or name) disambiguates name collisions.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/canvases/:canvasIdOrName` | `authenticate` | Resolve canvas; payload includes `workspaceId`, `treeId`, `path`, etc. |
| GET | `/canvases/:canvasIdOrName/documents` | `authenticate` | List/search documents (`allOf` / `noneOf` / `anyOf`, `filters`, `q` / `search`, pagination) |

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

Context document operations are scoped to the context's current URL path in the context's bound `context` tree.

**Query:**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/contexts/:id/documents` | `authenticate` | List/search documents at context path |
| GET | `/contexts/:id/documents/:docId` | `authenticate` | Get document by ID |
| GET | `/contexts/:id/documents/by-abstraction/:abstraction` | `authenticate` | List by abstraction |
| GET | `/contexts/:id/documents/by-hash/:algo/:hash` | `authenticate` | Get by checksum |

**Mutate:**

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/contexts/:id/documents` | `authenticateClient` | Index + store + link (`documents` or `documentIds`) |
| PUT | `/contexts/:id/documents` | `authenticateClient` | Update (`documents` or `documentIds` + optional `features`) |

**Removal:**

| Method | Path | Auth | Level | Description |
|--------|------|------|-------|-------------|
| DELETE | `/contexts/:id/documents/remove` | `authenticate` | Unlink | JSON body: array of document IDs; optional attribute filters in query |
| DELETE | `/contexts/:id/documents` | `authenticate` | Index | JSON body: array of document IDs |
| DELETE | `/contexts/:id/documents/:docId` | `authenticate` | Index | Delete single document by id |

There is **no** context-scoped `/documents/evict`; use workspace **`/workspaces/:wid/documents/evict`** when storage eviction is required.

**Query parameters (GET `/contexts/:id/documents`, GET `/contexts/:id/documents/by-abstraction/:abstraction`):**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` / `search` | string | — | Full-text search query |
| `allOf` | string[] | `[]` | Documents must have **all** of these features |
| `noneOf` | string[] | `[]` | Documents must have **none** of these features |
| `anyOf` | string[] | `[]` | Documents must have **at least one** of these features |
| `filters` | string[] | `[]` | Additional filters |
| `includeServerContext` | boolean | — | Include server context in scope |
| `includeClientContext` | boolean | — | Include client context in scope |
| `limit`, `offset`, `page` | integer | — | Pagination |

**POST/PUT `/contexts/:id/documents` body:**
```json
{
  "features": ["data/abstraction/file"],
  "documents": [{}]
}
```

**DELETE `/contexts/:id/documents/remove`:** JSON body is a **non-empty array** of document IDs. Query parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `allOf` | string[] | `[]` | Attribute filter for unlink scope |
| `noneOf` | string[] | `[]` | Attribute filter for unlink scope |
| `anyOf` | string[] | `[]` | Attribute filter for unlink scope |

### Tree Operations

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/contexts/:id/tree` | `authenticate` | Get the bound context tree structure |
| POST | `/contexts/:id/tree/paths` | `authenticate` | Insert path in the bound context tree |
| DELETE | `/contexts/:id/tree/paths` | `authenticate` | Remove path from the bound context tree |
| POST | `/contexts/:id/tree/paths/move` | `authenticate` | Move path inside the bound context tree |
| POST | `/contexts/:id/tree/paths/copy` | `authenticate` | Copy path inside the bound context tree |
| POST | `/contexts/:id/tree/layers/merge` | `authenticate` | Merge layer bitmaps in the bound context tree |
| POST | `/contexts/:id/tree/layers/subtract` | `authenticate` | Subtract layer bitmaps in the bound context tree |

The same handlers are also mounted under **`/contexts/:id/trees/default/...`**. `DELETE .../tree/paths` uses query **`path`** (required) and **`recursive`** (optional).

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

---

## Public / Shared Access

### Token-Based Workspace Access

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/pub/workspaces/:id` | Bearer token | Get shared workspace |
| GET | `/pub/workspaces/:id/documents` | Bearer token | List documents |
| POST | `/pub/workspaces/:id/documents` | Bearer token | Insert documents |
| GET | `/pub/workspaces/:id/tree` | Bearer token | Get the default context tree |
| POST | `/pub/workspaces/:id/start` | `authenticate` | Start shared workspace |
| POST | `/pub/workspaces/:id/stop` | `authenticate` | Stop shared workspace |

### Token-Based Context Access

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/pub/contexts/:id` | Bearer token / user ACL | Get shared context |
| GET | `/pub/contexts/:id/documents` | Bearer token / user ACL | List documents |
| POST | `/pub/contexts/:id/documents` | Bearer token / user ACL | Insert documents |
| PUT | `/pub/contexts/:id/documents` | Bearer token / user ACL | Update documents |

### Public Canvas Short Codes

Public canvas shares expose a canvas layer and its document query through a short code. Management endpoints require auth; the read endpoint is public.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/pub/c` | `authenticate` | Find an existing public share for `workspaceId`, `path`, optional `treeName` |
| POST | `/pub/c` | `authenticate` | Create or return a public share for `workspaceId`, `path`, optional `treeName` |
| DELETE | `/pub/c/:code` | `authenticate` | Delete a public canvas share by short code; owner only |
| DELETE | `/workspaces/:id/shares/public-canvas/:code` | `authenticate` + workspace admin | Revoke a public canvas share from workspace share management |
| GET | `/pub/c/:code` | — | Read public canvas payload and documents |

**Create/share a canvas:**

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8001/rest/v2/pub/c \
  -d '{"workspaceId":"my-workspace","treeName":"context","path":"/mail/to-review"}'
```

Successful payload includes:

```json
{
  "code": "aabbccdd",
  "workspaceId": "...",
  "treeName": "context",
  "path": "/mail/to-review",
  "layerId": "...",
  "url": "/pub/c/aabbccdd"
}
```

**Read the public canvas:**

```bash
curl 'http://127.0.0.1:8001/rest/v2/pub/c/aabbccdd?limit=100&allOf[]=data/abstraction/email&noneOf[]=tag/archived'
```

Query parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | `5000` | Max documents returned; capped at `5000` |
| `offset`, `page` | integer | — | Pagination |
| `allOf` | string[] | `[]` | Documents must have all of these features |
| `anyOf` | string[] | `[]` | Documents must have at least one of these features |
| `noneOf` | string[] | `[]` | Documents must have none of these features |
| `filters` | string[] | `[]` | Additional list filters |

The public read combines the saved canvas `querySpec` with request filters. Response payload shape:

```json
{
  "share": { "code": "aabbccdd", "url": "/pub/c/aabbccdd" },
  "workspace": { "id": "...", "name": "my-workspace", "label": "My Workspace" },
  "canvas": { "id": "...", "type": "canvas", "path": "/mail/to-review" },
  "stats": {
    "documentCount": 123,
    "returnedCount": 100,
    "page": 1,
    "pageSize": 100,
    "refreshedAt": "2026-05-06T18:00:00.000Z"
  },
  "documents": {
    "data": [],
    "count": 100,
    "totalCount": 123,
    "error": null
  }
}
```

### Pub Token Management

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/pub/tokens/validate` | Bearer `canvas-*` | Validate token; JSON body `resourceType` (`workspace` \| `context`), `resourceId`, optional `requiredPermission` |
| GET | `/pub/tokens/info` | Bearer `canvas-*` | Get token metadata |
| DELETE | `/pub/tokens/revoke` | `authenticate` + Bearer `canvas-*` on the share token | Revoke that token (caller must be authenticated owner) |
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
| GET | `/agents` | `authenticate` | List agents (optional query `host` — forwarded to agent manager) |
| POST | `/agents` | `authenticate` | Create agent |
| GET | `/agents/:agentIdentifier` | `authenticate` | Get agent by ID or name |
| PUT | `/agents/:agentIdentifier` | `authenticate` | Update agent |
| DELETE | `/agents/:agentIdentifier` | `authenticate` | Delete agent |
| POST | `/agents/:agentIdentifier/start` | `authenticate` | Start agent |
| POST | `/agents/:agentIdentifier/stop` | `authenticate` | Stop agent |
| POST | `/agents/:agentIdentifier/restart` | `authenticate` | Restart agent |
| GET | `/agents/:agentIdentifier/status` | `authenticate` | Get agent status |
| GET | `/agents/:agentIdentifier/session` | `authenticate` | Get currently selected session context |
| PUT | `/agents/:agentIdentifier/session` | `authenticate` | Select active session or switch mode |
| GET | `/agents/:agentIdentifier/sessions` | `authenticate` | List available persistent sessions |
| POST | `/agents/:agentIdentifier/sessions` | `authenticate` | Create a new session |
| PATCH | `/agents/:agentIdentifier/sessions/:sessionId` | `authenticate` | Rename a session |
| DELETE | `/agents/:agentIdentifier/sessions/:sessionId` | `authenticate` | Delete a session |
| POST | `/agents/:agentIdentifier` | `authenticate` | Prompt agent (non-streaming shorthand) |
| POST | `/agents/:agentIdentifier/prompt` | `authenticate` | Prompt agent (non-streaming) |
| POST | `/agents/:agentIdentifier/sessions/:sessionId/prompt` | `authenticate` | Prompt a specific persistent session (non-streaming) |
| POST | `/agents/:agentIdentifier/prompt/stream` | `authenticate` | Prompt agent (SSE streaming) |
| POST | `/agents/:agentIdentifier/sessions/:sessionId/prompt/stream` | `authenticate` | Prompt a specific persistent session (SSE streaming) |
| GET | `/agents/:agentIdentifier/skills` | `authenticate` | List installed skills |
| POST | `/agents/:agentIdentifier/skills` | `authenticate` | Install a skill |
| DELETE | `/agents/:agentIdentifier/skills/:skillName` | `authenticate` | Remove a skill |

### Agent Notes

- `:agentIdentifier` accepts either the agent ID or the agent name/slug (for example `lucy`).
- Agent `id` is an immutable UUID. Agent `name` is the normalized, user-editable route/CLI slug. Agent `label` is display text.
- Session `:sessionId` parameters accept either the session UUID or the normalized session name slug.
- REST prompt endpoints auto-start the agent if needed before sending the prompt.
- REST prompt endpoints use the agent's currently selected session unless `:sessionId` is included in the path.
- Session-addressed prompt endpoints select that persistent session before sending the prompt.
- Session selection persists in agent config and survives restart.
- Agent payloads intentionally omit `apiKey` from responses.

### Agent Create / Update Shape

Top-level fields:

- `name`
- `label`
- `description`
- `color`
- `llmProvider`
- `model`
- `apiKey`
- `baseUrl`
- `metadata`
- `config`

Top-level convenience fields are merged into `config` where applicable, so both of these patterns work:

`name` is normalized for route/CLI use (`"Lucy Dev"` becomes `lucy-dev`). Use `label` for pretty display names.

```json
{
  "name": "lucy",
  "llmProvider": "ollama",
  "model": "qwen3:14b",
  "apiKey": "ollama",
  "baseUrl": "http://localhost:11434/v1"
}
```

```json
{
  "name": "lucy",
  "llmProvider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "config": {
    "identity": {
      "role": "Coding assistant",
      "identity": "Lucy",
      "instructions": "Be concise."
    },
    "prompts": {
      "system": "You are Lucy.",
      "append": "Prefer short answers.",
      "context": "Project-local instructions."
    },
    "memory": "Project memory",
    "skills": [
      {
        "name": "deploy-check",
        "description": "Pre-deploy sanity checklist",
        "content": "Run tests first."
      }
    ],
    "connectors": {
      "anthropic": {
        "temperature": 0.2,
        "maxTokens": 4096,
        "topP": 1,
        "reasoning": true
      }
    },
    "parameters": {
      "temperature": 0.2,
      "maxTokens": 4096
    },
    "session": {
      "mode": "persistent"
    },
    "tools": {},
    "mcp": {
      "servers": []
    }
  }
}
```

### Agent Session Config

`config.session` currently supports:

```json
{
  "mode": "persistent",
  "path": "/absolute/path/to/session.jsonl",
  "experimentalPath": "/absolute/path/to/experimental-session.jsonl"
}
```

Fields:

- `mode`: `persistent`, `experimental`, or `incognito`
- `path`: selected persistent/experimental session file; omitted/null for `incognito`
- `experimentalPath`: reserved persistent session file used by experimental mode

Notes:

- `persistent` is the default.
- If `mode` is `persistent` and `path` is omitted, the backend continues the most recent session for that agent.
- `experimental` uses a dedicated persistent session slot and creates it on first use if needed.
- `incognito` uses an in-memory session and is not listed in persistent session history.

### Agent Session APIs

**GET `/agents/:agentIdentifier/session`** response payload:

```json
{
  "mode": "persistent",
  "sessionId": "0196...",
  "sessionFile": "/absolute/path/to/session.jsonl",
  "messages": [],
  "thinkingLevel": "high",
  "model": {
    "provider": "anthropic",
    "modelId": "claude-sonnet-4-20250514"
  }
}
```

**GET `/agents/:agentIdentifier/sessions`** response payload:

```json
{
  "mode": "persistent",
  "currentSessionId": "0196...",
  "currentSessionPath": "/absolute/path/to/session.jsonl",
  "sessions": [
    {
      "id": "0196...",
      "path": "/absolute/path/to/session.jsonl",
      "cwd": "/agent/home",
      "name": "Debugging auth",
      "parentSessionPath": null,
      "createdAt": "2026-04-24T17:00:00.000Z",
      "updatedAt": "2026-04-24T17:10:00.000Z",
      "messageCount": 12,
      "firstMessage": "let's debug auth",
      "allMessagesText": "let's debug auth ...",
      "isCurrent": true,
      "isExperimental": false
    }
  ]
}
```

**POST `/agents/:agentIdentifier/sessions`** body:

```json
{
  "mode": "persistent",
  "name": "Debugging auth"
}
```

or:

```json
{
  "mode": "experimental"
}
```

or:

```json
{
  "mode": "incognito"
}
```

Successful response payload:

```json
{
  "current": {
    "mode": "persistent",
    "sessionId": "0196...",
    "sessionFile": "/absolute/path/to/session.jsonl",
    "messages": [],
    "thinkingLevel": "high",
    "model": null
  },
  "sessions": {
    "mode": "persistent",
    "currentSessionId": "0196...",
    "currentSessionPath": "/absolute/path/to/session.jsonl",
    "sessions": []
  }
}
```

**PUT `/agents/:agentIdentifier/session`** body:

```json
{
  "mode": "persistent",
  "sessionId": "0196..."
}
```

or:

```json
{
  "mode": "experimental"
}
```

or:

```json
{
  "mode": "incognito"
}
```

Notes:

- Selecting a session updates the agent's persisted `config.session`.
- If the agent is active, session changes trigger a restart so subsequent prompts use the selected session.
- Experimental sessions are persistent and listed like normal sessions, but they are marked with `isExperimental`.

**PATCH `/agents/:agentIdentifier/sessions/:sessionId`** body:

```json
{
  "name": "Pairing on auth"
}
```

Successful response payload is the same shape as the create/select session responses.

**DELETE `/agents/:agentIdentifier/sessions/:sessionId`**

Successful response payload is the same shape as the create/select session responses.

Notes:

- Experimental sessions cannot be deleted.
- Deleting the currently selected persistent session switches the agent back to default persistent session selection.

### Agent Skills

**POST `/agents/:agentIdentifier/skills`** body:

```json
{
  "name": "deploy-check",
  "description": "Pre-deploy sanity checklist",
  "content": "Run tests first."
}
```

**DELETE `/agents/:agentIdentifier/skills/:skillName`** — removes by skill name.

### Agent Prompt Shape

**POST `/agents/:agentIdentifier`**, **POST `/agents/:agentIdentifier/prompt`**, and **POST `/agents/:agentIdentifier/sessions/:sessionId/prompt`** body:

```json
{
  "message": "hello"
}
```

The session-addressed endpoint selects the addressed persistent session before prompting:

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:8001/rest/v2/agents/lucy/sessions/0196-session-id/prompt \
  -d '{"message":"hello"}'
```

Successful response payload:

```json
{
  "messages": [
    {
      "role": "assistant",
      "content": [
        { "type": "text", "text": "Hello." }
      ]
    }
  ]
}
```

### Agent Prompt Stream

**POST `/agents/:agentIdentifier/prompt/stream`** and **POST `/agents/:agentIdentifier/sessions/:sessionId/prompt/stream`** use SSE and emit `data:` frames with these event payloads:

```json
{ "type": "start" }
{ "type": "chunk", "delta": "Hel" }
{ "type": "thinking", "delta": "Need to greet briefly." }
{ "type": "tool_start", "toolName": "searchDocs" }
{ "type": "tool_end", "toolName": "searchDocs", "isError": false }
{ "type": "complete", "messages": [] }
{ "type": "error", "error": "Prompt failed" }
```

After the final event, the server emits a literal `data: [DONE]` terminator frame then closes the stream.

---

## Admin

All admin routes require `authenticate` + admin role.

### Logs

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/admin/logs` | admin | Recent server logs (`tail`, `level`, `module` query filters) |
| GET | `/admin/logs/stream` | admin | SSE stream of log lines (`event: log`, heartbeat comments) |

### Users

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/admin/users` | admin | List users (optional `status`, `userType` query) |
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
| GET | `/admin/workspaces` | admin | List all workspaces (across users; includes owner fields) |
| POST | `/admin/workspaces` | admin | Create workspace for a user (`userId`, `name`, …) |
| DELETE | `/admin/workspaces/:workspaceId` | admin | Delete workspace by id |
| POST | `/admin/workspaces/:workspaceId/reindex-features` | admin | Reindex feature bitmaps (workspace must be active) |

---

## WebDAV

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| All WebDAV methods | `/workspaces/:workspace/dav/*` | Basic/Bearer | WebDAV filesystem for workspaces with roots `Home/`, `Contexts/`, `Trees/` |
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
| `workspace.documents.inserted` | `{ workspaceId, workspaceName, context, features, items, result }` | Documents inserted |
| `workspace.documents.updated` | `{ workspaceId, workspaceName, context, items }` | Documents updated |
| `workspace.documents.removed` | `{ workspaceId, workspaceName, context, attributes, documentIds, result }` | Documents removed (soft) |
| `workspace.documents.deleted` | `{ workspaceId, workspaceName, context, documentIds, result }` | Documents deleted (hard) |
| `workspace.documents.purged` | `{ workspaceId, workspaceName, context, attributes, filters, requested, result }` | Documents purged |
| `workspace.tree.path.inserted` | `{ workspaceId, treeId, treeName, treeType, path }` | Tree path inserted |
| `workspace.tree.path.removed` | `{ workspaceId, treeId, treeName, treeType, path }` | Tree path removed |
| `workspace.tree.path.moved` | `{ workspaceId, treeId, treeName, treeType, from, to }` | Tree path moved |
| `workspace.tree.path.copied` | `{ workspaceId, treeId, treeName, treeType, from, to }` | Tree path copied |

### Context Events

| Event | Payload | Description |
|-------|---------|-------------|
| `context.url.set` | `{ contextId, url }` | URL changed |
| `context.updated` | context data | Context updated |
| `context.locked` | `{ contextId }` | Context locked |
| `context.unlocked` | `{ contextId }` | Context unlocked |
| `context.acl.updated` | `{ contextId, acl }` | ACL updated |
| `context.acl.revoked` | `{ contextId }` | ACL revoked |
| `document.inserted` | `{ contextId, id/documentIds, context, features, workspaceId }` | Documents inserted |
| `document.removed` | `{ contextId, id, context, attributes, workspaceId }` | Document removed |
| `document.removed.batch` | `{ contextId, documentIds, context, attributes, workspaceId }` | Documents removed (batch) |
| `document.deleted.batch` | `{ contextId, documentIds, count, workspaceId }` | Documents deleted (batch) |
| `context.tree.path.inserted` | `{ contextId, treeId, treeName, treeType, path }` | Tree path inserted |
| `context.tree.path.removed` | `{ contextId, treeId, treeName, treeType, path }` | Tree path removed |
| `context.tree.path.moved` | `{ contextId, treeId, treeName, treeType, from, to }` | Tree path moved |
| `context.tree.path.copied` | `{ contextId, treeId, treeName, treeType, from, to }` | Tree path copied |

### Agent Events

```javascript
socket.emit('agent:subscribe', { agentId: '<agentIdentifier>' });
socket.emit('agent:unsubscribe', { agentId: '<agentIdentifier>' });
socket.emit('agent:chat:stream', {
  agentId: '<agentIdentifier>',
  messageId: 'msg_123',
  message: 'hello'
});
```

Socket.IO agent streaming uses these events:

| Event | Payload | Description |
|-------|---------|-------------|
| `agent:subscribed` | `{ agentId }` | Subscription acknowledged |
| `agent:unsubscribed` | `{ agentId }` | Unsubscription acknowledged |
| `agent:chat:start` | `{ agentId, messageId }` | Stream started |
| `agent:chat:chunk` | `{ agentId, messageId, type, delta?, toolName?, isError? }` | Stream delta or tool event |
| `agent:chat:complete` | `{ agentId, messageId, messages }` | Stream completed |
| `agent:chat:error` | `{ agentId, messageId?, error }` | Stream failed (also used for bad input before stream starts) |
| `agent.status.changed` | `{ agentId, status }` | Agent lifecycle state changed |
| `agent.created` | `{ agentId, agentName, agent }` | Agent created |
| `agent.updated` | `{ agentId, updates }` | Agent updated |
| `agent.deleted` | `{ agentId, agentName }` | Agent deleted |

`agent:chat:chunk.type` is one of:

- `chunk` for assistant text deltas
- `thinking` for reasoning deltas
- `tool_start`
- `tool_end`

Unlike REST **`POST .../prompt`**, Socket.IO **`agent:chat:stream`** does **not** auto-start the agent: the agent must already be **active** (`open` succeeds and `isActive`), otherwise the server emits **`agent:chat:error`**.

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

| Decorator / use | Token Format | Use Case |
|-----------------|-------------|----------|
| `authenticate` | JWT **or** API token (`canvas-*`) | Most REST routes |
| `authenticateClient` | JWT **or** device token | Document insert/update from browser or registered device |
| JWT alone | Standard Bearer | Web UI, short-lived (default: 1 day) |
| API Token | `canvas-*` prefix | Programmatic access, long-lived |
| Device Token | `canvas-*` prefix | Device registry + `authenticateClient` routes |

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
