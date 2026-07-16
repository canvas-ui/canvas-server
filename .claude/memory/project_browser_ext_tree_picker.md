---
name: project_browser_ext_tree_picker
description: Browser extension workspace tree picker (Workspace>Tree>Path) — design + wiring
metadata: 
  node_type: memory
  type: project
  originSessionId: 643053d2-ca5d-438c-ae33-c52199bf98c2
---

Browser extension (extensions/browser-extensions) added workspace **tree selection** in v2.8.0. Addressing is Workspace > Tree > Path; a workspace has ≥2 trees (context, directory) + optional virtual trees. REST: `GET /workspaces/{ws}/trees` (list), `/workspaces/{ws}/trees/{treeNameOrId}` (structure), doc ops take `treeNameOrTreeId` query/body field.

**UX decision (final, v2.8.1):** NO in-popup picker — too much overhead for MVP. Tree preference lives **hidden in Settings > Sync** as a "Workspace tree" card: a global **Default tree** select (Context | Directory) + a **per-workspace overrides** list (one row/select per workspace, "Default" = use global). Popup stays clean. The earlier breadcrumb-chip approach (v2.8.0) was built then reverted.

Resolution is by **tree TYPE NAME** ('context'|'directory'), not tree id — every workspace has both default trees, and the API accepts the type name as `treeNameOrTreeId`. This sidesteps the non-unique-name gotcha (a workspace may have two trees both named `context`, see [[project_layerindex_naming]]) since we never need to disambiguate a specific tree id.

**Wiring (current):**
- api-client.js: `treeNameOrTreeId` threaded (default 'context') through getWorkspaceTree/Route, getWorkspaceDocuments (in options), insert/insertMany/remove/deleteWorkspaceDocuments, insertWorkspacePath. (No getWorkspaceTrees — removed.)
- browser-storage.js: NO WORKSPACE_TREE key. Sync settings hold `preferredTreeType:'context'` + `workspaceTreeOverrides:{}`. `getWorkspaceTreeRef(wsNameOrId?)` resolves: override[ws.id]||override[ws.name] → preferredTreeType → 'context'. Called with no arg at doc-op sites (resolves current workspace).
- service-worker.js: stored tree-type threaded into all explorer doc-op call sites via `await browserStorage.getWorkspaceTreeRef()`. Native context-menu builder still uses default 'context' (not threaded).
- sync-engine.js (v2.8.4): has its OWN apiClient calls + event filter — must be threaded separately (was the "directory sync broken" bug). All 6 workspace getWorkspaceDocuments/insertWorkspaceDocuments calls pass the tree ref; `isEventRelevant` also requires `event.treeName/treeId === treeRef` (server tree events carry treeId/treeName per synapsd events.js). WS subscription is `workspace:<id>` (workspace-scoped, not per-tree), so directory events already arrive.
- popup.js (v2.8.3): icon-click webui deep-link uses `/workspaces/:ws/trees/:tree/path/...` when treeRef!=='context' (mirrors webui buildWorkspaceUrl); treeRef comes from GET_CONNECTION_STATUS. Hidden paths (name startsWith '.') filtered in both tree renderers (v2.8.2).
- settings.js/html/css: "Workspace tree" card; `preferredTreeType` select + `renderTreeOverrides()` rows (keyed by ws.id); auto-saves via existing SET_SYNC_SETTINGS partial-merge path.

Deferred: sync-engine open/close reconciliation on tree change (only path switch reconciles today).
