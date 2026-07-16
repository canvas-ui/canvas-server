---
name: project-dependency-constraints
description: "Hard dependency constraints — fastembed needs tar 6, do not override tar globally"
metadata: 
  node_type: memory
  type: project
  originSessionId: c917c317-78d4-441e-ab0f-58e6e4adcbbb
---

**fastembed@2.1.0 requires tar 6.x — never force it onto tar 7.** `node_modules/fastembed/lib/esm/fastembed.js` does `import tar from 'tar'` (default import). tar v7 is ESM-only with **no default export**, so tar 7 breaks ALL embedding at runtime (`primary embed failed … module 'tar' does not provide an export named 'default'` → every doc embeds to 0 chunks). A global `"tar"` override in package.json to satisfy the tar path-traversal advisories (GHSA-34x7-hfp2-rc4v etc.) is a TRAP: it forces fastembed to 7 and kills embedding. The fastembed tar advisory is effectively unfixable without a breaking fastembed downgrade — accept it; its exposure is contained to model-tarball extraction from HuggingFace over HTTPS.

**Correct natural tar resolution (no override):** fastembed → tar 6.2.1 (nested), onnxruntime-node + roaring(node-gyp/node-pre-gyp) → tar 7.5.x (patched). Verified working 2026-07-12.

**Fixed & kept (2026-07-12):** nodemailer ^8→^9 (SSRF advisory; plain createTransport usage, API-compatible) and `"utf7": { "semver": "^5.7.2" }` override (imap→utf7 ReDoS). NOTE: user reported a global semver bump previously broke fastembed/onnx — keep semver overrides SCOPED (nested under the consumer), never global.

**Deferred/accepted vulns:** fastify ≤5.8.2 (needs 4→5 major migration — real work, not a bump); @mariozechner/pi-coding-agent (on latest 0.73.1, no patched release exists).

Lockfile churn gotcha: after changing a tar/nested override, an incremental `npm install` leaves stale "invalid/deduped" tar entries. Fix by deleting the `node_modules/**/tar` lock entries + `node_modules/**/tar` dirs, then `npm install` re-resolves cleanly (avoids a full lockfile regen / version drift). See [[feedback-no-commits]].
