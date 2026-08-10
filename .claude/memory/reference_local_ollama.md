---
name: reference_local_ollama
description: Local Ollama host + models available for inferd Ollama provider / testing
metadata: 
  node_type: memory
  type: reference
  originSessionId: f9b3ed2f-caba-4917-8508-aa5803008189
---

Local Ollama daemon at `http://127.0.0.1:11434` (default `OLLAMA_HOST`). Embedding models pulled:
- `qwen3-embedding:0.6b`
- `nomic-embed-text`

Use for the [[project_embedd_service]] Ollama provider (`/api/embed`) — real text-embedding alt to the ONNX bge-small path. Note: dims differ from bge-small 384 (nomic=768, qwen3-embedding=1024) → would need its own vector space/table if used alongside bge, not a drop-in swap into the `text` (384) space.
