'use strict';

/**
 * Where a document is FILED, as opposed to where it is merely visible.
 *
 * A context path resolves to AND(layers along the path), so a document linked
 * at /dc-migration/tasks/foo is listed at /dc-migration/tasks, at
 * /dc-migration and at / as well. That is what a context tree is for — but it
 * means one folder can legitimately hold several documents answering to one
 * name (three `CLAUDE.md`, filed at three depths), and only one of them is
 * filed at the folder you are standing in.
 *
 * Every view that turns documents into files needs the same answer to "which
 * one is THE CLAUDE.md here", or walking from / to /dc-migration renames files
 * under the client: the mount (canvas-fuse), the WebDAV views, and the REST
 * listings those mounts read. So the arithmetic lives here, once.
 *
 * There is no new query shape for it: the path algebra already subtracts
 * (`paths: { not: [...] }`), and a selector object carries the tree the
 * exclusion belongs to.
 */

const ROOT = '/';

// Ceiling for the placement query. It resolves to a bitmap and returns ids, so
// it is cheap next to the listing it annotates; the cap only keeps a pathological
// workspace from materialising an unbounded array. Matches the WebDAV listing
// budget, since these two answer the same question about the same folder.
export const PLACEMENT_BUDGET = 25000;

function norm(p) {
    if (!p || p === ROOT) { return ROOT; }
    let n = p.startsWith('/') ? p : `/${p}`;
    if (n !== ROOT && n.endsWith('/')) { n = n.slice(0, -1); }
    return n;
}

/**
 * The child paths to subtract from `treePath` to leave only what is filed at
 * the path itself.
 *
 * Directory trees are node-exact already (a document ticks its leaf folder and
 * nothing else), so they have nothing to subtract.
 */
export async function subtreeExclusions(tree, treePath) {
    if (!tree || tree.type !== 'context' || typeof tree.listDirectories !== 'function') { return []; }

    let children;
    try { children = await tree.listDirectories(treePath); }
    catch { return []; }
    if (!Array.isArray(children) || children.length === 0) { return []; }

    const base = norm(treePath) === ROOT ? '' : norm(treePath);
    const exclusions = [];
    for (const name of children) {
        const childPath = `${base}/${name}`;
        // A canvas leaf is a saved query, not a place: resolveLayerIds drops
        // canvas layers, so its path resolves to the PARENT's bitmap.
        // Subtracting it would subtract everything standing here.
        if (tree.getLayerForPath?.(childPath)?.type === 'canvas') { continue; }
        exclusions.push({ tree: tree.id, path: childPath });
    }
    return exclusions;
}

/**
 * The ids of the documents filed at `treePath`.
 *
 * `runIdsQuery` receives the exclusion selectors and runs the idsOnly listing —
 * the caller owns the query, because a tree, a context and a REST route each
 * reach the db through a different door.
 *
 * Null means "no placement information": nothing is filed below this path, or
 * the query failed. Callers then fall back to naming documents the way they
 * did before — never to naming them wrongly with confidence.
 */
export async function localDocumentIds(runIdsQuery, tree, treePath) {
    const not = await subtreeExclusions(tree, treePath);
    if (not.length === 0) { return null; }
    try {
        const ids = await runIdsQuery(not);
        if (!Array.isArray(ids)) { return null; }
        return new Set(ids.map(Number).filter(Number.isFinite));
    } catch { return null; }
}

/**
 * Stamp a listing with `linkedHere`, so a client that renders documents as
 * files (canvas-fuse) can apply the same rule this server's own views do
 * without asking a second question per folder.
 *
 * Absent placement information means every document is treated as filed here,
 * which is exactly the old behaviour.
 */
export function stampPlacement(documents, localIds) {
    if (!Array.isArray(documents)) { return documents; }
    return documents.map((doc) => {
        if (!doc || typeof doc !== 'object') { return doc; }
        const record = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
        return { ...record, linkedHere: localIds ? localIds.has(Number(doc.id)) : true };
    });
}

/** The tree a selector names, or null when it no longer exists. */
export function treeOf(workspace, selector) {
    if (!workspace || !selector?.tree) { return null; }
    try { return workspace.getTree(selector.tree); }
    catch { return null; }
}

export default { subtreeExclusions, localDocumentIds, stampPlacement, treeOf, PLACEMENT_BUDGET };
