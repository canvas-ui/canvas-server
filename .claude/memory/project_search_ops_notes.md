---
name: project-search-ops-notes
description: "Search/index maintenance facts: per-modality admin ops, listBitmaps trailing-slash gotcha, unbounded bitmap cache, perf-bench principle (condensed 2026-07-16)"
metadata:
  type: project
---

Condensed from the 2026-07-11 search debugging journal (fixes are in code; these are the durable operational facts):

- **Admin maintenance is per-modality**: `POST /admin/workspaces/:id/optimize {space}` (fts/text/image), `reindex-embeddings {space, reindex}`, `reindex-search[?rebuild=true]`, `reindex-mime`. Settings > Index maintenance groups Backfill/Re-embed/Optimize per modality. Reindex-embeddings auto-optimizes after drain.
- **`listBitmaps(prefix)` gotcha**: a trailing slash used to build a `prefix//...` range matching NOTHING - now stripped generically, but remember key ranges are string-prefix based.
- **BitmapIndex cache is an unbounded Map** - every bitmap ever touched stays resident. Fine at KB sizes, unmeasured at wikipedia scale (user aware, no cap implemented).
- **Perf work principle (user)**: "exact numbers and a precise deterministic setup" - when the perf deep-dive happens, build a deterministic synapsd bench harness (fixed corpus/queries, warm/cold split, p50/p95/p99) run over curl against standalone synapsd. No hand-wavy timings. Hypothesis: occasional slow queries are server/UI-Lance interplay, not Lance (user saw ms queries over 1M+ files standalone).
- Dev StrictMode double-invokes fetch effects - "4 Lance _distance warnings per search" is 2 searches x 2 scans, not a bug.

Related: [[project_synapsd_search_ranking]], [[project_image_clip_search]], [[project_vector_query_timeout_rootcause]]
