---
name: project-compound-query-design
description: "Compound queries IMPLEMENTED — OR/AND of refinement chains via POST /documents/search (agent-facing); UI exposes refine-only chips ('then'); relative image floor in refine stages"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2e1fb6db-442c-4f58-9bcb-0486661bec14
---

IMPLEMENTED 2026-07-13 (user direction: support both query types in the API, but the UI exposes ONLY refine — AND/OR set semantics would confuse most users; compound stays agent/API-facing). Tested live on synapsd0: chained `car→red` → 3 photos (red car first); compound AND `[car] ∩ [red]` → 5 docs with lines counts [5, 2378] (the naive-"red"-matches-everything problem, solved by intersection); OR fusion 0.25s.

**synapsd** (src/services/synapsd/src/index.js):
- `#imageVectorSearch(q, scope, depth, {relativeFloor})`: refine stages use scope-adaptive cutoff — keep photos within `best distance + 0.035` (env CANVAS_IMAGE_REFINE_MARGIN) instead of absolute imageMaxDistance (scope already established relevance; "red" over car photos peaks >0.945 yet reddest cars ARE the answer).
- `#foldQueryScope(texts, base)`: chained fold (stage i scoped to stage i-1 ids, Lance candidateIds pushdown); stage 1 absolute floor, later stages relative. Used by searchRefined + searchCompound.
- `#rankIds(scopedIds, query, options)`: extracted id-producing core of rank() (mode fallback + hybrid RRF), no doc hydration; accepts `imageRelativeFloor`. rank() hydrates on top.
- `searchCompound(lines, {op, baseSpec, limit, offset, mode})`: per line → fold all-but-last, then membership (full match set) + ranked head (FUSE_DEPTH=500) in parallel; lines combine via bitmap OR/AND; ranking = RRF across per-line ranked heads restricted to member set, unranked members trail in id order; returns `.lines = [{count}]` per-line totals.

**server**: `Workspace.searchCompound(lines, spec, options)` (canvas-composes base spec like searchRefined); `POST /workspaces/:id/documents/search` JSON body `{lines:[{queries,filters,features}], op:'or'|'and', scope, context..., limit, offset, mode}` (max 16 lines); ResponseObject gained opt-in `.lines` serialization (like `.debug`).

**web UI** (refine-only, no AND/OR): chip separator now "then" (chained semantics, was "AND"). Extended stacked refine (previously workspace page only) to: DocumentsTableWidget + useCanvasImages/ImageGridToolbar (gallery/mosaic, chips added) + context page (`serverSearchQueries: string[]`, repeated ?q= URL sync, toolbox saved-search stays first-term-only) + `getContextDocuments({queries})` + `WidgetFetchOpts.queries`.

Original design notes: two-level algebra (lines of chains, no nesting); per-line counts make empty AND intersections explainable; GET ?q=&q= stays for a single chain. fp32 image floor default 0.945 (matches 0.90–0.94, noise ≥0.95). See [[project-vector-query-timeout-rootcause]], [[project_embedd_service]].
