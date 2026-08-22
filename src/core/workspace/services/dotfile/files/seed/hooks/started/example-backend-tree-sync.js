// Example (disabled): mirror the folder structure of a storage backend
// (default: workspace:home) into the context tree on every workspace start.
// Run it any time from the webui (Hooks → Run) — the envelope is then
// { manual: true } instead of the start payload; the sync does not care.
//
// Config (backend, target path, prune, dot-folders) lives in
// ../lib/backend-tree-sync.js and is shared with the incremental
// tree.path.inserted/ hook. Pass overrides here if you want this file
// to differ, e.g. syncBackendTree(ctx, { backend: 'nas', target: '/nas' }).
//
// Enable by renaming to `backend-tree-sync.js` (or toggle it in the webui).

import { syncBackendTree } from '../lib/backend-tree-sync.js';

export default async function hook(ctx) {
  await syncBackendTree(ctx);
}
