# Context Transport Routes & Core Module Audit

## Table of Contents

1. [Route Files Audit](#route-files-audit)
2. [Core Module Audit](#core-module-audit)
3. [Additional Files](#additional-files)
4. [Cross-Cutting Issues](#cross-cutting-issues)

---

## Route Files Audit

### 1. `contexts/index.js` — Route Registration Hub

Registers all sub-route plugins with prefixes:

| Sub-plugin    | Prefix              | `onRequest` middleware       |
|---------------|----------------------|------------------------------|
| lifecycle     | `/`                  | *(none at plugin level)*     |
| documents     | `/:id/documents`     | `resolveContextAddress`      |
| dotfiles      | `/:id/dotfiles`      | `resolveContextAddress`      |
| tree          | `/:id/tree`          | `resolveContextAddress`      |
| tokens        | `/`                  | `resolveContextAddress`      |
| shares        | `/`                  | `resolveContextAddress`      |
| rules         | `/`                  | `resolveContextAddress`      |

**No business logic here — purely structural.** No issues.

---

### 2. `contexts/lifecycle.js` — Context CRUD

**PreHandler:** Validates `request.user` has `id` field via `validateUser`.

| # | Method   | Path             | Params / Body                                                                 | Core Method Called                              | Business Logic in Route? |
|---|----------|------------------|-------------------------------------------------------------------------------|-------------------------------------------------|--------------------------|
| 1 | `GET`    | `/`              | —                                                                             | `contextManager.listUserContexts(userId)`       | No                       |
| 2 | `POST`   | `/`              | Body: `{id, url?, baseUrl?, description?, workspaceId?, metadata?}`           | `contextManager.createContext(userId, url, opts)`| Minor: defaults `url` to `'/'`, builds options object |
| 3 | `GET`    | `/:id`           | Params: `id`                                                                 | `contextManager.getContext(userId, id)` + `context.toJSON()` + `contextManager.constructResourceAddress(context)` | **YES**: constructs `responsePayload` with `resourceAddress`, catches and ignores address construction errors |
| 4 | `GET`    | `/:id/url`       | Params: `id`                                                                 | `contextManager.getContext(userId, id)`          | No (just reads `context.url`) |
| 5 | `POST`   | `/:id/url`       | Params: `id`; Body: `{url}`                                                  | `context.setUrl(url)`                           | No                       |
| 6 | `GET`    | `/:id/path`      | Params: `id`                                                                 | `contextManager.getContext(userId, id)`          | No (just reads `context.path`) |
| 7 | `GET`    | `/:id/path-array`| Params: `id`                                                                 | `contextManager.getContext(userId, id)`          | No (just reads `context.pathArray`) |
| 8 | `PUT`    | `/:id`           | Params: `id`; Body: `{description?, metadata?, acl?, restApi?}`              | **`contextManager.updateContext(userId, id, body)`** | No                       |
| 9 | `DELETE` | `/:id`           | Params: `id`                                                                 | `contextManager.removeContext(userId, id)`       | No                       |

**Issues Found:**

- **BUG (Critical): `updateContext` does not exist.** Route #8 calls `fastify.contextManager.updateContext(userId, id, body)` but this method is **never defined** on `ContextManager`. This route will always throw a runtime error.
- Route #3 (`GET /:id`): Contains non-trivial business logic for resource address construction and error-message-based routing (`error.message.startsWith('Access denied')`, `error.message.includes('Invalid shared context identifier format')`). This string-matching error handling is fragile and should be moved to the core module.

---

### 3. `contexts/documents.js` — Document Operations

**PreHandler:** Validates `request.user` via `validateUser`.
**Helper function:** `enforceClientTags(request, featureArray)` — injects `client/device/id/` and `client/app/id/` tags. This is **route-layer business logic** that should be in the core module.

| #  | Method   | Path                              | Params / Body                                                     | Core Method Called                                            | Business Logic in Route? |
|----|----------|-----------------------------------|-------------------------------------------------------------------|---------------------------------------------------------------|--------------------------|
| 1  | `GET`    | `/`                               | Query: `featureArray, filterArray, includeServerContext, includeClientContext, limit, offset, page, q, search` | `context.listDocuments(...)` or `context.ftsQuery(...)` | **YES**: decides between FTS and list based on `q`/`search` query param |
| 2  | `POST`   | `/`                               | Body: `{documents, documentIds, featureArray}` or top-level array | `context.insertDocumentArray(userId, items, features)`        | **YES**: complex payload normalization (3 input formats), `enforceClientTags` |
| 3  | `POST`   | `/batch`                          | Body: `{documents[], featureArray}`                               | `context.insertDocumentArray(userId, docs, features)`         | **YES**: `enforceClientTags`, redundant array validation |
| 4  | `PUT`    | `/`                               | Body: `{documents[], documentIds, featureArray}`                  | `context.updateDocumentArray(userId, items, features)`        | **YES**: payload normalization (documents vs documentIds), `enforceClientTags` |
| 5  | `DELETE` | `/`                               | Body: `[docId, ...]`                                              | `context.deleteDocumentArrayFromDb(userId, ids)`              | Minor: normalizes to array |
| 6  | `DELETE` | `/remove`                         | Query: `featureArray`; Body: `[docId, ...]`                       | `context.removeDocumentArray(userId, ids, featureArray)`      | **YES**: checks `result.failed.length` vs `result.successful.length` to determine response type |
| 7  | `GET`    | `/by-id/:docId`                   | Params: `docId`                                                   | `context.getDocumentById(userId, docId)`                      | No |
| 8  | `GET`    | `/by-abstraction/:abstraction`    | Params: `abstraction`; Query: same as #1                          | `context.listDocuments(userId, derivedFeatureArray, ...)`     | **YES**: constructs `data/abstraction/${abstraction}` feature path |
| 9  | `GET`    | `/:docId`                         | Params: `docId`                                                   | `context.getDocumentById(userId, docId)`                      | No |
| 10 | `POST`   | `/delete`                         | Body: `[docId, ...]`                                              | `context.deleteDocumentArrayFromDb(userId, ids)`              | No (legacy endpoint) |
| 11 | `DELETE` | `/:docId`                         | Params: `docId`                                                   | `context.deleteDocumentFromDb(userId, documentId)`            | **YES**: `parseDocumentId()` validation in route |
| 12 | `GET`    | `/by-hash/:algo/:hash`            | Params: `algo, hash`                                              | `context.getDocumentByChecksumStringFromDb(userId, checksum)` | **YES**: constructs `algo/hash` string |

**Issues Found:**

- **BUG (Critical): Lines 783-786** — `by-hash` route uses bare `response` variable (never declared with `new ResponseObject()`). Will throw `ReferenceError` when document is not found or on success.
- **BUG:** Line 389 — `DELETE /` handler references bare `response.notFound(...)` instead of `new ResponseObject().notFound(...)`. Same `ReferenceError`.
- **Duplicate routes:** `GET /by-id/:docId` (#7) and `GET /:docId` (#9) are functionally identical — both call `context.getDocumentById` with the same logic.
- **Duplicate routes:** `DELETE /` (#5) and `POST /delete` (#10) do the same thing — `deleteDocumentArrayFromDb`. `POST /delete` is labeled "legacy" but both exist.
- `enforceClientTags` function is business logic living in the route layer.
- `POST /batch` (#3) is functionally identical to `POST /` (#2) when documents are provided (both call `insertDocumentArray`).

---

### 4. `contexts/tree.js` — Tree Operations

**PreHandler:** Validates `request.user` via `validateUser`.

| #  | Method   | Path                     | Params / Body                                            | Core Method Called                          | Business Logic in Route? |
|----|----------|--------------------------|----------------------------------------------------------|---------------------------------------------|--------------------------|
| 1  | `GET`    | `/`                      | —                                                        | `context.workspace.jsonTree`                | **YES**: accesses `context.workspace` directly, checks null |
| 2  | `POST`   | `/paths`                 | Body: `{path, autoCreateLayers?}`                        | `workspace.tree.insertPath(...)`            | **YES**: directly accesses `workspace.tree`, handles success heuristic |
| 3  | `DELETE` | `/paths`                 | Query: `{path, recursive?}`                              | `workspace.tree.removePath(...)`            | **YES**: directly accesses `workspace.tree` |
| 4  | `POST`   | `/paths/move`            | Body: `{from, to, recursive?}`                           | `workspace.tree.movePath(...)`              | **YES**: directly accesses `workspace.tree` |
| 5  | `POST`   | `/paths/copy`            | Body: `{from, to, recursive?}`                           | `workspace.tree.copyPath(...)`              | **YES**: directly accesses `workspace.tree` |
| 6  | `POST`   | `/paths/merge-up`        | Body: `{path}`                                           | `workspace.tree.mergeUp(...)`               | **YES**: directly accesses `workspace.tree` |
| 7  | `POST`   | `/paths/merge-down`      | Body: `{path}`                                           | `workspace.tree.mergeDown(...)`             | **YES**: directly accesses `workspace.tree` |
| 8  | `POST`   | `/paths/subtract-up`     | Body: `{path}`                                           | `workspace.tree.subtractUp(...)`            | **YES**: directly accesses `workspace.tree` |
| 9  | `POST`   | `/paths/subtract-down`   | Body: `{path}`                                           | `workspace.tree.subtractDown(...)`          | **YES**: directly accesses `workspace.tree` |
| 10 | `POST`   | `/layers/merge`          | Body: `{layerId, targetLayers[]}`                        | `workspace.tree.mergeLayer(...)`            | **YES**: directly accesses `workspace.tree` |
| 11 | `POST`   | `/layers/subtract`       | Body: `{layerId, targetLayers[]}`                        | `workspace.tree.subtractLayer(...)`         | **YES**: directly accesses `workspace.tree` |

**Issues Found:**

- **Massive Law of Demeter violation:** Every single route reaches through `context.workspace.tree.*` or `context.workspace.jsonTree`. Routes should call methods on `Context`, not drill into its internals. Context should expose tree operations.
- **Repetitive boilerplate:** Every handler has identical workspace null-check pattern (10+ times repeated).

---

### 5. `contexts/tokens.js` — Token Sharing

**No preHandler for authentication validation** (unlike lifecycle, documents, tree, dotfiles). Uses `fastify.authenticate` per-route.

| # | Method   | Path                         | Params / Body                                                                              | Core Method Called                          | Business Logic in Route? |
|---|----------|------------------------------|---------------------------------------------------------------------------------------------|---------------------------------------------|--------------------------|
| 1 | `POST`   | `/:contextId/tokens`         | Params: `contextId`; Body: `{permissions[], description?, expiresAt?, type?, maxUses?}`     | `context.updateACL(currentACL)`             | **YES (Critical)**: generates token with `crypto.randomBytes`, computes SHA-256 hash, builds token data structure, manually mutates ACL |
| 2 | `GET`    | `/:contextId/tokens`         | Params: `contextId`                                                                        | (reads `context.acl`)                       | **YES**: maps ACL tokens object to array, strips token values |
| 3 | `DELETE` | `/:contextId/tokens/:tokenHash` | Params: `contextId, tokenHash`                                                          | `context.updateACL(currentACL)`             | **YES**: manually deletes token from ACL, then saves |

**Issues Found:**

- **Heavy business logic in routes:** Token generation (crypto operations), ACL mutation, and token data structure construction all live in the route handler. All of this should be on `Context` or a dedicated TokenService.
- **Ownership check is duplicated:** `context.userId !== userId` check in every handler should be a reusable guard.
- Uses `serverError()` instead of `error()` on `ResponseObject` — inconsistent with other routes.

---

### 6. `contexts/shares.js` — Email-Based Sharing

| # | Method   | Path                        | Params / Body                                                    | Core Method Called                                          | Business Logic in Route? |
|---|----------|-----------------------------|------------------------------------------------------------------|--------------------------------------------------------------|--------------------------|
| 1 | `POST`   | `/:id/shares`               | Params: `id`; Body: `{userEmail, accessLevel, description?}`    | `context.grantAccessByEmail(email, level, opts)`             | **YES**: verifies user exists via `fastify.users.getByEmail()`, constructs response data with `grantedAt` timestamp |
| 2 | `GET`    | `/:id/shares`               | Params: `id`                                                    | (reads `context.acl.users`)                                 | **YES**: maps ACL users object to array |
| 3 | `DELETE` | `/:id/shares/:userEmail`    | Params: `id, userEmail`                                         | `context.revokeAccessByEmail(userEmail)`                     | Minor: checks existence before revoking |
| 4 | `PUT`    | `/:id/shares/:userEmail`    | Params: `id, userEmail`; Body: `{accessLevel, description?}`   | `context.updateAccessByEmail(email, level, opts)`            | Minor: constructs response data |

**Issues Found:**

- **User lookup in route:** `POST` handler calls `fastify.users.getByEmail()` to verify user exists — but `context.grantAccessByEmail()` also does this lookup internally. **Duplicate lookup.**
- Ownership check (`context.userId !== userId`) is duplicated in every handler.
- Uses `serverError()` — inconsistent with other routes that use `error()`.

---

### 7. `contexts/dotfiles.js` — Dotfile Documents

**PreHandler:** Validates `request.user` via `validateUser`.

| # | Method   | Path | Params / Body                                     | Core Method Called                                          | Business Logic in Route? |
|---|----------|------|----------------------------------------------------|--------------------------------------------------------------|--------------------------|
| 1 | `GET`    | `/`  | Query: `featureArray, filterArray, include*, pagination` | `context.listDocuments(userId, derivedFeatureArray, ...)`  | **YES**: prepends `'data/abstraction/dotfile'` to featureArray |
| 2 | `POST`   | `/`  | Body: `{dotfiles (object or array), featureArray?}` | `context.insertDocumentArray(userId, documentArray, features)` | **YES**: wraps each dotfile in `{schema: 'data/abstraction/dotfile', data: df}`, prepends dotfile feature |
| 3 | `PUT`    | `/`  | Body: `{documents[], featureArray?}`                | `context.updateDocumentArray(userId, docs, features)`       | **YES**: prepends dotfile feature |
| 4 | `DELETE` | `/`  | Body: `[docId, ...]`                                | `context.deleteDocumentArrayFromDb(userId, docIds)`         | No |

**Issues Found:**

- **Abstraction-specific logic in route:** The dotfile-specific feature tag (`data/abstraction/dotfile`) and schema wrapping should be in a dedicated core method or the existing `by-abstraction` pattern. This is essentially a specialized view of documents.

---

### 8. `contexts/rules.js` — Context Rules

| # | Method   | Path                           | Params / Body                                     | Core Method Called                                        | Business Logic in Route? |
|---|----------|--------------------------------|----------------------------------------------------|-----------------------------------------------------------|--------------------------|
| 1 | `GET`    | `/:contextId/rules`            | Params: `contextId`                                | `context.rules`                                           | No |
| 2 | `POST`   | `/:contextId/rules`            | Params: `contextId`; Body: `{type, criteria, description?}` | `context.addRule(rule)` + `contextManager.saveContext(context)` | **YES**: generates rule ID with `Date.now()` + random, constructs rule object |
| 3 | `PUT`    | `/:contextId/rules/:ruleId`    | Params: `contextId, ruleId`; Body: `{type?, criteria?, description?}` | `context.removeRule(ruleId)` + `context.addRule(updatedRule)` + `contextManager.saveContext(context)` | **YES**: finds rule by index, merges update, remove+add pattern |
| 4 | `DELETE` | `/:contextId/rules/:ruleId`    | Params: `contextId, ruleId`                        | `context.removeRule(ruleId)` + `contextManager.saveContext(context)` | No |

**Issues Found:**

- **BUG (Critical): Swapped parameter order.** Uses `contextManager.getContext(contextId, userId)` — parameters are reversed compared to the actual signature `getContext(userId, contextId)`. This will fail or return wrong results.
- **BUG (Critical): `ResponseObject` used as static calls.** `ResponseObject.error(...)` and `ResponseObject.success(...)` are called statically but ResponseObject has no static methods. Every handler will throw `TypeError`.
- **BUG: `contextManager` sourced from `options`.** Uses `const { contextManager } = options;` instead of `fastify.contextManager`. If the plugin is registered without passing `contextManager` in options, it will be `undefined`.
- **BUG: `saveContext` called with wrong signature.** Routes call `contextManager.saveContext(context)` with 1 arg, but `ContextManager.saveContext(userId, context)` requires 2 args.
- **No authentication hook.** Unlike all other route files, there's no `fastify.authenticate` or `preHandler` validation.
- Rule ID generation (`Date.now() + random`) should be in the core module, not the route.

---

## Core Module Audit

### `ContextManager` (src/core/context/index.js)

#### Public Methods

| Method | Signature | Called From Routes? | Notes |
|--------|-----------|---------------------|-------|
| `initialize()` | `() => Promise<ContextManager>` | Not from routes (server startup) | |
| `contexts` (getter) | `=> Array<Context>` | Not from routes | Returns all in-memory contexts |
| `createContext` | `(userId, url, options) => Promise<Context>` | lifecycle.js `POST /` | |
| `getContext` | `(userId, contextId, options?) => Promise<Context>` | **Everywhere** — lifecycle, documents, tree, tokens, shares, dotfiles, rules, pub, webdav | Most-used method |
| `hasContext` | `(userId, contextId) => boolean` | **Not called from any route** | |
| `findContextById` | `(contextId) => Promise<Object\|null>` | pub/contexts.js | Cross-user lookup |
| `listUserContexts` | `(userId) => Promise<Array>` | lifecycle.js `GET /` | |
| `removeContext` | `(userId, contextId) => Promise<boolean>` | lifecycle.js `DELETE /:id` | |
| `saveContext` | `(userId, context) => void` | rules.js (but with wrong signature) | Also called internally by Context methods |
| `resolveContextIdFromSimpleIdentifier` | `(identifier) => Promise<string\|null>` | **Not called from any route** | |
| `constructResourceAddress` | `(context) => Promise<string\|null>` | lifecycle.js `GET /:id` | |
| `grantContextAccess` | `(requestingUserId, targetContext, sharedWith, level) => Promise<boolean>` | **Not called from any route** | |
| `revokeContextAccess` | `(requestingUserId, targetContext, sharedWith) => Promise<boolean>` | **Not called from any route** | |
| `getAllContexts` | `() => Array<Object>` | **Not called from any route** (used by `findContextByTokenHash`) | |
| `getContextsForUser` | `(userId) => Array<Object>` | **Not called from any route** | |
| `getContextsForWorkspace` | `(workspaceId) => Array<Object>` | **Not called from any route** | |
| `findContextByTokenHash` | `(tokenHash) => Object\|null` | **Not called from any route** (likely used by auth middleware) | |

#### Missing Methods

| Method | Called From | Status |
|--------|------------|--------|
| **`updateContext(userId, contextId, body)`** | lifecycle.js `PUT /:id` | **MISSING — will crash at runtime** |

#### Unused Methods (from routes perspective)

- `hasContext`
- `resolveContextIdFromSimpleIdentifier`
- `grantContextAccess` / `revokeContextAccess` — shares.js calls `context.grantAccessByEmail()` directly instead
- `getAllContexts`
- `getContextsForUser`
- `getContextsForWorkspace`
- `findContextByTokenHash`

#### Complexity Concerns

- **`getContext`** (~125 lines): Overly complex. Does backward-compat case-insensitive search (3 nested loops across memory + store), shared context fallback search, workspace resolution, context hydration, auto-create logic, and permission checking. Should be decomposed.
- **`listUserContexts`** (~70 lines): Iterates in-memory cache + persistent store with duplicate processing guard. Fetches owner email for every context. Could be simplified.
- **`removeContext`** (~65 lines): Has the same backward-compat case-insensitive search pattern as `getContext`. Duplicate logic.

#### Duplicate Logic

1. **Case-insensitive ID search**: The same loop pattern (search in-memory cache, then persistent store, matching by lowercased ID) is duplicated in `getContext`, `removeContext`, and `resolveContextIdFromSimpleIdentifier`.
2. **Workspace resolution**: Both `createContext` and `getContext` have similar workspace ID resolution logic (checking for `:` or short IDs).
3. **`getAllContexts` / `listUserContexts`**: Both iterate the same stores with similar patterns. `getContextsForUser` delegates to `getAllContexts` then filters — inefficient.

---

### `Context` (src/core/context/lib/Context.js)

#### Public Methods

| Method | Called From Routes? | Notes |
|--------|---------------------|-------|
| **Getters** | | |
| `id`, `scope`, `isUniverse`, `userId`, `baseUrl`, `url`, `path`, `pathArray` | lifecycle.js | |
| `workspace` | tree.js (every handler!) | Exposes internal workspace reference |
| `workspaceId`, `workspaceName`, `tree`, `color`, `pendingUrl` | lifecycle.js / tree.js | |
| `bitmapArrays`, `acl`, `serverContextArray`, `clientContextArray` | tokens.js, shares.js | |
| `contextBitmapArray`, `featureBitmapArray`, `filterArray` | Not directly from routes | |
| `rules` | rules.js | |
| **URL/Navigation** | | |
| `setUrl(url)` | lifecycle.js `POST /:id/url` | |
| `setBaseUrl(newBaseUrl)` | **Not called from routes** | |
| `lock()` / `unlock()` | **Not called from routes** | |
| `destroy()` | Called by `ContextManager.removeContext` | |
| `initialize()` | Called by ContextManager | |
| **ACL** | | |
| `grantAccess(userId, level)` | Called by `ContextManager.grantContextAccess` (unused from routes) | Old format |
| `revokeAccess(userId)` | Called by `ContextManager.revokeContextAccess` (unused from routes) | Old format |
| `grantAccessByEmail(email, level, opts)` | shares.js `POST /:id/shares`, ContextManager.grantContextAccess | New format |
| `revokeAccessByEmail(email)` | shares.js `DELETE /:id/shares/:userEmail` | |
| `updateAccessByEmail(email, level, opts)` | shares.js `PUT /:id/shares/:userEmail` | |
| `updateACL(newACL)` | tokens.js (create/revoke), pub/contexts.js | Full ACL replacement |
| `checkPermission(userId, level)` | Called internally + by ContextManager | |
| **Context Arrays** | | |
| `setClientContextArray(arr)` | **Not called from routes** | |
| `clearClientContextArray()` | **Not called from routes** | |
| `setServerContextArray(arr)` | **Not called from routes** | |
| `clearServerContextArray()` | **Not called from routes** | |
| **Bitmaps** | | |
| `setFeatureBitmaps(arr)` | **Not called from routes** | |
| `appendFeatureBitmaps(arr)` | **Not called from routes** | |
| `removeFeatureBitmaps(arr)` | **Not called from routes** | |
| `clearFeatureBitmaps()` | **Not called from routes** | |
| **Rules** | | |
| `addRule(rule)` | rules.js | |
| `removeRule(ruleId)` | rules.js | |
| **Documents** | | |
| `insertDocument(userId, doc, features, opts)` | **Not called from routes** | Single doc insert |
| `insertDocumentArray(userId, docs, features, opts)` | documents.js, dotfiles.js, pub/contexts.js | |
| `getDocumentById(userId, id, opts)` | documents.js (2 routes) | |
| `getDocumentsByIdArray(userId, ids, opts)` | **Not called from routes** | |
| `hasDocument(userId, id, features)` | **Not called from routes** | |
| `hasDocumentByChecksum(userId, checksum, features)` | **Not called from routes** | |
| `listDocuments(userId, features, filters, opts)` | documents.js, dotfiles.js, pub/contexts.js | |
| `ftsQuery(userId, query, features, filters, opts)` | documents.js | |
| `updateDocument(userId, doc, features, opts)` | **Not called from routes** | Single doc update |
| `updateDocumentArray(userId, docs, features, opts)` | documents.js, dotfiles.js, pub/contexts.js | |
| `removeDocument(userId, docId, features, opts)` | **Not called from routes** | |
| `removeDocumentArray(userId, docIds, features, opts)` | documents.js `DELETE /remove` | |
| `deleteDocumentFromDb(userId, docId)` | documents.js `DELETE /:docId` | |
| `deleteDocumentArrayFromDb(userId, docIds, opts)` | documents.js (`DELETE /`, `POST /delete`), dotfiles.js | |
| `getDocumentByChecksum(userId, checksum, features)` | **Not called from routes** | Contextualized checksum lookup |
| `getDocumentByChecksumStringFromDb(userId, checksum)` | documents.js `GET /by-hash/:algo/:hash` | Direct DB checksum lookup |
| `toJSON()` | Everywhere | Serialization |

#### Unused Methods (from routes perspective)

- `setBaseUrl`, `lock`, `unlock`
- `setClientContextArray`, `clearClientContextArray`, `setServerContextArray`, `clearServerContextArray`
- `setFeatureBitmaps`, `appendFeatureBitmaps`, `removeFeatureBitmaps`, `clearFeatureBitmaps`
- `insertDocument` (single doc)
- `getDocumentsByIdArray`
- `hasDocument`, `hasDocumentByChecksum`
- `updateDocument` (single doc)
- `removeDocument` (single doc)
- `getDocumentByChecksum`
- `grantAccess`, `revokeAccess` (old format — routes use email-based methods)

#### Duplicate Logic

1. **Context array building in `listDocuments` and `ftsQuery`**: Lines 1016-1033 and 1050-1066 are nearly identical — both build `contextArray` from `baseContexts + serverContexts + clientContexts` and convert to contextSpec. Should be extracted to a shared helper.
2. **`insertDocument` vs `insertDocumentArray`**: Build contextSpec identically (lines 835-839 vs 888-893), duplicated pattern.
3. **`updateDocument` vs `updateDocumentArray`**: Same contextSpec building pattern duplicated.
4. **Event payload construction**: Almost identical event payload objects across `insertDocument`, `insertDocumentArray`, `updateDocument`, `updateDocumentArray`, `removeDocument`, `removeDocumentArray`, `deleteDocumentFromDb`, `deleteDocumentArrayFromDb` — 8 variations of the same pattern.

#### Complexity Concerns

- **`insertDocumentArray`** (lines 875-949): 75 lines, with complex result format detection logic (5 branches for different DB result formats).
- **Constructor** (lines 66-179): 113 lines of URL parsing and validation logic. Very long.
- **`checkPermission`** (lines 463-538): 75 lines, verbose with many debug logs. Permission hierarchy is defined but partially unused.

---

### `Url` (src/core/context/lib/Url.js)

Small, focused URL parser class. No major issues.

- Provides: `raw`, `url`, `workspaceName`/`workspaceId`, `path`, `pathArray`, `isValid`
- Static: `validate(url)`
- Instance: `setUrl(url)`, `cleanUrl(url)`, `cleanPath(path)`, `formatUrl()`, `parseWorkspace(url)`, `parsePath(url)`

---

## Additional Files

### `pub/contexts.js` — Public Token/User-Based Access

| # | Method | Path                          | Core Method Called                                                 | Business Logic in Route? |
|---|--------|-------------------------------|--------------------------------------------------------------------|--------------------------|
| 1 | `GET`  | `/:contextId`                 | `contextManager.findContextById()`, `contextManager.getContext()`, `context.toJSON()` | **YES**: `checkContextAccess` helper (token + user ACL check), `incrementTokenUsage` |
| 2 | `GET`  | `/:contextId/documents`       | `context.listDocuments()`                                          | **YES**: same access check + token usage |
| 3 | `POST` | `/:contextId/documents`       | `context.insertDocumentArray()`                                    | **YES**: wraps docs in `{schema: 'data/abstraction/note', data: doc}`, access check |
| 4 | `PUT`  | `/:contextId/documents`       | `context.updateDocumentArray()`                                    | **YES**: access check, validation |

**Issues:**

- **Hardcoded schema** in `POST`: wraps all docs as `data/abstraction/note`. This is business logic that shouldn't be in the route.
- `checkContextAccess` helper is complex (~55 lines) and handles both token and user-based auth with fallback. This should be middleware or a service.

### `context-webdav.js` — WebDAV Access

- Registers `OPTIONS`, `GET`, `HEAD`, `PROPFIND` on `/contexts/:context/dav` and `/contexts/:context/dav/*`
- Custom auth handler (supports Basic + Bearer)
- Uses `contextManager.getContext()` for auth
- Delegates to `VirtualNamedContextFS` for filesystem abstraction
- **No issues specific to the context audit**, but the auth logic is duplicated from the main auth system.

---

## Cross-Cutting Issues

### 1. Critical Bugs

| # | File | Bug |
|---|------|-----|
| 1 | `lifecycle.js` | `updateContext()` called but never defined on ContextManager |
| 2 | `rules.js` | `contextManager.getContext(contextId, userId)` — parameters swapped |
| 3 | `rules.js` | `ResponseObject.error()` / `.success()` called statically — no static methods exist |
| 4 | `rules.js` | `contextManager.saveContext(context)` — missing required `userId` first argument |
| 5 | `rules.js` | No authentication middleware attached |
| 6 | `documents.js` | `GET /by-hash` uses undefined `response` variable on lines 782-786 |
| 7 | `documents.js` | `DELETE /` uses undefined `response` variable on line 389 |

### 2. Architectural Issues

| # | Issue | Severity |
|---|-------|----------|
| 1 | **Tree routes bypass Context entirely** — every tree route reaches through `context.workspace.tree.*` violating encapsulation | High |
| 2 | **Token management is entirely in routes** — crypto, hashing, ACL mutation all in `tokens.js` | High |
| 3 | **`enforceClientTags` lives in route layer** — business logic for tag injection | Medium |
| 4 | **Duplicate user lookup** in `shares.js` POST (route checks, then `grantAccessByEmail` checks again) | Low |
| 5 | **Inconsistent ResponseObject usage** — some routes use `.error()`, some `.serverError()` | Low |
| 6 | **String-based error type detection** — `error.message.startsWith('Access denied')` appears in many routes | Medium |

### 3. Duplicate Routes

| Route A | Route B | Difference |
|---------|---------|------------|
| `GET /by-id/:docId` | `GET /:docId` | None — identical logic |
| `DELETE /` | `POST /delete` | HTTP method only — both call `deleteDocumentArrayFromDb` |
| `POST /` | `POST /batch` | /batch requires `documents` in body; `/` accepts 3 formats. Both call `insertDocumentArray` |

### 4. Methods Never Called From Routes

**ContextManager:** `hasContext`, `resolveContextIdFromSimpleIdentifier`, `grantContextAccess`, `revokeContextAccess`, `getAllContexts`, `getContextsForUser`, `getContextsForWorkspace`, `findContextByTokenHash`

**Context:** `setBaseUrl`, `lock`, `unlock`, `insertDocument`, `getDocumentsByIdArray`, `hasDocument`, `hasDocumentByChecksum`, `updateDocument`, `removeDocument`, `getDocumentByChecksum`, `grantAccess`, `revokeAccess`, all context-array setters, all feature-bitmap setters

Note: Some of these may be called from non-route code (WebSocket handlers, internal services, etc.).
