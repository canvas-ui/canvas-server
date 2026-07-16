---
name: feedback-dev-server
description: Local canvas-server dev process at 127.0.0.1:8001 — restart IS allowed (npm run dev); kill the full cross-env tree
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9ae0bacc-e12a-4d61-86ce-e1b04eef7fb8
---

UPDATED 2026-07-06: user explicitly authorized killing/restarting the local canvas-server dev process ("can be killed then started with npm run dev any time"). The old never-restart rule (2026-06-12) no longer applies.

**How to apply:** restart with `pkill -f 'node \./src/init\.js'` then `npm run dev` via Bash run_in_background (NOT `nohup ... &` — dies with the shell). Beware: a pkill pattern that appears in your own shell command string kills your own bash (exit 144). Kill the whole cross-env tree or the orphaned child holds 8001 (EADDRINUSE). Wait for `GET /rest/v2/ping` = 200 (can take ~30s; first embed job may also trigger a ~100s one-time ONNX model download).

Dev credentials (local only): admin@canvas.local, API token in user's message history; server http://127.0.0.1:8001.
