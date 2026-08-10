---
name: project-vector-query-timeout-rootcause
description: "Root causes of sporadic vector-search timeouts/no-results during bulk ingest (CLIP serialization, L2-metric ANN index bug, Lance fragmentation, no ONNX timeout)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2e1fb6db-442c-4f58-9bcb-0486661bec14
---

Investigated 2026-07-12 on test workspace synapsd0 (127.0.0.1:8001, ~2.1k docs / ~1k images). Four independent root causes:

1. **CLIP worker serialization** — one forked child serializes ALL inference (`chain = chain.then()` in canvas-inferd/src/providers/clip-worker.js). Every hybrid search calls `embedQuery(q,'image')` (synapsd index.js #imageVectorSearch), which queues behind in-flight image embeds. Measured during ingest (434 pending): spikes of 7.7–9.1s vs 0.2–0.4s baseline. Worst case hits clip.js 60s timeout → worker killed → all pending reject → cold model reload → thrash loop = "complete halt".
2. **ANN index metric bug (silent no-results)** — `VectorIndex.ensureVectorIndex()` builds `lancedb.Index.hnswSq()` with default **L2** metric, but the query path forces `distanceType('cosine')` + `distanceRange(0..0.97)`. With the index present, distances come back as L2² (~2−2cos; observed min 1.93), so the 0.97 floor excludes ALL photos. Triggered by admin optimize / reindex-embeddings (post-drain optimizeVectors). Fix: `hnswSq({ distanceType: 'cosine' })` + rebuild. NOTE: my test run built L2 indices on synapsd0 — image search there returns 0 until rebuilt.
3. **Lance fragmentation, no compaction during ingest** — per-doc delete+add = 2 versions/doc; optimize only runs from admin endpoints. Measured: vec_image 2017 fragments/4296 versions/241MB (data is ~6MB), documents.lance 2864/5828/366MB. Queries brute-force scan all fragments → linear slowdown. FTS optimize compacted 2136→1 fragment. Version prune removed 0 bytes (24h retention window).
4. **ONNX text worker has no request timeout** (`canvas-inferd/src/providers/onnx.js` ModelWorker) — a wedged worker leaves `embedQuery` promise unsettled forever → every search hangs with no log. All vector-path failures log via `debug()` only (invisible in normal logs).

Also confirmed: no chokidar debounce/batching; inferd queue drains strictly one doc per provider call (providers accept arrays — batching is free win). LMDB not the bottleneck.

**FIXED 2026-07-12 (working tree, uncommitted — user scripts manage commits):**
- (2) went deeper: even a COSINE quantized index (IVF_HNSW_SQ) is wrong for the image space — cross-modal text queries sit outside the image-vector distribution the scalar quantizer trains on, so ANN returned wrong ids at inflated distances (true 0.96 → ANN 1.49) and the 0.97 floor rejected everything. Image space is now pinned `annIndex:false` (exact scan; ensureVectorIndex auto-drops any stale index). Text space keeps HNSW, now cosine.
- clip-worker: separate text/image serialization lanes (distinct ORT sessions) — query embeds no longer wait behind ingest; measured 8-9s spikes → flat 0.2s during ingest.
- onnx.js: request timeout (CANVAS_INFERD_TIMEOUT_MS, default 120s) + exit-handler + lazy respawn.
- Auto-maintenance: Workspace optimizes (compact+prune+index) every 500 vector upserts (CANVAS_INFERD_OPTIMIZE_EVERY) and on inferd queue drain (gated ≥50 upserts; sequential across workspaces — parallel drain-optimize degraded live queries to 8-19s).
- Hybrid search degrades instead of failing when one leg errors; key vector/embed failures promoted from debug() to console.warn.
- Verified end-to-end on synapsd0: full 716-doc reconcile with queries flat ~0.2s throughout, both auto-optimize hooks fired, post-drain queries 0.09-0.65s, image results correct (dists 0.90-0.97).
- Lance version prune retention is 24h (CANVAS_LANCE_RETENTION_HOURS) — disk stays bloated (~400MB/table) until a day after churn; expected.
- User direction: inferd should eventually become a standalone service (not necessarily Node — onnxruntime-node has no GPU) or default to an OpenAI-compatible external provider (Ollama/vLLM/cloud). Architecture is ready (injected embedQuery, provider abstraction, OllamaProvider exists).
