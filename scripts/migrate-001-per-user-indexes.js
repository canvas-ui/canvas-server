'use strict';

/**
 * RUN THIS BY HAND. It used to execute on every server boot from Server.js;
 * one-time migrations were pulled out of boot paths 2026-08-04 (see
 * services/synapsd/TODO.md — the same sweep removed synapsd's in-engine
 * migrations). It is idempotent and marker-guarded, so re-running is a no-op.
 *
 *   node scripts/migrate-001-per-user-indexes.js [--db <dir>] [--users <dir>]
 *
 * Defaults match a standard server layout ($CANVAS_SERVER_HOME/db and
 * $CANVAS_USER_HOME); pass the flags for anything else. Back up db/ first — it
 * renames the originals to *.migrated-<date> rather than deleting them, but a
 * backup costs nothing.
 */

import path from 'path';
import { fileURLToPath as _fileURLToPath } from 'url';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';

/**
 * Migration 001 — split the global db/workspaces.json and db/contexts.json
 * (keys `${userId}/${resourceId}`) into per-user index files at
 * db/users/<userId>/{workspaces,contexts}.json (key = resourceId).
 *
 * Workspace entries gain the index-only fields (origin/importedFrom/
 * lastScannedAt/remote). Everything mirrored from workspace.json self-heals on
 * the next discovery scan, so this migration never touches workspace dirs.
 * Originals are renamed to *.migrated-<date> (rollback artifact) and a marker
 * is written to db/.migrations.json so the migration runs exactly once.
 */

const MIGRATION_ID = '001-per-user-indexes';

function splitKey(key) {
    const slash = key.indexOf('/');
    if (slash <= 0 || slash === key.length - 1) return null;
    return [key.slice(0, slash), key.slice(slash + 1)];
}

async function readJson(filePath) {
    return JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, data) {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    await fsPromises.writeFile(filePath, `${JSON.stringify(data, null, '\t')}\n`, 'utf8');
}

async function readMarker(markerPath) {
    if (!existsSync(markerPath)) return {};
    try {
        return await readJson(markerPath);
    } catch {
        return {};
    }
}

function inferOrigin(entry, usersRootPath) {
    if (entry?.host && entry.host !== 'canvas.local') return 'remote';
    const rootPath = entry?.rootPath ? path.resolve(entry.rootPath) : null;
    if (rootPath && usersRootPath && rootPath.startsWith(path.resolve(usersRootPath) + path.sep)) {
        return 'local';
    }
    return rootPath ? 'foreign-local' : 'local';
}

/**
 * @param {Object} options
 * @param {string} options.dbPath - server db dir (holds workspaces.json/contexts.json)
 * @param {string} options.usersRootPath - user homes root (origin inference)
 * @param {Object} [options.logger]
 * @returns {Promise<{ran: boolean, workspaces: number, contexts: number}>}
 */
async function runPerUserIndexMigration({ dbPath, usersRootPath, logger = console }) {
    const markerPath = path.join(dbPath, '.migrations.json');
    const marker = await readMarker(markerPath);
    if (marker[MIGRATION_ID]) {
        return { ran: false, workspaces: 0, contexts: 0 };
    }

    const workspacesPath = path.join(dbPath, 'workspaces.json');
    const contextsPath = path.join(dbPath, 'contexts.json');
    if (!existsSync(workspacesPath) && !existsSync(contextsPath)) {
        return { ran: false, workspaces: 0, contexts: 0 };
    }

    const stamp = new Date().toISOString();
    const suffix = `.migrated-${stamp.slice(0, 10)}`;
    // Accumulate per-user files in memory first, then flush — merging with any
    // per-user file that already exists (partial re-run safety).
    const perUser = new Map(); // userId -> { workspaces: {}, contexts: {} }
    const bucket = (userId) => {
        if (!perUser.has(userId)) perUser.set(userId, { workspaces: {}, contexts: {} });
        return perUser.get(userId);
    };

    let workspaceCount = 0;
    let contextCount = 0;

    if (existsSync(workspacesPath)) {
        const store = await readJson(workspacesPath);
        for (const [key, entry] of Object.entries(store || {})) {
            const parts = splitKey(key);
            if (!parts || !entry || typeof entry !== 'object') {
                logger.warn?.(`[migration] Skipping unrecognized workspace index key: ${key}`);
                continue;
            }
            const [userId, workspaceId] = parts;
            const origin = inferOrigin(entry, usersRootPath);
            bucket(userId).workspaces[workspaceId] = {
                ...entry,
                status: entry.status === 'active' ? 'inactive' : entry.status,
                origin,
                importedFrom: entry.importedFrom ?? null,
                lastScannedAt: null,
                remote: origin === 'remote' ? { endpoint: null, authRef: null } : null,
            };
            workspaceCount += 1;
        }
    }

    if (existsSync(contextsPath)) {
        const store = await readJson(contextsPath);
        for (const [key, entry] of Object.entries(store || {})) {
            const parts = splitKey(key);
            if (!parts || !entry || typeof entry !== 'object') {
                logger.warn?.(`[migration] Skipping unrecognized context index key: ${key}`);
                continue;
            }
            const [userId, contextId] = parts;
            bucket(userId).contexts[contextId] = entry;
            contextCount += 1;
        }
    }

    for (const [userId, data] of perUser) {
        const userDir = path.join(dbPath, 'users', userId);
        if (Object.keys(data.workspaces).length > 0) {
            const target = path.join(userDir, 'workspaces.json');
            const existing = existsSync(target) ? await readJson(target) : {};
            await writeJson(target, { ...data.workspaces, ...existing });
        }
        if (Object.keys(data.contexts).length > 0) {
            const target = path.join(userDir, 'contexts.json');
            const existing = existsSync(target) ? await readJson(target) : {};
            await writeJson(target, { ...data.contexts, ...existing });
        }
    }

    // Move originals out of the way (also prevents accidental legacy reads)
    if (existsSync(workspacesPath)) {
        await fsPromises.rename(workspacesPath, `${workspacesPath}${suffix}`);
    }
    if (existsSync(contextsPath)) {
        await fsPromises.rename(contextsPath, `${contextsPath}${suffix}`);
    }

    marker[MIGRATION_ID] = { at: stamp, workspaces: workspaceCount, contexts: contextCount };
    await writeJson(markerPath, marker);

    logger.info?.(`[migration] ${MIGRATION_ID}: migrated ${workspaceCount} workspace and ${contextCount} context index entries to per-user files`);
    return { ran: true, workspaces: workspaceCount, contexts: contextCount };
}

export { runPerUserIndexMigration, MIGRATION_ID };

// CLI entry — skipped when imported (the test drives the function directly).
if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
    const arg = (name, fallback) => {
        const i = process.argv.indexOf(`--${name}`);
        return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
    };
    const serverHome = process.env.CANVAS_SERVER_HOME || path.join(process.cwd(), 'server');
    const dbPath = arg('db', path.join(serverHome, 'db'));
    const usersRootPath = arg('users', process.env.CANVAS_USER_HOME || path.join(serverHome, 'users'));

    console.log(`[migration] ${MIGRATION_ID}\n  db:    ${dbPath}\n  users: ${usersRootPath}`);
    runPerUserIndexMigration({ dbPath, usersRootPath })
        .then((result) => {
            console.log(result.ran
                ? `[migration] done — ${result.workspaces} workspace, ${result.contexts} context entries`
                : '[migration] nothing to do (already applied, or no legacy indexes present)');
        })
        .catch((error) => {
            console.error(`[migration] FAILED: ${error.message}`);
            process.exitCode = 1;
        });
}
