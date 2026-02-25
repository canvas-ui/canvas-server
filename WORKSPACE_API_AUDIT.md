# Workspace Transport Routes & Core Module Audit

## Table of Contents
1. [Route Files Audit](#1-route-files-audit)
2. [Core Module Audit](#2-core-module-audit)
3. [Cross-Cutting Issues](#3-cross-cutting-issues)

---

## 1. Route Files Audit

### 1.1 `workspaces/index.js` — Main Workspace CRUD + Sub-Route Registration

| Method | Path | Auth | ACL | Params / Body | Core Method Called | Business Logic in Route? |
|--------|------|------|-----|---------------|-------------------|--------------------------|
| GET | `/` | `authenticate` | — | — | `workspaceManager.listWorkspaces(userId)` | Yes — manual `validateUser` check duplicates middleware |
| POST | `/` | `authenticate` | — | body: `{name*, label, description, color, icon, homeScreen, type, metadata, acl, links, restApi}` | `workspaceManager.createWorkspace(name, userId, opts)` | Minor — defaults `type` to `'workspace'`, `label` to `name` |
| GET | `/:id` | `authenticate` + `resolveWorkspaceAddress` + `requireWorkspaceRead` | read | params: `{id}` | `workspaceManager.constructResourceAddress(workspace)` + reads `request.workspace` | **Yes** — builds composite response object, constructs resource address |
| GET | `/:id/contexts` | `authenticate` + `resolveWorkspaceAddress` + `requireWorkspaceRead` | read | params: `{id}` | `contextManager.getContextsForWorkspace(id)` | No |
| PATCH | `/:id` | `authenticate` + `resolveWorkspaceAddress` + `requireWorkspaceAdmin` | admin | params: `{id}`, body: `{label, description, color, icon, homeScreen, locked, metadata, acl, links, restApi}` | `workspaceManager.updateWorkspaceConfig(owner, id, userId, body)` | **Yes** — duplicates owner check already handled by `requireWorkspaceAdmin` |
| DELETE | `/:id` | `authenticate` + `resolveWorkspaceAddress` + `requireWorkspaceAdmin` | admin | params: `{id}` | `workspaceManager.removeWorkspace(id, userId, true)` | **Yes** — hardcodes `'universe'` deletion check + duplicate owner check |

**Sub-routes registered:**
- `/:id/documents` → `documents.js`
- `/:id/tree` → `tree.js`
- `/:id` → `lifecycle.js`
- `/:id/tokens` → `tokens.js`
- `/` → `shares.js`
- `/:id/dotfiles` → `dotfiles.js`
- `/:id/layers` → `layers.js`
- `/:id/bitmaps` → `bitmaps.js`
- `/:id/services` → `services.js`
- `/:id/links` → `links.js`
- `/:id` → `settings.js`

**Issues found:**
- `constructResourceAddress` is called on `workspaceManager` in GET `/:id` but this method **does not exist** on `WorkspaceManager`. It only has `constructWorkspaceReference()` (a thin wrapper around module-level function). This will throw at runtime.
- The `validateUserWithResponse` helper is defined but redundant with `fastify.authenticate` middleware on the same routes.
- `settings.js` and `lifecycle.js` are both registered at prefix `/:id`, creating potential route conflicts.

---

### 1.2 `workspaces/lifecycle.js` — Workspace Start/Stop/Open/Close

| Method | Path (relative to `/:id`) | Auth | ACL | Params / Body | Core Method Called | Business Logic in Route? |
|--------|---------------------------|------|-----|---------------|-------------------|--------------------------|
| GET | `/status` | `authenticate` + `requireWorkspaceRead` | read | params: `{id}` | reads `request.workspace.status` | No |
| POST | `/open` | `authenticate` + `requireWorkspaceAdmin` | admin | params: `{id}` | `workspaceManager.startWorkspace(id, userId)` | **Yes** — WebSocket broadcast (3 event names), `resolveWorkspaceId` logic |
| POST | `/close` | `authenticate` + `requireWorkspaceAdmin` | admin | params: `{id}` | `workspaceManager.stopWorkspace(id, userId)` | **Yes** — WebSocket broadcast, manually constructs `updatedWorkspace` object |
| POST | `/start` | `authenticate` + `requireWorkspaceAdmin` | admin | params: `{id}` | `workspaceManager.startWorkspace(id, userId)` | **Yes** — WebSocket broadcast |
| POST | `/stop` | `authenticate` + `requireWorkspaceAdmin` | admin | params: `{id}` | `workspaceManager.stopWorkspace(id, userId)` | **Yes** — WebSocket broadcast |

**Issues found:**
- **Duplicate functionality**: `/open` and `/start` both call `workspaceManager.startWorkspace()`. `/close` and `/stop` both call `workspaceManager.stopWorkspace()`. These are redundant routes.
- `resolveWorkspaceId` helper is defined locally, duplicating similar helpers in `documents.js`, `tree.js`, `layers.js`, `bitmaps.js`. This should be shared middleware.
- WebSocket broadcast code (3 event name patterns) is duplicated 4 times. Should be extracted.
- The `/close` handler manually spreads `workspace.toJSON()` and overrides `status: 'inactive'` — this is business logic that should live in the core.

---

### 1.3 `workspaces/documents.js` — Document CRUD

| Method | Path (relative to `/:id/documents`) | Auth | Params / Body / Query | Core Method Called | Business Logic in Route? |
|--------|--------------------------------------|------|-----------------------|-------------------|--------------------------|
| GET | `/` | `authenticate` | query: `{contextSpec, featureArray, filterArray, limit, offset, page, q, search}` | `workspace.db.ftsQuery()` or `workspace.db.findDocuments()` | **Yes** — search vs. list branching |
| POST | `/` | `authenticateClient` | body: `{contextSpec, featureArray, documents, documentIds}` or `[ids]` | `workspace.db.insertDocumentArray()` | **Yes** — complex input normalization, `enforceClientTags()` |
| GET | `/by-id/:docId` | `authenticate` | params: `{docId}` | `workspace.db.getDocumentById()` | No |
| GET | `/by-abstraction/:abstraction` | `authenticate` | params: `{abstraction}`, query: `{contextSpec, featureArray, filterArray, limit, offset, page}` | `workspace.db.findDocuments()` | **Yes** — constructs derived feature array with abstraction prefix |
| PUT | `/` | `authenticateClient` | body: `{contextSpec, featureArray, documents, documentIds}` | `workspace.db.updateDocumentArray()` | Yes — input normalization |
| DELETE | `/` | `authenticate` | body: `[documentIds]`, query: `{contextSpec, featureArray}` | `workspace.db.deleteDocumentArray()` | **Yes** — `parseDocumentIdArray` validation, partial-failure reporting |
| DELETE | `/remove` | `authenticate` | body: `[documentIds]`, query: `{contextSpec, featureArray}` | `workspace.db.removeDocumentArray()` | **Yes** — similar to DELETE `/`, removes from context rather than hard-delete |
| GET | `/:docId` | `authenticate` | params: `{docId}` | `workspace.db.getDocumentById()` | Minor — `parseDocumentId` |
| GET | `/by-hash/:algo/:hash` | `authenticate` | params: `{algo, hash}` | `workspace.db.getDocumentByChecksumString()` | Minor — constructs checksum string |
| DELETE | `/clear-database` | `authenticate` | — | `workspace.clearDatabaseSync()` | **Yes** — `NODE_ENV` check, auto-starts inactive workspace |

**Issues found:**
- `getWorkspaceInstance()` helper is duplicated across documents, tree, layers, bitmaps (4 copies).
- `broadcastWorkspaceDocEvent()` helper is local. WebSocket broadcasting pattern differs from lifecycle.js.
- `enforceClientTags()` logic manipulates feature arrays — this is business logic.
- The `clear-database` route auto-starts workspaces inline — lifecycle management in a document route.
- POST `/` uses `authenticateClient` while GET uses `authenticate` — inconsistent auth strategy within same resource.

---

### 1.4 `workspaces/tree.js` — Tree Operations

| Method | Path (relative to `/:id/tree`) | Auth | Params / Body / Query | Core Method Called | Business Logic in Route? |
|--------|--------------------------------|------|-----------------------|-------------------|--------------------------|
| GET | `/` | `authenticate` | — | reads `workspace.jsonTree` getter | Minor — null check |
| POST | `/paths` | `authenticate` | body: `{path*, data, autoCreateLayers}` | `workspace.tree.insertPath()` | No |
| POST | `/paths/move` | `authenticate` | body: `{from*, to*, recursive}` | `workspace.tree.movePath()` | No |
| POST | `/paths/copy` | `authenticate` | body: `{from*, to*, recursive}` | `workspace.tree.copyPath()` | No |
| DELETE | `/paths` | `authenticate` | query: `{path*, recursive}` | `workspace.tree.removePath()` | No |
| POST | `/paths/merge-up` | `authenticate` | body: `{path*}` | `workspace.tree.mergeUp()` | No |
| POST | `/paths/merge-down` | `authenticate` | body: `{path*}` | `workspace.tree.mergeDown()` | No |
| POST | `/paths/subtract-up` | `authenticate` | body: `{path*}` | `workspace.tree.subtractUp()` | No |
| POST | `/paths/subtract-down` | `authenticate` | body: `{path*}` | `workspace.tree.subtractDown()` | No |
| POST | `/layers/merge` | `authenticate` | body: `{layerId*, targetLayers*}` | `workspace.tree.mergeLayer()` | No |
| POST | `/layers/subtract` | `authenticate` | body: `{layerId*, targetLayers*}` | `workspace.tree.subtractLayer()` | No |

**Issues found:**
- `getWorkspaceInstance()` duplicated again.
- No ACL middleware — only `authenticate`. All tree operations are open to any authenticated user with access to the workspace.
- Dead code: `treeData = treeJsonString` in GET `/` — there's a try/catch for JSON parsing but no actual `JSON.parse()` call.
- Layer merge/subtract routes at `/layers/*` overlap conceptually with `layers.js` routes.

---

### 1.5 `workspaces/tokens.js` — Token-Based Sharing

| Method | Path (relative to `/:id/tokens`) | Auth | ACL | Params / Body | Core Method Called | Business Logic in Route? |
|--------|----------------------------------|------|-----|---------------|-------------------|--------------------------|
| POST | `/` | `authenticate` + `requireWorkspaceAdmin` | admin | body: `{name, permissions, description, expiresAt}` | `workspace.createToken(opts)` | Minor — maps response fields |
| GET | `/` | `authenticate` + `requireWorkspaceAdmin` | admin | — | `workspace.listTokens()` | **Yes** — computes `isExpired` in route |
| PATCH | `/:tokenHash` | `authenticate` + `requireWorkspaceAdmin` | admin | params: `{tokenHash}`, body: `{permissions, description, expiresAt}` | `workspaceManager.updateWorkspaceConfig()` | **Yes** — directly mutates ACL object, sets `updatedAt`, calls `updateWorkspaceConfig` |
| DELETE | `/:tokenHash` | `authenticate` + `requireWorkspaceAdmin` | admin | params: `{tokenHash}` | `workspace.deleteToken(hash)` | No |
| GET | `/:tokenHash` | `authenticate` + `requireWorkspaceAdmin` | admin | params: `{tokenHash}` | reads `workspace.acl.tokens` directly | **Yes** — directly reads ACL, computes `isExpired` |

**Issues found:**
- **Inconsistent update pattern**: POST/DELETE/GET-list use `Workspace` methods (`createToken`, `deleteToken`, `listTokens`), but PATCH and GET-single bypass them and access `workspace.acl` directly, then call `workspaceManager.updateWorkspaceConfig()`. The `Workspace` class has no `updateToken()` method.
- `isExpired` computation is done in the route handler — should be in `Workspace.listTokens()` or a token model.
- Ownership check (`!request.workspaceAccess.isOwner`) is duplicated in every handler despite `requireWorkspaceAdmin` already being applied.

---

### 1.6 `workspaces/shares.js` — Email-Based Sharing

| Method | Path (relative to `/`) | Auth | ACL | Params / Body | Core Method Called | Business Logic in Route? |
|--------|------------------------|------|-----|---------------|-------------------|--------------------------|
| POST | `/:id/shares` | `authenticate` + `requireWorkspaceAdmin` | admin | body: `{userEmail*, permissions*, description}` | `workspaceManager.updateWorkspaceConfig()` + `fastify.users.getByEmail()` | **Yes** — constructs share data, mutates ACL directly |
| GET | `/:id/shares` | `authenticate` + `requireWorkspaceAdmin` | admin | — | reads `workspace.acl.users` directly | **Yes** — transforms ACL users into array |
| DELETE | `/:id/shares/:userEmail` | `authenticate` + `requireWorkspaceAdmin` | admin | params: `{userEmail}` | `workspaceManager.updateWorkspaceConfig()` | **Yes** — mutates ACL in-place |
| PUT | `/:id/shares/:userEmail` | `authenticate` + `requireWorkspaceAdmin` | admin | params: `{userEmail}`, body: `{permissions*, description}` | `workspaceManager.updateWorkspaceConfig()` | **Yes** — mutates ACL in-place |

**Issues found:**
- **No corresponding methods on `Workspace`**. All share management is done by directly manipulating `workspace.acl` in the route handler and then calling `workspaceManager.updateWorkspaceConfig()`. This should be encapsulated in `Workspace` methods (e.g., `addShare`, `removeShare`, `updateShare`, `listShares`).
- Ownership check duplicated in every handler despite `requireWorkspaceAdmin`.
- User existence check (`fastify.users.getByEmail`) is business logic in the route.

---

### 1.7 `workspaces/dotfiles.js` — Dotfile CRUD + Git HTTP Backend

| Method | Path (relative to `/:id/dotfiles`) | Auth | ACL | Params / Body | Core Method Called | Business Logic in Route? |
|--------|-------------------------------------|------|-----|---------------|-------------------|--------------------------|
| GET | `/` | `authenticate` + `requireWorkspaceRead` | read | query: `{contextSpec, featureArray, limit, offset, page}` | `workspace.db.findDocuments()` | Minor — prepends `data/abstraction/dotfile` to features |
| POST | `/` | `authenticate` + `requireWorkspaceWrite` | write | body: `{dotfiles*, contextSpec, featureArray}` | `workspace.db.insertDocumentArray()` | **Yes** — transforms dotfiles into document format with schema |
| PUT | `/` | `authenticate` + `requireWorkspaceWrite` | write | body: `{documents*}` | `workspace.db.updateDocumentArray()` | No |
| DELETE | `/` | `authenticate` + `requireWorkspaceWrite` | write | body: `[ids]` | `workspace.db.deleteDocumentArray()` | No |
| GET | `/status` | `authenticate` + `requireWorkspaceRead` | read | — | `dotfileManager.getRepositoryStatus()` | No |
| POST | `/init` | `authenticate` + `requireWorkspaceWrite` | write | — | `dotfileManager.initializeRepository()` | No |
| GET | `/git/info/refs` | Basic→Bearer + `authenticate` + `requireWorkspaceRead` | read | query: `{service}` | `dotfileManager.handleGitHttpBackend()` | No |
| POST | `/git/git-upload-pack` | Basic→Bearer + `authenticate` + `requireWorkspaceRead` | read | — (binary body) | `dotfileManager.handleGitHttpBackend()` | No |
| POST | `/git/git-receive-pack` | Basic→Bearer + `authenticate` + `requireWorkspaceWrite` | write | — (binary body) | `dotfileManager.handleGitHttpBackend()` | No |
| GET | `/git/*` | Basic→Bearer + `authenticate` + `requireWorkspaceRead` | read | — | `dotfileManager.handleGitHttpBackend()` | No |
| POST | `/git/*` | Basic→Bearer + `authenticate` + `requireWorkspaceWrite` | write | — (binary body) | `dotfileManager.handleGitHttpBackend()` | No |

**Issues found:**
- `convertBasicAuthToBearer` is a module-level function (not exported, not shared). Could be shared with webdav.js which has similar logic.
- `extractRequestInfo()` duplicates workspace/user extraction that middleware already handles.
- Git content-type parsers are registered at the route level — should be scoped properly to avoid conflicts.

---

### 1.8 `workspaces/layers.js` — Layer Management

| Method | Path (relative to `/:id/layers`) | Auth | Params / Body | Core Method Called | Business Logic in Route? |
|--------|----------------------------------|------|-----------|--------------------|--------------------------|
| GET | `/` | `authenticate` | — | `workspace.tree.listLayers()` | Minor — maps `toJSON()` |
| GET | `/:layerId` | `authenticate` | params: `{layerId}` | `workspace.tree.getLayerById()` or `.getLayer()` | No |
| PATCH | `/:layerId` | `authenticate` | body: `{name}` | `workspace.tree.renameLayer()` | No |
| POST | `/:layerId/lock` | `authenticate` | body: `{lockBy*}` | `workspace.tree.lockLayer()` | No |
| POST | `/:layerId/unlock` | `authenticate` | body: `{lockBy*}` | `workspace.tree.unlockLayer()` | No |
| DELETE | `/:layerId` | `authenticate` | — | `workspace.tree.deleteLayer()` | No |

**Issues found:**
- `getWorkspaceInstance()` duplicated again (4th copy).
- No ACL middleware — any authenticated user can lock/unlock/delete layers.
- Overlap with `tree.js` which has `/layers/merge` and `/layers/subtract` routes.

---

### 1.9 `workspaces/bitmaps.js` — Bitmap Index Access

| Method | Path (relative to `/:id/bitmaps`) | Auth | Params / Query | Core Method Called | Business Logic in Route? |
|--------|-----------------------------------|------|----------------|-------------------|--------------------------|
| GET | `/` | `authenticate` | query: `{includeData, includeRaw}` | `workspace.listBitmaps()` | Minor — rejects `includeRaw` on list |
| GET | `/*` | `authenticate` | params: `{*}`, query: `{includeData, includeRaw}` | `workspace.getBitmap()`, `workspace.listBitmaps()`, `workspace.getBitmapRawBuffer()` | **Yes** — path parsing, `.bitmap` suffix detection, exact vs prefix routing, binary response with custom headers |

**Issues found:**
- `getWorkspaceInstance()` duplicated again (5th copy).
- No ACL middleware.
- Complex path-based routing logic in the wildcard handler should be split into separate endpoints or moved to core.

---

### 1.10 `workspaces/services.js` — Service Configuration

| Method | Path (relative to `/:id/services`) | Auth | Params / Body | Core Method Called | Business Logic in Route? |
|--------|-------------------------------------|------|---------------|-------------------|--------------------------|
| GET | `/` | `authenticate` | — | `workspaceManager.getServicesStatus()` | No |
| POST | `/:serviceName/enable` | `authenticate` | params: `{serviceName}` | `workspaceManager.enableService()` | No |
| POST | `/:serviceName/disable` | `authenticate` | params: `{serviceName}` | `workspaceManager.disableService()` | No |
| GET | `/:serviceName/config` | `authenticate` | params: `{serviceName}` | **Reads filesystem directly** `fs.readFile(configPath)` | **Yes** — reads JSON config file from workspace directory |
| PUT | `/:serviceName/config` | `authenticate` | params: `{serviceName}`, body: `{config*}` | **Writes filesystem directly** `fs.writeFile(configPath)` | **Yes** — creates directory, writes JSON config file |

**Issues found:**
- GET/PUT config routes perform **direct filesystem I/O** in the route handler. This is a significant layer violation.
- Workspace ID resolution is done inline (`workspaceId || paramWorkspaceId` pattern) — inconsistent with other routes.
- No ACL middleware — any authenticated user can enable/disable services.
- `path` and `fs` imports in a route file are a red flag for misplaced logic.

---

### 1.11 `workspaces/links.js` — Workspace Links

| Method | Path (relative to `/:id/links`) | Auth | ACL | Params / Body | Core Method Called | Business Logic in Route? |
|--------|----------------------------------|------|-----|---------------|-------------------|--------------------------|
| GET | `/` | `authenticate` + `requireWorkspaceRead` | read | — | reads `workspace.links` | No |
| GET | `/:type` | `authenticate` + `requireWorkspaceRead` | read | params: `{type}` | `workspace.listLinks(type)` | No |
| POST | `/:type` | `authenticate` + `requireWorkspaceWrite` | write | body: `{ref, refs}` | `workspace.addLink(type, ref)` | Minor — normalizes `ref`/`refs` input |
| DELETE | `/:type` | `authenticate` + `requireWorkspaceWrite` | write | body: `{ref, refs}` | `workspace.removeLink(type, ref)` | Minor — normalizes `ref`/`refs` input |

**Issues found:**
- Well-structured. Properly delegates to `Workspace` methods.
- Only route file (besides dotfiles) that uses ACL middleware consistently.

---

### 1.12 `workspaces/settings.js` — Workspace Settings

| Method | Path (relative to `/:id`) | Auth | Params / Body | Core Method Called | Business Logic in Route? |
|--------|---------------------------|------|---------------|-------------------|--------------------------|
| GET | `/:workspaceId/settings` | — (no auth middleware!) | params: `{workspaceId}` | `workspaceManager.getWorkspace()` | **Yes** — manually constructs settings object from workspace properties |
| PUT | `/:workspaceId/settings` | — (no auth middleware!) | body: `{name, label, description, color, services}` | `workspaceManager.updateWorkspaceConfig()` | **Yes** — builds updates object, reloads workspace |

**Issues found:**
- **CRITICAL: No authentication middleware.** Routes use `request.user.id` but there's no auth hook. Will crash on unauthenticated requests.
- Uses `ResponseObject.error()` and `ResponseObject.success()` as **static methods**, but `ResponseObject` has no static methods — these are instance methods. Will throw `TypeError` at runtime.
- Takes `workspaceManager` from `options` instead of `fastify.workspaceManager` — inconsistent with other route files.
- Route path `/:workspaceId/settings` under prefix `/:id` yields actual path `/:id/:workspaceId/settings` — the `id` and `workspaceId` param mismatch is confusing and likely creates a double-nested param path.
- Duplicates functionality with PATCH `/:id` in `index.js`.

---

### 1.13 `pub/workspaces.js` — Public Token-Based Access

| Method | Path | Auth | Params / Body / Query | Core Method Called | Business Logic in Route? |
|--------|------|------|-----------------------|-------------------|--------------------------|
| POST | `/:workspaceId/start` | `authenticate` | params: `{workspaceId}` | `workspaceManager.startWorkspace()` | Minor — ID resolution |
| POST | `/:workspaceId/stop` | `authenticate` | params: `{workspaceId}` | `workspaceManager.stopWorkspace()` | Minor |
| GET | `/:workspaceId` | — (no auth required) | params: `{workspaceId}` | `checkWorkspaceAccess()` → `workspaceManager.getWorkspace()` | **Yes** — token extraction, ACL check, token usage increment |
| GET | `/:workspaceId/documents` | — | params: `{workspaceId}`, query: `{limit, offset, page}` | `workspace.db.findDocuments()` | **Yes** — token handling |
| POST | `/:workspaceId/documents` | — | body: `{documents*, featureArray}` | `workspace.db.insertDocumentArray()` | **Yes** — maps documents to `data/abstraction/note` schema, token handling |
| GET | `/:workspaceId/tree` | — | params: `{workspaceId}` | reads `workspace.jsonTree` | **Yes** — token handling |

**Issues found:**
- `checkWorkspaceAccess()` calls `workspaceManager.listWorkspaces()` (fetches ALL workspaces) for every token-auth request — O(n) performance problem.
- Token usage increment logic is duplicated in every handler. Should be middleware.
- POST `/:workspaceId/documents` hardcodes schema to `data/abstraction/note` — domain logic in route.

---

### 1.14 `admin/workspaces.js` — Admin Routes

| Method | Path | Auth | Params / Body / Query | Core Method Called | Business Logic in Route? |
|--------|------|------|-----------------------|-------------------|--------------------------|
| GET | `/` | admin check hook | — | `workspaceManager.listWorkspaces()` (no userId) | No |
| GET | `/:workspaceId` | admin check hook | params: `{workspaceId}` | `workspaceManager.getWorkspace(id)` (no userId) | **Yes** — manually constructs details object |
| PUT | `/:workspaceId` | admin check hook | body: `{name, label, description, color, owner}` | `workspaceManager.updateWorkspaceConfig()` | No |
| DELETE | `/:workspaceId` | admin check hook | query: `{destroyData}` | `workspaceManager.removeWorkspace()` | No |

**Issues found:**
- Uses `ResponseObject.error()` and `ResponseObject.success()` as **static methods** — will throw at runtime (same bug as settings.js).
- Takes `workspaceManager` and `users` from plugin `options` — inconsistent pattern.
- Admin can `getWorkspace(id)` without userId, but `WorkspaceManager.getWorkspace()` accepts userId as optional — correct usage.
- Details construction in GET `/:workspaceId` should use `workspace.toJSON()`.

---

### 1.15 `webdav.js` — WebDAV Protocol Access

| Method | Path | Auth | Params | Core Method Called | Business Logic in Route? |
|--------|------|------|--------|-------------------|--------------------------|
| OPTIONS | `/workspaces/:workspace/dav`, `/workspaces/:workspace/dav/*` | none | — | — | DAV capability headers |
| GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK | same paths | custom `authenticate` | params: `{workspace, *}` | `workspaceManager.resolveWorkspaceId()`, `workspaceManager.getWorkspace()`, `workspaceManager.startWorkspace()` | **Yes** — full auth flow, workspace auto-start, delegates to `WebDAVHandler` |

**Issues found:**
- Full authentication logic (Bearer, Basic, password verification) is implemented inline — duplicates `convertBasicAuthToBearer` from dotfiles.js.
- Auto-starts inactive workspaces inline.
- Access check logic duplicates workspace ACL middleware.

---

## 2. Core Module Audit

### 2.1 `WorkspaceManager` (index.js) — Public Methods

| Method | Signature | Called From Routes | Notes |
|--------|-----------|-------------------|-------|
| `initialize()` | `() → Promise<this>` | Server startup | Initializes services, scans, rebuilds indexes |
| `enableService()` | `(workspaceId, userId, serviceName) → Promise<result>` | services.js POST enable | Switch-based service dispatch |
| `disableService()` | `(workspaceId, userId, serviceName) → Promise<result>` | services.js POST disable | Only supports dotfiles + home |
| `getServicesStatus()` | `(workspaceId, userId) → Promise<Object>` | services.js GET | Only returns dotfiles + home status |
| `users` (getter) | `→ UsersService` | Not directly from routes | |
| `roles` (getter) | `→ RolesService` | Not directly from routes | |
| `setRoles()` | `(roles) → void` | Server setup | |
| `setContextManager()` | `(cm) → void` | Server setup | |
| `listWorkspaces()` | `(userId?) → Promise<Array>` | index.js GET /, pub GET, admin GET | Complex: handles owned + shared workspaces |
| `hasWorkspace()` | `(workspaceId, userId?) → Promise<boolean>` | **UNUSED from routes** | |
| `getWorkspace()` | `(workspaceId, userId?) → Promise<Workspace|null>` | Many routes | Caches workspace instances |
| `createWorkspace()` | `(name, userId, options?) → Promise<Object>` | index.js POST / | Creates directory, config, indexes |
| `updateWorkspaceConfig()` | `(ownerUserId, workspaceId, requestingUserId, updates) → Promise<boolean>` | index.js PATCH, tokens PATCH, shares CRUD, settings PUT, admin PUT | Merges updates into config |
| `createUniverseWorkspace()` | `(userId, userEmail, path) → Promise<Object>` | **UNUSED from routes** (likely called during user registration) | Thin wrapper around createWorkspace |
| `removeWorkspace()` | `(workspaceId, userId, destroyData?) → Promise<boolean>` | index.js DELETE, admin DELETE | Stops workspace, removes from index, optionally deletes files |
| `resolveWorkspaceId()` | `(userId, workspaceName, host?) → string|null` | lifecycle.js, documents.js, tree.js, layers.js, bitmaps.js, pub routes, webdav.js | Synchronous name→ID lookup |
| `resolveWorkspaceIdFromReference()` | `(workspaceRef) → string|null` | **UNUSED from routes** | |
| `resolveWorkspaceIdFromSimpleIdentifier()` | `(identifier) → Promise<string|null>` | **UNUSED from routes** (likely used by address-resolver middleware) |
| `parseWorkspaceReference()` | `(ref) → Object|null` | **UNUSED from routes** | Instance wrapper for module function |
| `constructWorkspaceReference()` | `(user, slug, host, path) → string` | **UNUSED from routes** | Instance wrapper for module function |
| `startWorkspace()` | `(workspaceId, userId) → Promise<Workspace>` | lifecycle.js (open, start), pub start, webdav.js | Starts workspace + roles + services |
| `stopWorkspace()` | `(workspaceId, userId) → Promise<boolean>` | lifecycle.js (close, stop), pub stop | Stops workspace + roles |

**Unused methods (from routes):**
1. `hasWorkspace()`
2. `createUniverseWorkspace()`
3. `resolveWorkspaceIdFromReference()`
4. `resolveWorkspaceIdFromSimpleIdentifier()`
5. `parseWorkspaceReference()`
6. `constructWorkspaceReference()`

**Missing methods (called from routes but don't exist):**
1. `constructResourceAddress()` — called in index.js GET `/:id` handler

---

### 2.2 `Workspace` (Workspace.js) — Public Methods & Properties

| Member | Type | Called From Routes | Notes |
|--------|------|-------------------|-------|
| `id` | getter | Many | |
| `name` | getter | Many | |
| `label` | getter | settings.js, admin | |
| `description` | getter | settings.js, admin | |
| `color` | getter | settings.js, admin | |
| `icon` | getter | — (via toJSON) | |
| `homeScreen` | getter | — (via toJSON) | |
| `links` | getter | links.js | |
| `type` | getter | settings.js, admin | |
| `owner` | getter | Many | |
| `rootPath` | getter | services.js (filesystem I/O), admin, settings.js | |
| `status` | getter | lifecycle.js, admin, settings.js | |
| `isActive` | getter | documents.js, layers.js, bitmaps.js, admin | |
| `config` | getter | WorkspaceManager.startWorkspace | |
| `acl` | getter | tokens.js, shares.js, webdav.js | |
| `services` | getter | WorkspaceManager, settings.js, admin | |
| `db` | getter | documents.js, dotfiles.js, pub routes | Throws if not initialized |
| `stored` | getter | **UNUSED from routes** | |
| `tree` | getter | tree.js, layers.js | |
| `directoryTree` | getter | **UNUSED from routes** | |
| `jsonTree` | getter | tree.js, pub tree | |
| `homePath` | getter | webdav.js | |
| `isServiceEnabled()` | `(name) → boolean` | **UNUSED from routes** (used internally) | |
| `setServiceConfig()` | `(name, config) → void` | WorkspaceManager.enableService/disableService | |
| `setIcon()` | `(url) → boolean` | **UNUSED from routes** | |
| `setHomeScreen()` | `(obj) → boolean` | **UNUSED from routes** | |
| `listLinks()` | `(type?) → Array|Object` | links.js | |
| `addLink()` | `(type, ref) → boolean` | links.js | |
| `removeLink()` | `(type, ref) → boolean` | links.js | |
| `start()` | `() → Promise<this>` | WorkspaceManager.startWorkspace | |
| `stop()` | `() → Promise<boolean>` | WorkspaceManager.stopWorkspace, removeWorkspace | |
| `enableHome()` | `() → Promise<void>` | WorkspaceManager.enableService | |
| `disableHome()` | `() → Promise<void>` | WorkspaceManager.disableService | |
| `isHomeEnabled` | getter | WorkspaceManager.getServicesStatus | |
| `insert()` | `(data, opts) → Promise` | **UNUSED from routes** | Convenience wrapper |
| `update()` | `(id, data, opts) → Promise` | **UNUSED from routes** | Convenience wrapper |
| `remove()` | `(id, opts) → Promise` | **UNUSED from routes** | Convenience wrapper |
| `delete()` | `(id) → Promise` | **UNUSED from routes** | Convenience wrapper |
| `get()` | `(id, opts) → Promise` | **UNUSED from routes** | Convenience wrapper |
| `list()` | `(opts) → Promise` | **UNUSED from routes** | Convenience wrapper |
| `listBitmaps()` | `(prefix, opts) → Promise<Array>` | bitmaps.js | |
| `getBitmap()` | `(key, opts) → Promise<Object|null>` | bitmaps.js | |
| `getBitmapRawBuffer()` | `(key) → Promise<Buffer|null>` | bitmaps.js | |
| `clearDatabaseSync()` | `() → result` | documents.js (clear-database) | |
| `createToken()` | `(opts) → Object` | tokens.js POST | |
| `listTokens()` | `() → Array` | tokens.js GET | |
| `deleteToken()` | `(hash) → boolean` | tokens.js DELETE | |
| `verifyToken()` | `(tokenValue) → Object|null` | **UNUSED from routes** (used by auth middleware) | |
| `toJSON()` | `() → Object` | index.js GET, lifecycle.js, pub routes, admin | |

**Unused methods (from routes):**
1. `stored` getter
2. `directoryTree` getter
3. `isServiceEnabled()`
4. `setIcon()`
5. `setHomeScreen()`
6. `insert()` / `update()` / `remove()` / `delete()` / `get()` / `list()` — convenience CRUD wrappers are completely unused; routes call `workspace.db.*` directly

---

### 2.3 Duplicate Logic

| Issue | Locations | Description |
|-------|-----------|-------------|
| `getWorkspaceInstance()` helper | documents.js, tree.js, layers.js, bitmaps.js | 4 nearly identical copies of UUID detection + resolveWorkspaceId + getWorkspace + isActive check |
| `resolveWorkspaceId()` helper | lifecycle.js | 5th copy with slight variation |
| WebSocket broadcast pattern | lifecycle.js (×4 handlers) | Same 3-event-name broadcast block copied 4 times |
| Workspace ID resolution (UUID regex) | 8+ route files | Same UUID regex `/^[0-9a-f]{8}-...$/i` copy-pasted everywhere |
| Owner permission check | tokens.js (×5), shares.js (×4) | `!request.workspaceAccess.isOwner` check despite `requireWorkspaceAdmin` middleware |
| Token increment logic | pub/workspaces.js (×4) | Same `incrementTokenUsage()` call block in every handler |
| Basic→Bearer auth conversion | dotfiles.js, webdav.js | Similar but separate implementations |
| ACL mutation pattern | tokens.js PATCH, shares.js (CRUD) | Direct `workspace.acl` mutation + `updateWorkspaceConfig()` |

### 2.4 Overly Complex Methods

| Method | Location | Complexity | Reason |
|--------|----------|------------|--------|
| `listWorkspaces()` | WorkspaceManager | High | Nested loops, async user lookups inside loops, duplicate code blocks for owned vs shared |
| `checkWorkspaceAccess()` | pub/workspaces.js | High | O(n) workspace scan for token auth, multi-strategy access check |
| GET `/*` handler | bitmaps.js | Medium | Path suffix detection, exact vs prefix routing, binary vs JSON response in one handler |
| POST `/` handler | documents.js | Medium | Top-level array vs object body, documentIds vs documents, client tag enforcement |
| `#onFileAdd()` / `#onFileUnlink()` | Workspace.js | Medium | Inline document creation/deletion during file events |

---

## 3. Cross-Cutting Issues

### 3.1 Critical Bugs

| # | File | Issue |
|---|------|-------|
| 1 | `index.js` GET `/:id` | Calls `workspaceManager.constructResourceAddress()` which **does not exist**. Will throw at runtime. |
| 2 | `settings.js` | Uses `ResponseObject.error()` and `ResponseObject.success()` as static methods, but they are **instance methods only**. Will throw `TypeError`. |
| 3 | `admin/workspaces.js` | Same `ResponseObject` static method bug as settings.js. |
| 4 | `settings.js` | **No authentication middleware** — `request.user.id` will be undefined for unauthenticated requests. |
| 5 | `settings.js` | Route param is `/:workspaceId/settings` under prefix `/:id`, yielding path `/:id/:workspaceId/settings` — double-nested workspace param. |

### 3.2 Architectural Issues

| # | Issue | Recommendation |
|---|-------|----------------|
| 1 | `getWorkspaceInstance()` duplicated 5× | Extract to shared middleware or utility |
| 2 | Workspace convenience methods (`insert`, `update`, `remove`, `delete`, `get`, `list`) unused | Either use them in routes (cleaner API) or remove them |
| 3 | No `updateToken()` on Workspace | Add it; PATCH token route currently does raw ACL manipulation |
| 4 | No share management methods on Workspace | Add `addShare()`, `removeShare()`, `updateShare()`, `listShares()` |
| 5 | services.js reads/writes files directly | Move config I/O to Workspace or a service manager method |
| 6 | Inconsistent auth patterns | Some routes use `authenticate`, some `authenticateClient`, some have no auth |
| 7 | Inconsistent ACL patterns | Some routes use `requireWorkspaceRead/Write/Admin`, many don't |
| 8 | `/open`+`/close` duplicate `/start`+`/stop` | Remove one pair |
| 9 | `constructResourceAddress` vs `constructWorkspaceReference` | Use the existing method or add the missing one |
| 10 | Settings routes duplicate PATCH `/:id` | Remove or consolidate |

### 3.3 Summary Statistics

- **Total routes across all files**: ~65 endpoints
- **Unique HTTP methods used**: GET, POST, PUT, PATCH, DELETE, OPTIONS, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK
- **Routes with business logic in handler**: ~25 (38%)
- **Workspace public methods unused from any route**: 12+
- **Duplicated helper functions**: 5+ copies of workspace resolution
- **Critical runtime bugs**: 5
