// Mirror a storage backend's folder structure into the workspace's context
// tree ("virtual directory tree"). The server already mirrors every mount 1:1
// into the dedicated backends tree (/<driver>/<address>/…); this lib copies
// that skeleton into the tree you actually navigate and link documents into,
// so a folder created on disk (or on the NAS / Drive mount) shows up as a
// context path without anyone clicking "new folder".
//
// Used by two thin hooks that share this config:
//   started/example-backend-tree-sync.js            full sync on workspace start
//                                                   (and via the webui Run button)
//   tree.path.inserted/example-backend-tree-sync.js incremental: one folder
//                                                   appears in the backends
//                                                   mirror → same folder in the
//                                                   context tree
//
// Edit the defaults below (or pass overrides to the functions). Both hooks are
// disabled examples; enable them in the webui (power icon) or rename them.

export const DEFAULTS = {
    /** Backend to mirror — a key of the workspace's data backends. */
    backend: 'workspace:home',
    /**
     * Tree path the backend root maps to. Context tree by default ('/' = tree
     * root, '/home' = nest under /home); qualify to pick another tree:
     * 'dir:/' mirrors into the directory tree, 'ctx:/x' is the explicit form.
     */
    target: '/',
    /** Backend-relative folder to restrict the sync to ('' = whole backend, 'foo/bar' = that subtree). */
    subdir: '',
    /**
     * Remove context paths under `target` that no longer exist on the backend.
     * Off by default: the context tree is yours — you may have created paths
     * by hand under the same root, and removing a path drops its placements.
     * Only ever prunes paths that are NOT on the backend; never touches `target` itself.
     */
    prune: false,
    /** Skip folders whose name starts with a dot (.git, .cache, …). */
    skipDotfolders: true,
};

// 'dir:/bar' → directory tree + '/bar'; 'ctx:/x' → context tree; bare path →
// the hook context's tree (context).
function resolveTargetTree(ctx, target) {
    const raw = String(target || '/');
    const qualifier = raw.match(/^([A-Za-z][\w-]*):(?=\/|$)/);
    if (!qualifier) { return { tree: ctx.tree, target: raw || '/' }; }
    const name = ({ ctx: 'context', dir: 'directory' })[qualifier[1]] || qualifier[1];
    const tree = name === 'context' ? ctx.tree : ctx.workspace?.getTree?.(name);
    return { tree, target: raw.slice(qualifier[0].length) || '/' };
}

// Manual runs (webui Run / POST /hooks/run) may carry the config in the
// payload: { backend, target, subdir, prune, skipDotfolders }. Event payloads
// never do — only an explicit manual envelope is trusted here.
function payloadOverrides(payload) {
    if (payload?.manual !== true) { return {}; }
    const out = {};
    for (const key of ['backend', 'target', 'subdir', 'prune', 'skipDotfolders']) {
        if (payload[key] !== undefined && payload[key] !== null) { out[key] = payload[key]; }
    }
    return out;
}

function normalizeSubdir(subdir) {
    return String(subdir || '').replace(/^\/+|\/+$/g, '');
}

function joinPath(target, rel) {
    const base = target === '/' ? '' : target.replace(/\/+$/, '');
    return `${base}/${rel}`.replace(/\/+/g, '/');
}

function isUnderDotfolder(rel) {
    return rel.split('/').some((seg) => seg.startsWith('.'));
}

/**
 * Full sync: every folder on the backend becomes a context path under `target`.
 * Idempotent — existing paths are left alone (insertPath is a no-op for them).
 * @returns {Promise<{ backend, target, dirs, inserted, pruned, skipped } | null>}
 */
export async function syncBackendTree(ctx, overrides = {}) {
    const { logger, backendShape } = ctx;
    const cfg = { ...DEFAULTS, ...payloadOverrides(ctx.payload), ...overrides };
    const resolved = resolveTargetTree(ctx, cfg.target);
    const tree = resolved.tree;
    cfg.target = resolved.target;
    if (!tree) { logger.warn(`backend-tree-sync: no tree for target ${overrides.target ?? cfg.target} (workspace inactive?)`); return null; }
    const subdir = normalizeSubdir(cfg.subdir);

    const shape = await backendShape(cfg.backend);
    if (!shape?.ok) {
        logger.warn(`backend-tree-sync: cannot read shape of ${cfg.backend}: ${shape?.reason || 'unknown'}`);
        return null;
    }

    let inserted = 0;
    let skipped = 0;
    const wanted = new Set();
    for (const fullDir of shape.dirs) {
        let dir = fullDir;
        if (subdir) {
            if (fullDir !== subdir && !fullDir.startsWith(`${subdir}/`)) { continue; }
            dir = fullDir.slice(subdir.length + 1);
            if (!dir) { continue; } // the subdir itself IS the target
        }
        if (cfg.skipDotfolders && isUnderDotfolder(dir)) { skipped++; continue; }
        const path = joinPath(cfg.target, dir);
        wanted.add(path);
        if (tree.pathExists(path)) { continue; }
        const res = await tree.insertPath(path);
        if (res?.error) { logger.warn(`backend-tree-sync: insert ${path} failed: ${res.error}`); continue; }
        inserted++;
    }

    let pruned = 0;
    if (cfg.prune) {
        const prefix = cfg.target === '/' ? '/' : `${cfg.target}/`;
        // Deepest first so a subtree is removed leaf-by-leaf.
        const existing = (tree.paths || [])
            .filter((p) => p !== cfg.target && p.startsWith(prefix) && !wanted.has(p))
            .sort((a, b) => b.length - a.length);
        for (const path of existing) {
            // A parent of a wanted path is still needed even if not a dir itself.
            if ([...wanted].some((w) => w.startsWith(`${path}/`))) { continue; }
            const res = await tree.removePath(path, true);
            if (res?.error) { logger.warn(`backend-tree-sync: prune ${path} failed: ${res.error}`); continue; }
            pruned++;
        }
    }

    const source = subdir ? `${cfg.backend}/${subdir}` : cfg.backend;
    const summary = { backend: cfg.backend, subdir, target: cfg.target, tree: tree.name, dirs: wanted.size, inserted, pruned, skipped };
    logger.info(`backend-tree-sync: ${source} → ${tree.name}:${cfg.target}: ${wanted.size} folders, ${inserted} inserted, ${pruned} pruned, ${skipped} skipped`);
    return summary;
}

/**
 * Incremental sync from a `tree.path.inserted` event on the backends tree:
 * /<driver>/<address>/a/b appeared → ensure `${target}/a/b` exists.
 * Returns the inserted context path, or null when the event was not ours.
 */
export async function syncInsertedPath(ctx, overrides = {}) {
    const { payload, workspace, logger } = ctx;
    const cfg = { ...DEFAULTS, ...overrides };
    const resolved = resolveTargetTree(ctx, cfg.target);
    const tree = resolved.tree;
    cfg.target = resolved.target;
    if (!tree || !payload?.path) { return null; }
    const subdir = normalizeSubdir(cfg.subdir);

    // Only the backends tree, only our backend's subtree.
    const backendsTreeName = workspace.getBackendsTree?.()?.name;
    if (!backendsTreeName || payload.treeName !== backendsTreeName) { return null; }
    const root = workspace.getBackendTreeRoot?.(cfg.backend);
    if (!root || !payload.path.startsWith(`${root}/`)) { return null; }

    let rel = payload.path.slice(root.length + 1);
    if (subdir) {
        if (!rel.startsWith(`${subdir}/`)) { return null; }
        rel = rel.slice(subdir.length + 1);
    }
    if (cfg.skipDotfolders && isUnderDotfolder(rel)) { return null; }
    const path = joinPath(cfg.target, rel);
    if (tree.pathExists(path)) { return null; }
    const res = await tree.insertPath(path);
    if (res?.error) { logger.warn(`backend-tree-sync: insert ${path} failed: ${res.error}`); return null; }
    logger.debug(`backend-tree-sync: ${payload.path} → ${path}`);
    return path;
}
