'use strict';

import path from 'path';

/**
 * Predicate for "this path belongs to the workspace itself, not to the user".
 *
 * In the `home` layout the exported drive IS the workspace root, so the
 * workspace's own runtime dirs (`.workspace/…`, or wherever a config remapped
 * them) sit inside the very tree that WebDAV and the /home API expose. Every
 * user-facing view of that tree runs paths through this matcher, so the
 * internals are neither listed nor reachable — a client cannot browse, edit or
 * delete the workspace out from under itself.
 *
 * Built from the live workspace rather than from a constant: the layout only
 * supplies defaults, `internals`/`services` are the authority.
 *
 * @param {string} exportedRoot - root of the tree being exposed (usually homePath)
 * @param {{internalPaths?: string[]}|null} workspace
 * @returns {(target: string) => boolean} true when `target` is inside the internals
 */
export function internalPathMatcher(exportedRoot, workspace) {
    if (!exportedRoot) return () => false;
    const root = path.resolve(exportedRoot);
    const internals = (workspace?.internalPaths || [])
        .map((p) => path.resolve(p))
        // A dir AT the exported root would hide everything — that is a broken
        // config, not an internals match.
        .filter((p) => p !== root && p.startsWith(root + path.sep));
    if (internals.length === 0) return () => false;
    return (target) => {
        if (!target) return false;
        const abs = path.resolve(target);
        return internals.some((p) => abs === p || abs.startsWith(p + path.sep));
    };
}

export default internalPathMatcher;
