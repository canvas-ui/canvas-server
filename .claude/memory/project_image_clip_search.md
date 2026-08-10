---
name: project_image_clip_search
description: "CLIP/SigLIP image search - ORT version isolation (forked child), deploy/lockfile discipline (condensed 2026-07-16)"
metadata:
  type: project
---

Natural-language photo search via SigLIP joint image+text space (768-d `vec_image`, RRF-fused into rank()). Works in prod. Condensed from the 2026-07 build/deploy journal.

**Hard constraints (do not violate):**
- transformers.js pins onnxruntime-node 1.24.3; fastembed pins 1.21.0. Two native ORT versions CANNOT share one process (same soname). SigLIP runs in a `fork()`ed child (`canvas-inferd/src/providers/clip-worker.js`); `clip.js` is the IPC client (timeout CANVAS_CLIP_TIMEOUT_MS, respawn on exit, separate text/image serialization lanes so query embeds never queue behind ingest). DO NOT load transformers.js in-process.
- `onnxruntime-node: "1.21.0"` MUST stay a direct root dependency - it forces 1.21.0 to root node_modules (main process/fastembed), keeping transformers' 1.24.3 nested for the child only. npm's hoist choice is otherwise unstable.
- Root `package-lock.json` is TRACKED (was gitignored - root cause of all the "works here, broken on deploy" churn). Deploy uses `npm ci`; when a submodule dep changes run `npm run update-submodules` (regenerates+commits lockfile with the pointer bump). `allowScripts` block in package.json lets natives build on clean install; if `roaring.node` goes missing after an incremental install, `npm rebuild roaring`.
- Never add a global `semver` override (kills the clip child's sharp). See [[project-dependency-constraints]] for the same rule on tar.

**Config:** `CANVAS_CLIP_MODEL` (default Xenova/siglip-base-patch16-224), `CANVAS_CLIP_DTYPE` (fp32 default; q8 = 2-4x faster), `CANVAS_INFERD_THREADS` (explicit intraOpNumThreads - disables the affinity pinning that fails under cgroup limits).

**Ops:** image space is pinned `annIndex:false` (exact scan) - cross-modal text queries sit outside the image-vector distribution, quantized/L2 ANN silently returns 0 results (see [[project-vector-query-timeout-rootcause]]). After adding an embed rule for a new schema, seen-marked docs never backfill - run admin reindex-embeddings for that space.

Related: [[project_embedd_service]], [[project_synapsd_search_ranking]]
