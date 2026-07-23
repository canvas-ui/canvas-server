'use strict';

import path from 'path';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';

import { WORKSPACE_CONFIG_FILENAME } from './constants.js';

/**
 * Workspace discovery — filesystem side only. Walks the immediate
 * subdirectories of the given roots and returns every directory holding a
 * parseable workspace.json. Adoption, collision handling and index writes
 * happen in WorkspaceManager; this module never mutates anything.
 */

function validateWorkspaceConfig(config) {
    if (!config || typeof config !== 'object') return 'not an object';
    if (!config.id || typeof config.id !== 'string') return 'missing id';
    if (!config.name || typeof config.name !== 'string') return 'missing name';
    return null;
}

/**
 * @param {string[]} roots - directories whose children are workspace candidates
 * @returns {Promise<{candidates: Array<{dir, configPath, config}>, skipped: Array<{dir, reason}>}>}
 */
async function discoverWorkspaceCandidates(roots) {
    const candidates = [];
    const skipped = [];
    const seenDirs = new Set();

    for (const root of roots) {
        if (!root || !existsSync(root)) continue;

        let dirents;
        try {
            dirents = await fsPromises.readdir(root, { withFileTypes: true });
        } catch (err) {
            skipped.push({ dir: root, reason: `unreadable root: ${err.message}` });
            continue;
        }

        for (const dirent of dirents) {
            if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;

            const dir = path.join(root, dirent.name);
            let realDir = dir;
            try {
                realDir = await fsPromises.realpath(dir);
            } catch {
                continue; // broken symlink
            }
            if (seenDirs.has(realDir)) continue;

            const configPath = path.join(dir, WORKSPACE_CONFIG_FILENAME);
            if (!existsSync(configPath)) continue;

            let config;
            try {
                config = JSON.parse(await fsPromises.readFile(configPath, 'utf8'));
            } catch (err) {
                skipped.push({ dir, reason: `invalid workspace.json: ${err.message}` });
                continue;
            }

            const invalid = validateWorkspaceConfig(config);
            if (invalid) {
                skipped.push({ dir, reason: `invalid workspace.json: ${invalid}` });
                continue;
            }

            seenDirs.add(realDir);
            candidates.push({ dir, configPath, config });
        }
    }

    return { candidates, skipped };
}

export { discoverWorkspaceCandidates, validateWorkspaceConfig };
