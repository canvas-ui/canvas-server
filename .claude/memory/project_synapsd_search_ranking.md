---
name: project_synapsd_search_ranking
description: "synapsd FTS/hybrid search — ngram tokenizer, RRF fusion, reindex endpoints, drift fix"
metadata: 
  node_type: memory
  type: project
  originSessionId: 643053d2-ca5d-438c-ae33-c52199bf98c2
---

synapsd search/ranking overhaul (server v2.1.3→2.1.8, all live-verified on pre-prod canvas.idnc.sk universe ~2579 docs). Lance/BM25 + dense vectors.

**Tokenizer (`indexes/lance/index.js` `FTS_INDEX_CONFIG`):** switched `simple`→**`ngram`** (ngramMinLength 3, ngramMaxLength 4, prefixOnly false, stem false, withPosition false) for substring/camelCase recall — "ireland" now matches "JobsIreland". Config-signature mechanism (`#ensureFtsIndex`, FTS_CONFIG_SIGNATURE) auto-rebuilds the index over existing rows on next start when config changes (no manual reindex). `#buildFtsQuery`: with ngram, per-term MatchQuery uses **`Operator.And`** (fuzziness 0) so a term requires its FULL ngram set = true substring match (fixed "ireland"→991 over-match down to ~13). Word-tokenizer path keeps length-scaled fuzziness + Or.

**Hybrid fusion (`index.js` rank()):** default mode=hybrid was pure-vector (VectorIndex.hybridSearch only fused dense + chunk-BM25 over the vector table = embedded notes only → tabs invisible). FIXED: rank() hybrid branch now **RRF-merges doc-level `#lanceIndex.ftsQuery` (ALL docs incl tabs) with `#vectorIndex.vectorSearch` (dense)** via new `#rrfMerge(lists, k=60)`. **Weighted**: `{ids:fts, weight:2}` + `{ids:vec, weight:1}` — vector kNN has no similarity floor, so on a tiny embedded corpus a rank-0 irrelevant note-vector tied a rank-0 exact FTS hit and polluted the top; FTS 2× keeps exact matches on top, dense still adds recall. `#rrfMerge` accepts plain id arrays (weight 1) or `{ids,weight}`.

**Cosine distance floor (server v2.1.9→2.1.11):** dense side of vector/hybrid can over-contribute — kNN returns top-K regardless of absolute similarity. `VectorIndex.vectorSearch(vec, ids, {minDistance,maxDistance})` forces `.distanceType('cosine')` (index is hnswSq/L2 — query-time override, NO reindex needed) + native `.distanceRange()` (filters in-engine, pre-fusion). Threaded via rank() → parseSpec options (`minDistance`/`maxDistance`) → REST `?maxDistance=` querystring. synapsd default = NO floor (mechanism). **Workspace** sets policy: `Workspace.DEFAULT_MAX_COSINE_DISTANCE = 0.35` (=0.65 cosine similarity) injected in search/searchRefined when caller omits maxDistance; override with explicit param (2 = disable). KEY INSIGHT: near-empty/trivial notes ("test","testnote") embed near the CENTROID → ~0.40 cosine from ANY query → polluted results at the initial 0.65 default; genuinely-related notes sit ~0.27. 0.35 separates them. This is an INGESTION signature (empty content), not a search bug — RE-TUNE the 0.35 default once real corpora (Confluence/wikipedia/personal md) land; if substantive-but-loose notes cluster 0.35-0.45 nudge up. Consider exposing as `semantic.maxCosineDistance` config knob (env-settable) — not yet done.

**fts totalCount bug (`indexes/lance/index.js` ftsQuery):** unscoped branch fetched only `limit+offset` rows → totalCount==limit (whole-workspace search looked like a fixed candidate set). Fixed: both branches overfetch `(limit+offset)*10+1000` (scoped capped at candidateSet.size).

**Index drift + reindex (admin endpoints, `requireAdmin`, in-process, no LMDB lock):**
- `POST /rest/v2/admin/workspaces/:ws/reindex-search[?rebuild=true]` → `db.reindexSearchIndex({rebuild})`. Plain = incremental FTS backfill (loops `backfill(batchSize)`, idempotent via `internal/lance/fts` coverage bitmap). **rebuild=true** = `LanceIndex.clearFts()` (wipe table + reset bitmap) then full re-add — fixes DRIFT where the LMDB coverage bitmap over-claims (e.g. ftsRows 1061 vs indexedDocs 2579 after the Lance dir was rebuilt but bitmap persisted). start()'s backfill is capped (1000/run) → big tail stays unindexed; rebuild repairs it.
- `POST …/reindex-embeddings` → `db.reindexEmbeddings()` — ASYNC, enqueues embeddable docs missing vectors (mirrors start-resume #backfillVectors). `embeddableSchemas` default `['data/abstraction/note']` — **tabs/files NOT embedded** (so tab search is FTS-only; that's why hybrid fusion of doc-FTS matters).
- `POST …/reindex-features` (pre-existing).
No migrations on start (user req) — all reindex explicit/admin. Documented: synapsd README + top-level README "Admin maintenance"; server ping `/rest/v2/ping` shows version.
