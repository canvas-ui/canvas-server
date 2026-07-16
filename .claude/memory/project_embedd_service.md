---
name: project_embedd_service
description: New embedd service extracts all embedding from synapsd; synapsd becomes pure vector/bitmap/JSON store
metadata: 
  node_type: memory
  type: project
  originSessionId: f9b3ed2f-caba-4917-8508-aa5803008189
---

SHIPPED 2026-07-01 — committed + runtime-tested in pre-prod, works. (embedd 11/11, synapsd 73/73 model-free, real ONNX e2e verified: event→enqueue→resolveInput→router→ONNX→storeVectors→synapsd→injected embedQuery→hybrid search ranks correctly.)

Extracted ALL embedding into standalone service `src/services/embedd/` (unix-simple singleton, one model runtime shared across workspaces). synapsd demoted to pure vector/bitmap/JSON **store** + search algorithm — owns no model. Server-managed, OPTIONAL (disabled → store-only + FTS fallback); env.embedd toggles it (CANVAS_EMBEDD_ENABLED).

**Durable queue = synapsd bitmaps** (no separate store): `gap(space) = OR(candidateSchemas) AND-NOT seen(space)`. Two bitmaps/space: `presence` (has vectors, search/delete) + NEW `seen` (`internal/embed/seen/<space>`, processed incl. skips). storeDocumentEmbeddings ticks seen always, presence via VectorIndex when chunks>0. Content-update unticks seen (re-embed). embedd = stateless drainer: live events + manual `reconcile(wsId,{space,reindex})` endpoint (POST /admin .../reindex-embeddings). No contentType index → gap is schema-level, embedd post-filters contentType.

**Seams synapsd exposes** (never imports embedd): injected `semantic.embedQuery(text,space)` callback (search 1962), `storeDocumentEmbeddings(…,{space})`, `getUnembeddedDocIds(space,schemas)`, `clearSpace(space)`. These are also the canvas-edge extension point. Deleted from synapsd: Embedder.js/worker.js/EmbeddingQueue.js/chunking.js + #enqueueEmbeddable/#backfillVectors/drainEmbeddingQueue. Bonus: synapsd tests now model-free (no 130MB download → flaky timeout gone).

**Wiring**: Server #initializeCoreServices constructs Embedd singleton (onnxCacheDir=env.server.home/embedd/models) → WorkspaceManager (get embedd()) → Workspace (opts.embedd). Workspace injects embedQuery into Db, registers {resolveInput,storeVectors,getUnembedded,clearSpace}, subscribes document.inserted/updated → enqueue; unregister on stop. Server.stop() stops embedd.

Runtime: worker_thread now, process-ready (provider interface already isolates runtime; Ollama is out-of-process; containerized ONNX later = new provider). Original design decisions:

**Providers** (pluggable interface): ONNX (lift synapsd `semantic/Embedder.js`+`worker.js`, text bge-small 384 now, CLIP image later) + Ollama (HTTP `${OLLAMA_HOST}/api/embed`). Both first-class. Config-driven router: schema/contentType → space+provider+model (text→384, image→512/768).

**Reused seams**: `storeDocumentEmbeddings(docId,schema,updatedAt,chunks,{space})` (synapsd index.js:917, the "small gap" — expose on Workspace, make multi-space); `WorkspaceStoredIndex.resolve(url,{stream})` for bytes; events `document.inserted`/`object:add`.

**synapsd changes**: multi-space VectorIndex (per-space lance tables `vec_text`/`vec_image` + presence bitmaps); remove Embedder/EmbeddingQueue/semantic/worker + `#enqueueEmbeddable` (putMany:836/put:1519/update:2169); `chunkText` moves to embedd. Search query embedding (index.js:1920) becomes an injected `embedQuery(text,space)` callback (avoid threading vectors through QuerySession).

**Workspace wiring**: embedd singleton, `registerWorkspace(id,{resolveBytes,storeVectors,emitter})`; pass `embedQuery` into `new Db({...})`.

Only `stored://` (server-resident) bytes are embedded. See [[project_cli_add_vs_insert]] for how bytes land server-side. Builds on [[project_semantic_search_mvp]] and [[project_synapsd_search_ranking]].

Plan file: ~/.claude/plans/no-lets-discuss-it-abstract-eich.md

**UPDATE 2026-07-12**: user direction — replace the in-process ONNX/CLIP providers with a wrapped **EmbedAnything** (https://github.com/StarlightSearch/EmbedAnything, Rust/candle+ONNX, CLIP+text+batch+GPU) as a separate service, or default to an OpenAI-compat external provider (Ollama/vLLM/cloud); onnxruntime-node has no GPU and the fork-per-ORT-version + dtype/thread plumbing isn't worth owning. Slot it behind the existing provider contract (embedQuery/embedImage/embedText). Also: default CLIP dtype now fp32, embedd queue batches (CANVAS_EMBED_BATCH=8), reconcile fires on workspace start, RRF searchWeights tunable (fts2/dense1/image2, webui-exposed). See [[project-vector-query-timeout-rootcause]].

**Seen-ledger trap (from the email-indexing session):** once a doc is marked seen with 0 vectors it never backfills. After adding a router rule for a NEW schema, run `POST /admin/workspaces/:id/reindex-embeddings {space, reindex:true}` (clears space + seen ledger) or the new docs stay invisible to vector search forever.
