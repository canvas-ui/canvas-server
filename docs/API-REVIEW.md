# API & Core Module Review

Comprehensive audit of REST/WebSocket transports vs Context/Workspace core modules.

---

## Part 1: Bugs (runtime crashes)

### Critical — will crash at runtime

| # | File | Bug |
|---|------|-----|
| 1 | `routes/contexts/lifecycle.js` | `PUT /:id` calls `contextManager.updateContext()` — **method does not exist** on ContextManager |
| 2 | `routes/contexts/rules.js` | `getContext(contextId, userId)` — **params swapped**, signature is `getContext(userId, contextId)` |
| 3 | `routes/contexts/rules.js` | `saveContext(context)` — **missing userId arg**, signature is `saveContext(userId, context)` |
| 4 | `routes/contexts/rules.js` | `ResponseObject.error()` called statically — **no static methods exist**, returns `undefined` |
| 5 | `routes/contexts/rules.js` | **No authentication middleware** — `request.user.id` will be undefined |
| 6 | `routes/contexts/documents.js` | `GET /by-hash/:algo/:hash` uses bare `response` variable (never instantiated) — `ReferenceError` |
| 7 | `routes/contexts/documents.js` | `DELETE /` uses bare `response` variable — `ReferenceError` |
| 8 | `routes/workspaces/settings.js` | `ResponseObject.error()` / `.success()` called statically — returns `undefined` |
| 9 | `routes/workspaces/settings.js` | **No authentication middleware** — `request.user.id` will be undefined |
| 10 | `routes/workspaces/settings.js` | Route yields `/:id/:workspaceId/settings` — double-nested param, `id` is ignored |
| 11 | `routes/workspaces/index.js` | `GET /:id` calls `workspaceManager.constructResourceAddress()` — **method does not exist** |
| 12 | `routes/admin/workspaces.js` | Same `ResponseObject` static method bug |
| 13 | `routes/admin/users.js` | Same `ResponseObject` static method bug |
| 14 | `routes/menu.js` | Same `ResponseObject` static method bug + `options.users` is never passed |
| 15 | `routes/auth.js` | Rate limiter calls `new ResponseObject().tooManyRequests()` — **method does not exist** |

### WebSocket Bugs

| # | Location | Bug |
|---|----------|-----|
| 16 | `websocket/index.js` + `channels/context.js` | 4 context events (`url.set`, `updated`, `locked`, `unlocked`) are relayed **twice** — once by direct listeners in index.js and again by the wildcard listener in context channel |
| 17 | `channels/workspace.js` | **Doesn't check socket subscription set** — events leak to any socket where user has access, even without subscribing |
| 18 | `websocket/index.js` | `lastActivity` set at connect time but **never updated** — all connections evicted after 30 min regardless of activity |

---

## Part 2: Dead & Duplicate Code

### Duplicate Routes (identical functionality)

| Route A | Route B | Action |
|---------|---------|--------|
| `POST /workspaces/:id/open` | `POST /workspaces/:id/start` | **Remove** `/open` and `/close` |
| `POST /workspaces/:id/close` | `POST /workspaces/:id/stop` | Same |
| `GET /contexts/:id/documents/by-id/:docId` | `GET /contexts/:id/documents/:docId` | **Remove** `/by-id/:docId` |
| `DELETE /contexts/:id/documents` | `POST /contexts/:id/documents/delete` | **Remove** `POST /delete` (legacy) |
| `POST /contexts/:id/documents` | `POST /contexts/:id/documents/batch` | **Remove** `/batch` |
| `admin/index.js` user CRUD | `admin/users.js` user CRUD | **Consolidate** into one |
| `workspaces/settings.js` | `PATCH /workspaces/:id` in index.js | **Remove** settings.js entirely |

### Duplicated Helper Code

| Pattern | Locations | Fix |
|---------|-----------|-----|
| `getWorkspaceInstance()` | `documents.js`, `tree.js`, `layers.js`, `bitmaps.js`, `lifecycle.js` (5 copies) | Extract to shared middleware |
| UUID regex for workspace ID | 8+ route files | Single utility or middleware |
| WebSocket broadcast block | `lifecycle.js` (4 handlers) | Extract helper or emit from core |
| `convertBasicAuthToBearer` | `dotfiles.js`, `webdav.js` | Shared auth utility |
| Owner permission check | `tokens.js` (5x), `shares.js` (4x) | Redundant — `requireWorkspaceAdmin` already checks |
| Token increment logic | `pub/workspaces.js` (4 handlers) | Middleware |
| Context array building | `Context.listDocuments()`, `Context.ftsQuery()` | Extract `buildContextSpec()` helper |
| Case-insensitive ID search | `ContextManager.getContext()`, `.removeContext()`, `.resolveContextIdFromSimpleIdentifier()` | Extract `findContextByIdCaseInsensitive()` |
| Event payload construction | 8 document methods on Context | Extract `buildEventPayload()` helper |

### Unused Core Methods (never called from any route)

**WorkspaceManager:**
- `hasWorkspace()`
- `createUniverseWorkspace()`
- `resolveWorkspaceIdFromReference()`
- `resolveWorkspaceIdFromSimpleIdentifier()` (only via address-resolver middleware)
- `parseWorkspaceReference()`
- `constructWorkspaceReference()`

**Workspace:**
- `stored` getter
- `directoryTree` getter
- `isServiceEnabled()`
- `setIcon()`, `setHomeScreen()`
- `insert()`, `update()`, `remove()`, `delete()`, `get()`, `list()` — 6 convenience CRUD wrappers that are completely unused; routes call `workspace.db.*` directly

**ContextManager:**
- `hasContext()`
- `resolveContextIdFromSimpleIdentifier()`
- `grantContextAccess()`, `revokeContextAccess()`
- `getAllContexts()`
- `getContextsForUser()`
- `getContextsForWorkspace()`

**Context:**
- `setBaseUrl()`, `lock()`, `unlock()`
- `setClientContextArray()`, `clearClientContextArray()`, `setServerContextArray()`, `clearServerContextArray()`
- `setFeatureBitmaps()`, `appendFeatureBitmaps()`, `removeFeatureBitmaps()`, `clearFeatureBitmaps()`
- `insertDocument()` (single), `updateDocument()` (single), `removeDocument()` (single)
- `getDocumentsByIdArray()`, `hasDocument()`, `hasDocumentByChecksum()`, `getDocumentByChecksum()`
- `grantAccess()`, `revokeAccess()` (old format — superseded by email-based methods)

### Other Dead Code

- `ResponseObject.js` — unused `crypto` import
- `strategies.js` — commented-out `firstName`/`lastName` fields in `register()`
- `index.js` — commented-out MCP plugin registration
- `index.js` — redundant JWT secret ternary (both branches return same value)

---

## Part 3: Architecture Issues

### Business Logic in Route Handlers

Routes should be thin — validate input, call core, return response. These violate that:

| Route File | Logic That Belongs in Core |
|------------|---------------------------|
| `contexts/tokens.js` | Token generation (crypto), SHA-256 hashing, ACL mutation, token data structure |
| `contexts/tree.js` | Every handler reaches through `context.workspace.tree.*` (Law of Demeter violation) |
| `contexts/documents.js` | `enforceClientTags()` feature array manipulation |
| `contexts/dotfiles.js` | Dotfile-to-document schema wrapping |
| `workspaces/shares.js` | Direct ACL object mutation + `updateWorkspaceConfig()` |
| `workspaces/tokens.js` | PATCH directly mutates `workspace.acl`, computes `isExpired` |
| `workspaces/services.js` | Direct filesystem I/O (`fs.readFile`/`fs.writeFile`) for service config |
| `pub/workspaces.js` | `checkWorkspaceAccess()` with O(n) workspace scan |
| `pub/contexts.js` | Hardcoded `data/abstraction/note` schema wrapping |

### Inconsistent Patterns

| Pattern | Inconsistency |
|---------|---------------|
| Auth middleware | Some routes use `authenticate`, some `authenticateClient`, some have none at all |
| ACL middleware | Some use `requireWorkspaceRead/Write/Admin`, many don't use ACL at all |
| `ResponseObject` usage | Some use `new ResponseObject().method()`, some call `ResponseObject.method()` statically |
| Error handling | Mix of `.error()`, `.serverError()`, and string-based error type detection |
| Workspace ID format | UUID regex vs 12-char check vs `resolveWorkspaceId()` — different heuristics in different files |
| Plugin options | Some routes get managers from `fastify.*` decorators, some from `options` arg |

### Performance Concerns

| Issue | Impact |
|-------|--------|
| `workspace-acl.js` calls `listWorkspaces()` for token/email ACL | O(n) scan of ALL workspaces per request |
| Token verification in `auth/service.js` iterates ALL users × ALL tokens | O(users × tokens) per API token auth |
| `pub/workspaces.js` `checkWorkspaceAccess()` calls `listWorkspaces()` | Same O(n) scan |
| `getAllContexts()` → `getContextsForUser()` filters post-fetch | Loads everything, filters in JS |

---

## Part 4: Simplification Plan

### Phase 1: Fix Crashing Bugs (immediate)

1. **Add `updateContext()` to ContextManager** — implement or wire to existing `saveContext()`
2. **Fix rules.js** — swap `getContext` params, add userId to `saveContext`, add auth middleware
3. **Fix ResponseObject static calls** — add static factory methods or fix call sites in settings.js, admin/workspaces.js, admin/users.js, menu.js, rules.js
4. **Fix documents.js** — instantiate `ResponseObject` in `by-hash` and `DELETE /` handlers
5. **Fix rate limiter** — add `tooManyRequests()` method to ResponseObject
6. **Add auth middleware to settings.js** — or better, remove settings.js entirely (see Phase 2)
7. **Fix duplicate context event delivery** — remove the 4 direct listeners in `transports/index.js`
8. **Fix workspace channel subscription check** — add `socket.subscriptions.has()` check like context channel

### Phase 2: Remove Dead Routes & Code

1. **Remove `/open` and `/close`** — aliases for `/start` and `/stop`
2. **Remove `settings.js`** — duplicates `PATCH /:id` in workspace index, has broken auth, broken ResponseObject usage
3. **Remove `GET /contexts/:id/documents/by-id/:docId`** — duplicate of `GET /:docId`
4. **Remove `POST /contexts/:id/documents/delete`** — legacy duplicate of `DELETE /`
5. **Remove `POST /contexts/:id/documents/batch`** — duplicate of `POST /`
6. **Consolidate admin user routes** — merge admin/index.js user CRUD with admin/users.js
7. **Remove unused Workspace convenience methods** — `insert()`, `update()`, `remove()`, `delete()`, `get()`, `list()` (routes use `workspace.db.*` directly, or better: start using these methods and remove direct db access)
8. **Remove unused Context methods** — old `grantAccess`/`revokeAccess`, single-doc variants if routes only use array variants
9. **Remove dead imports** — `crypto` in ResponseObject, commented-out code

### Phase 3: Extract Shared Middleware

1. **`getWorkspaceInstance` middleware** — replace 5 copies with a single `resolveWorkspace` preHandler that puts workspace on `request.workspace`
2. **ACL consistency** — apply `requireWorkspaceRead/Write/Admin` to ALL workspace sub-routes (tree, layers, bitmaps, services currently have none)
3. **Token increment middleware** — replace 4 copies in pub routes with a single preHandler
4. **Basic-to-Bearer auth conversion** — share between dotfiles.js and webdav.js

### Phase 4: Move Business Logic to Core

1. **Context tree operations** — add tree proxy methods to Context (`insertPath`, `removePath`, etc.) instead of `context.workspace.tree.*`
2. **Token management** — move crypto/hash/ACL logic from route handlers to `Context.createToken()`, `Context.deleteToken()`, `Workspace.updateToken()`
3. **Share management** — add `Workspace.addShare()`, `.removeShare()`, `.updateShare()`, `.listShares()`
4. **Service config I/O** — move filesystem read/write from services.js routes to WorkspaceManager or a ServiceManager
5. **`enforceClientTags`** — move to Context or a document service
6. **`checkWorkspaceAccess`/`checkContextAccess`** — refactor to use direct lookup instead of listing all resources

### Phase 5: API Design Improvements

1. **Use PATCH consistently for partial updates** — currently mix of PUT and PATCH
2. **Consistent plural resource naming** — already mostly good (`/documents`, `/tokens`, `/shares`)
3. **Remove action verbs from URLs** — `/start`, `/stop`, `/open`, `/close` could become `PATCH /:id/status` with `{ status: 'active' | 'inactive' }`, but pragmatically the current approach is fine for lifecycle operations
4. **Consistent error responses** — standardize on `new ResponseObject()` instance methods everywhere
5. **Add pagination metadata** — ensure all list endpoints return `count`/`totalCount` consistently
6. **Standardize query param naming** — `featureArray` vs `filterArray` naming is not self-documenting; consider `features` and `filters`
7. **Token-based auth should use index** — hash→token lookup instead of scanning all users/workspaces

### Summary: Impact vs Effort

| Phase | Impact | Effort | Priority |
|-------|--------|--------|----------|
| 1. Fix bugs | Critical | Low | **Now** |
| 2. Remove dead code | Medium | Low | **Now** |
| 3. Shared middleware | High | Medium | Next sprint |
| 4. Move logic to core | High | Medium-High | Next sprint |
| 5. API design | Low-Medium | Low | Ongoing |

**Estimated code reduction from Phase 2 alone: ~500-700 lines.**
**Estimated code reduction from Phase 3+4: ~800-1200 lines** (deduplication + extracted helpers).
