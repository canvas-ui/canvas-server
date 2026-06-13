# MVP Semantic Search for Plain-Text Documents (synapsd)

## Context

The MVP use-case is a large collection of markdown documents imported from wiki.js.
Users (and agents) need to retrieve by meaning, e.g. queries like `zscaler gateway IPs`
or "list all zscaler gw IPs" should surface the right notes even when wording differs.

Today synapsd has **no semantic retrieval**:
- `src/services/synapsd/src/semantic/index.js` — `SemanticEngine.recall()` is a stub that throws.
- `src/services/synapsd/src/indexes/lance/index.js` — `LanceIndex` stores only
  `{id, schema, updatedAt, fts_text}`. No vector column. (BM25 FTS was just upgraded to
  fuzzy multi-term — that work stays and becomes the lexical half of hybrid search.)
- `BaseDocument.js:162-176` already models `vectorEmbeddingFields`, `generateEmbeddingsData()`,
  and `embeddingOptions {model, dim, provider, chunking}` — scaffolding exists, unused.

This plan adds a **lightweight, async, hybrid (BM25 + dense vector, RRF-fused)** retrieval
layer. It is explicitly a *temporary MVP* — the later "semantic anchors / layered overlapping
semantic trees" effort and ColBERT multi-vector are deferred (see Future Phase).

### Decisions locked with the user
- **Retrieval**: hybrid = existing BM25 FTS + single dense vector per chunk, fused via
  LanceDB's native `RRFReranker`. (LanceDB *does* support multivector/MaxSim natively —
  https://docs.lancedb.com/search/multivector-search — but ColBERT/ColPaLi is deferred.)
- **Embedding runtime**: local ONNX, in-process, via **fastembed** (npm `fastembed@2.1.0`).
  Model `EmbeddingModel.BGESmallENV15` → **384-dim**, English, 512-token `maxLength`.
- **Execution**: dedicated **worker thread** (mirror `stored/src/sync/{SyncQueue,worker}.js`)
  + resume bitmap `internal/lance/vectors`; backfill on startup.
- **Tables**: single `vec_text` chunk-vector table now; `vec_image/audio/video` later.
- **Vector ownership**: server embeds *server-processable text* (JSON docs it can read:
  notes' `data.content`, readable text files). Non-JSON / media → the **app provides
  vectors** and the server stores them as-is; media with no provided vectors is skipped.
- **Model storage**: fastembed `cacheDir` points at a model store. A shared canvas-server
  store is source of truth; a workspace either references it or gets a copy (config-driven).

## Verified API facts (LanceDB 0.22.3 JS SDK)
- Vector indexes available: `Index.ivfPq / ivfFlat / hnswPq / hnswSq`.
- Query: `table.query().nearestTo(vec).fullTextSearch(text, cols).rerank(reranker)`.
- `RRFReranker` shipped at `@lancedb/lancedb/dist/rerankers/rrf.js`.
- fastembed `FlagEmbedding.init({ model, cacheDir, maxLength })`; `BGESmallENV15` = 384d.

## Implementation

### 1. Dependency + model store
- `src/services/synapsd/package.json`: add `"fastembed": "^2.1.0"`.
- Model store path resolution (config): shared store (e.g. `<server-data>/models/fastembed`)
  used as fastembed `cacheDir` by default; per-workspace override `<workspaceRoot>/lance/models`.
  Lead with the shared store to avoid an N×model-size footprint; copy-into-workspace is opt-in.

### 2. Embedder wrapper — `src/services/synapsd/src/semantic/Embedder.js` (new)
- Lazy-init `FlagEmbedding` with `{ model: BGESmallENV15, cacheDir, maxLength: 512 }`.
- `embedDocuments(texts: string[]) -> Float32Array[]` and `embedQuery(text)`.
- Expose `dim` (384) so the table schema and config stay in sync.

### 3. Chunking — `src/services/synapsd/src/utils/chunking.js` (new)
- Sentence-ish splitter honoring `embeddingOptions.chunking` (`{type:'sentence', chunkSize:1000,
  chunkOverlap:200}` from `BaseDocument.js:170-174`). Returns `[{chunkId, text}]`.

### 4. Vector table — extend `src/services/synapsd/src/indexes/lance/index.js`
  (or new sibling `VectorIndex.js` to keep FTS/vector concerns separate — preferred).
- Table `vec_text`, row `{ id (docId), chunkId, schema, updatedAt, chunkText, vector: float32[384] }`.
- `upsertChunks(docId, schema, chunks[])` — delete existing `id = docId` rows, add new.
- `deleteDoc(docId)` / `deleteMany(ids)`.
- `vectorSearch(queryVec, candidateIds, opts)` — `nearestTo`, post-filter to candidate bitmap.
- `hybridSearch(queryVec, queryText, candidateIds, opts)` —
  `nearestTo(vec).fullTextSearch(text).rerank(new RRFReranker())`; returns `{pageIds,totalCount}`.
- Create `Index.hnswSq` (or `ivfPq`) on `vector` once row-count warrants; brute-force is fine
  at MVP volumes. Reuse the FTS signature-file pattern to rebuild on config change.

### 5. Async embedding queue — `src/services/synapsd/src/semantic/{EmbeddingQueue,worker}.js` (new)
- Copy structure from `src/services/stored/src/sync/SyncQueue.js` + `worker.js` (worker_threads).
- Worker: receives `docId`s, reads doc from LMDB, runs Embedder + chunking, calls
  `upsertChunks`, then ticks `internal/lance/vectors` bitmap.
- Idempotent + resumable; skip docs already in the bitmap.

### 6. Wire into SynapsD — `src/services/synapsd/src/index.js`
- `initialize()` (near 205-211): construct Embedder, VectorIndex, EmbeddingQueue; after the
  FTS backfill add a **vector backfill** that enqueues docs missing from `internal/lance/vectors`.
- `putMany` Phase 3 (648-662) → add **Phase 3.5**: for each doc, if it carries precomputed
  `embeddings` (app-provided), upsert directly; else if the doc is server-processable text,
  enqueue `docId` for the worker. Media w/o vectors: skip.
- `put`/`#updateOne` (~1166, ~1673): re-enqueue on content change.
- `delete`/`deleteMany` (~1098, ~1822): also `VectorIndex.deleteDoc`.
- `search(spec)` (1507): add `spec.mode` (`'fts'` default | `'vector'` | `'hybrid'`); for
  vector/hybrid embed the query via `Embedder.embedQuery` and call the matching VectorIndex
  method. Candidate-bitmap filtering path is unchanged (reuse 1538-1594).

### 7. Implement recall — `src/services/synapsd/src/semantic/index.js`
- Replace the stub `recall(query, spec)` to delegate to `synapsd.search({query, mode:'hybrid', ...spec})`.
  Keep the "semantic anchor array" branch throwing `not implemented` (future phase).

### 8. Schema defaults — `src/schemas/BaseDocument.js:164-175`
- Change default `embeddingOptions` to the local model: `embeddingModel:'bge-small-en-v1.5'`,
  `embeddingDimensions:384`, `embeddingProvider:'local'`. Keep per-abstraction overrides.
- Allow a doc to carry `options.embeddings` (precomputed, app-provided) → surfaced to Phase 3.5.

### 9. Expose hybrid via API (no new routes needed)
- `routes/workspaces/documents.js:221` and `contexts/documents.js:78` already forward `spec`
  to `workspace.search`. Pass through an optional `mode` query param so clients can request
  hybrid/vector. Default stays `fts` (backward-compatible).

## Future Phase (documented, NOT in this MVP)
- ColBERT / ColPaLi multivector via LanceDB native MaxSim; bge-m3 (1024d, multilingual,
  unified dense+sparse+ColBERT) as the model — needs fastembed `InitCustomOptions` + ONNX,
  or transformers.js. Aligns with the "semantic anchors / layered overlapping semantic trees".
- Per-modality tables `vec_image` (CLIP), `vec_audio`, `vec_video`; `data/abstraction/file`
  routed by mime to the right model/table in the worker.

## Verification
1. `cd src/services/synapsd && npm install` then run a script that:
   - bulk-`putMany` a few hundred markdown notes,
   - waits for the worker to drain (poll `internal/lance/vectors` bitmap count),
   - `await db.search({query:'zscaler gateway IPs', mode:'hybrid'})` and assert the
     zscaler notes rank top; compare vs `mode:'fts'` to show semantic uplift.
2. Restart mid-backfill → confirm it resumes (bitmap skip), no duplicate chunk rows.
3. `putMany` a media/file doc with a precomputed `embeddings` payload → assert stored as-is,
   not re-embedded; a media doc without vectors → assert skipped (no worker error).
4. Unit tests: chunking (size/overlap), Embedder dim == 384, `deleteDoc` removes all chunk rows.
5. `npm test -- query-and-membership` still green (FTS path untouched).

## Notes
- After approval, record two memories: (a) LanceDB supports native multivector/MaxSim
  (ColBERT/ColPaLi) — corrects earlier assumption; (b) MVP semantic stack = fastembed
  BGESmallENV15 384d + LanceDB hybrid RRF, worker-thread async, `vec_text` table.
