// Example (disabled): keep the context tree in step with a storage backend
// between full syncs. The server mirrors every mount into the backends tree
// (/<driver>/<address>/…) as folders appear (file watcher, resync, "new
// folder" in the UI); each of those inserts lands here and is copied into
// the context tree under the configured target.
//
// Pairs with started/example-backend-tree-sync.js (full sync); config is
// shared in ../lib/backend-tree-sync.js.
//
// Enable by renaming to `backend-tree-sync.js` (or toggle it in the webui).

import { syncInsertedPath } from '../lib/backend-tree-sync.js';

export default async function hook(ctx) {
  await syncInsertedPath(ctx);
}
