---
name: reference_lancedb_multivector
description: LanceDB supports native multivector/MaxSim (ColBERT/ColPaLi) search
metadata: 
  node_type: memory
  type: reference
  originSessionId: 6708128a-a0bf-4c24-a8b5-7b29e57893f8
---

LanceDB has **native multivector / MaxSim** search for late-interaction models (ColBERT, ColPaLi) — docs: https://docs.lancedb.com/search/multivector-search . Corrects an earlier wrong assumption that Lance had no first-class MaxSim.

JS SDK (`@lancedb/lancedb` 0.22.3) also exposes: vector indexes `Index.ivfPq/ivfFlat/hnswPq/hnswSq`; hybrid query `table.query().nearestTo(vec).fullTextSearch(text, cols).rerank(reranker)`; `RRFReranker` at `dist/rerankers/rrf.js`.

Relevant to the deferred ColBERT phase of [[project_semantic_search_mvp]].
