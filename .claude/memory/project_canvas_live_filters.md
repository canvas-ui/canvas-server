---
name: project_canvas_live_filters
description: "Canvas live filter preview: toolbox edits reload canvas widgets in real time via applyCanvasSpec=false bypass of server-side querySpec folding"
metadata: 
  node_type: memory
  type: project
  originSessionId: e81ed646-504f-418f-956a-3ff78e7246fd
---

On a canvas, editing toolbox filters now reloads the widgets in real time (2026-07; server restart needed). Save persists (existing toolbox `saveFilters` → canvas querySpec, "Save canvas" btn in DefaultCanvas canvas-header when `canSaveChanges`); Clear reverts (existing ToolsPanel).

**Why it needed a server change:** any read of a canvas PATH auto-folds the canvas leaf's STORED querySpec via `Workspace.#composeCanvasQuerySpec` (called by list/search/searchRefined/searchCompound) — `#composeCanvasFeatures` AND-composes request features with stored, so ADDING a filter previewed but REMOVING a saved one never did (server re-added it). Request `sortBy` already overrode stored sort; features/filters/query did not.

**Bypass:** new query param `applyCanvasSpec` (bool, default true) on `GET /workspaces/:id/documents`. Route sets `spec.applyCanvasQuerySpec`; `#composeCanvasQuerySpec` early-returns (skips folding) when `=== false`. Then the CLIENT fully drives filters.

**Client wiring (`pages/workspaces/[workspaceName]/index.tsx`):** `canvasFetchDocuments` (useCallback, deps `tbFiltersKey`+`serverSearchQueries`) calls `getCanvasPathDocuments(..., { allOf:[...tbAllOf, ...opts.allOf], anyOf, noneOf, filters:tbScopeFilters, queries:[...serverSearchQueries, ...opts.queries, opts.q], applyCanvasSpec:false })`. MUST merge the widget's fixed `opts.allOf` (e.g. GalleryWidget `data/mime/image`) with the toolbox `allOf`, and include `serverSearchQueries` to preserve the canvas's saved query (since folding is bypassed). Passed to CanvasGrid as `fetchDocuments={toolboxState.isDirty ? canvasFetchDocuments : undefined}` — **only when dirty**, so a clean/saved canvas keeps the default server-composed read (unchanged/battle-tested). Toolbox fully models the canvas querySpec (features + timeline; geo is client-side ephemeral now → dropped from saved canvases, rare), so dirty-at-baseline == clean.

**Re-render chain:** dirty flip / filter edit → new `canvasFetchDocuments` identity → CanvasGrid `canvas` useMemo (deps incl. fetchDocuments) → widget fetch effect (`[canvas, ...]`, e.g. DocumentsTableWidget:52) re-runs → re-fetch. `client/services/workspace.ts` `getWorkspaceDocuments`+`getCanvasPathDocuments` gained `applyCanvasSpec?:boolean`.

Related: [[project_toolbox_experimental]] (folder view already live-fetches with tb* filters; canvas was the frozen surface). Canvas querySpec dims: features/filters(timeline+geo tokens)/query/sort.
