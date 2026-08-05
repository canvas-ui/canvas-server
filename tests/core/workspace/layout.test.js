import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';

import Workspace from '../../../src/core/workspace/Workspace.js';
import { WorkspaceStoredIndex } from '../../../src/core/workspace/lib/WorkspaceStoredIndex.js';
import { discoverWorkspaceCandidates, findWorkspaceConfigPath } from '../../../src/core/workspace/lib/scanner.js';
import { internalPathMatcher } from '../../../src/core/workspace/lib/internal-paths.js';
import {
    WORKSPACE_LAYOUTS,
    workspaceInternals,
    workspaceServices,
    workspaceStoredDefault,
} from '../../../src/core/workspace/lib/constants.js';

// Minimal Conf stand-in (get/set/delete/store) — Workspace only needs these.
function configStore(store) {
    return {
        store,
        get: (key, fallback) => (store[key] !== undefined ? store[key] : fallback),
        set: (key, value) => { store[key] = value; },
        delete: (key) => { delete store[key]; },
    };
}

function makeWorkspace(rootPath, layout) {
    return new Workspace({
        rootPath,
        configStore: configStore({
            id: 'ws-1',
            name: 'ws',
            owner: 'user-1',
            layout,
            internals: { ...workspaceInternals(layout) },
            services: workspaceServices(layout),
        }),
        logger: { info() {}, warn() {}, debug() {}, error() {} },
    });
}

describe('workspace layouts', () => {
    test('full layout keeps every runtime dir visible at the root', () => {
        const root = '/tmp/ws-full';
        const ws = makeWorkspace(root, WORKSPACE_LAYOUTS.FULL);

        assert.equal(ws.layout, 'full');
        assert.equal(ws.internalsPath, null);
        assert.equal(ws.homePath, path.join(root, 'home'));
        assert.equal(ws.dataPath, path.join(root, 'data'));
        assert.equal(ws.cachePath, path.join(root, 'cache'));
        assert.equal(ws.dbPath, path.join(root, 'db'));
        assert.equal(ws.storedRootPath, path.join(root, 'db', 'stored'));
        assert.equal(ws.gitPath, path.join(root, 'git'));
        assert.equal(ws.hooksPath, path.join(root, 'git', 'hooks'));
        assert.equal(ws.configDir, path.join(root, 'config'));
    });

    test('home layout puts the user drive at the root and internals in .workspace/', () => {
        const root = '/tmp/ws-home';
        const ws = makeWorkspace(root, WORKSPACE_LAYOUTS.HOME);
        const internal = path.join(root, '.workspace');

        assert.equal(ws.layout, 'home');
        assert.equal(ws.internalsPath, internal);
        // The whole point: the roaming drive IS the workspace root.
        assert.equal(ws.homePath, root);
        assert.equal(ws.dataPath, path.join(internal, 'data'));
        assert.equal(ws.cachePath, path.join(internal, 'cache'));
        assert.equal(ws.dbPath, path.join(internal, 'db'));
        assert.equal(ws.storedRootPath, path.join(internal, 'db', 'stored'));
        assert.equal(ws.gitPath, path.join(internal, 'git'));
        assert.equal(ws.hooksPath, path.join(internal, 'git', 'hooks'));
        assert.equal(ws.configDir, path.join(internal, 'config'));
        assert.equal(ws.varPath, path.join(internal, 'var'));

        // Nothing the workspace needs at runtime may sit outside .workspace/
        for (const dir of ws.internalPaths) {
            assert.ok(dir === internal || dir.startsWith(internal + path.sep), `${dir} escapes .workspace/`);
        }
    });

    test('an unknown/absent layout resolves to full (pre-layout workspaces)', () => {
        const ws = new Workspace({
            rootPath: '/tmp/ws-legacy',
            configStore: configStore({ id: 'ws-2', name: 'legacy', owner: 'user-1' }),
            logger: { info() {}, warn() {}, debug() {}, error() {} },
        });
        assert.equal(ws.layout, 'full');
        assert.equal(ws.homePath, path.join('/tmp/ws-legacy', 'home'));
    });

    test('an explicit internals override still beats the layout default', () => {
        const ws = new Workspace({
            rootPath: '/tmp/ws-mixed',
            configStore: configStore({
                id: 'ws-3',
                name: 'mixed',
                owner: 'user-1',
                layout: 'home',
                internals: { db: '/mnt/fast-ssd/ws-db' },
            }),
            logger: { info() {}, warn() {}, debug() {}, error() {} },
        });
        assert.equal(ws.dbPath, '/mnt/fast-ssd/ws-db');
        // …while the un-overridden dirs keep following the layout.
        assert.equal(ws.cachePath, path.join('/tmp/ws-mixed', '.workspace', 'cache'));
    });

    test('layout defaults describe themselves in workspace.json terms', () => {
        const stored = workspaceStoredDefault(WORKSPACE_LAYOUTS.HOME);
        assert.equal(stored.root, '{WORKSPACE_ROOT}/.workspace/db/stored');
        assert.equal(stored.cache, '{WORKSPACE_ROOT}/.workspace/cache');
        assert.equal(stored.backends['workspace:home'].root, '{WORKSPACE_ROOT}');
        assert.equal(stored.backends['workspace:data'].root, '{WORKSPACE_ROOT}/.workspace/data');
        assert.equal(workspaceServices(WORKSPACE_LAYOUTS.HOME).git.root, '{WORKSPACE_ROOT}/.workspace/git');
        // full layout is untouched
        assert.equal(workspaceStoredDefault(WORKSPACE_LAYOUTS.FULL).backends['workspace:home'].root, '{WORKSPACE_ROOT}/home');
    });
});

describe('workspace discovery with .workspace/', () => {
    test('finds workspace.json in either layout position', (t) => {
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'layout-scan-'));
        t.after(() => rmSync(tmp, { recursive: true, force: true }));

        const roots = path.join(tmp, 'Workspaces');
        const full = path.join(roots, 'alpha');
        const home = path.join(roots, 'beta');
        mkdirSync(path.join(home, '.workspace'), { recursive: true });
        mkdirSync(full, { recursive: true });
        writeFileSync(path.join(full, 'workspace.json'), JSON.stringify({ id: 'a', name: 'alpha' }));
        writeFileSync(path.join(home, '.workspace', 'workspace.json'), JSON.stringify({ id: 'b', name: 'beta', layout: 'home' }));

        assert.equal(findWorkspaceConfigPath(full), path.join(full, 'workspace.json'));
        assert.equal(findWorkspaceConfigPath(home), path.join(home, '.workspace', 'workspace.json'));
        assert.equal(findWorkspaceConfigPath(path.join(roots, 'nope')), null);
    });

    test('the scanner reports the home-layout dir as the workspace root', async (t) => {
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'layout-scan-'));
        t.after(() => rmSync(tmp, { recursive: true, force: true }));

        const root = path.join(tmp, 'Workspaces');
        const dir = path.join(root, 'roaming');
        mkdirSync(path.join(dir, '.workspace'), { recursive: true });
        writeFileSync(path.join(dir, '.workspace', 'workspace.json'), JSON.stringify({ id: 'r', name: 'roaming', layout: 'home' }));

        const { candidates } = await discoverWorkspaceCandidates([root]);
        assert.equal(candidates.length, 1);
        // rootPath is the user's folder; the config just lives below it.
        assert.equal(candidates[0].dir, dir);
        assert.equal(candidates[0].configPath, path.join(dir, '.workspace', 'workspace.json'));
    });
});

describe('internals are hidden from the exported drive', () => {
    test('home-layout internals are unreachable, user files are not', () => {
        const root = '/tmp/ws-home';
        const ws = makeWorkspace(root, WORKSPACE_LAYOUTS.HOME);
        const isInternal = internalPathMatcher(ws.homePath, ws);

        assert.equal(isInternal(path.join(root, '.workspace')), true);
        assert.equal(isInternal(path.join(root, '.workspace', 'db', 'data.mdb')), true);
        assert.equal(isInternal(path.join(root, '.workspace', 'workspace.json')), true);
        assert.equal(isInternal(path.join(root, 'Documents', 'notes.txt')), false);
        // A user's own dotfiles stay theirs — only the workspace's dirs hide.
        assert.equal(isInternal(path.join(root, '.bashrc')), false);
        assert.equal(isInternal(root), false);
    });

    test('full-layout home dir contains no internals at all', () => {
        const ws = makeWorkspace('/tmp/ws-full', WORKSPACE_LAYOUTS.FULL);
        const isInternal = internalPathMatcher(ws.homePath, ws);
        assert.equal(isInternal(path.join(ws.homePath, 'anything')), false);
        assert.equal(isInternal(path.join('/tmp/ws-full', 'db')), false); // outside home/
    });
});

describe('home-layout indexing never sees the workspace internals', () => {
    // The home backend's root IS the workspace root here, so without the
    // structural exclusions the workspace would index its own db/cache/git.
    async function buildIndex(rootPath, extraInternalPaths = []) {
        const documents = new Map();
        const documentPaths = new Map();
        const internal = path.join(rootPath, '.workspace');
        const index = new WorkspaceStoredIndex({
            rootPath,
            homePath: rootPath,
            cachePath: path.join(internal, 'cache'),
            dataPath: path.join(internal, 'data'),
            storedRootPath: path.join(internal, 'db', 'stored'),
            internalPaths: [internal, path.join(internal, 'db'), path.join(internal, 'git'), path.join(internal, 'var'), ...extraInternalPaths],
            workspaceId: 'ws-home',
            dataBackends: workspaceStoredDefault(WORKSPACE_LAYOUTS.HOME).backends,
            logger: { info() {}, warn() {}, debug() {} },
            getDb: () => ({
                async getByChecksumString() { return null; },
                async list() { return []; },
                // Absence reconciliation walks the backend's mirror subtree.
                async listTreeDocuments() { return { documents: [], count: 0, totalCount: 0 }; },
                async listDocumentTreePaths(id) { return documentPaths.get(id) || []; },
                async delete() {},
                async migrateDocumentMemberships() { return []; },
            }),
            getBackendsTreeSelector: (pathSpec) => pathSpec,
            unlink: async () => {},
            put: async (record, { directory } = {}) => {
                const id = record.id || `doc-${documents.size + 1}`;
                documents.set(id, { ...record, id });
                if (directory !== undefined) documentPaths.set(id, [directory]);
                return id;
            },
        });
        return { index, documents };
    }

    test('resync indexes the user files and skips .workspace/', async (t) => {
        const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-home-index-'));
        t.after(() => fs.remove(rootPath));

        // A roaming home: real user files at the top level…
        await fs.outputFile(path.join(rootPath, 'Documents', 'notes.txt'), 'hello');
        // …and the workspace's own state, which must stay invisible.
        await fs.outputFile(path.join(rootPath, '.workspace', 'db', 'data.mdb'), 'BINARY');
        await fs.outputFile(path.join(rootPath, '.workspace', 'workspace.json'), '{}');

        const { index, documents } = await buildIndex(rootPath);
        t.after(() => index.stop());
        await index.start();
        await index.resync('workspace:home');

        const urls = [...documents.values()].flatMap((doc) => (doc.locations || []).map((l) => l.url));
        assert.deepEqual(urls, ['stored://workspace:home/Documents/notes.txt']);
    });

    test('a non-hidden internal dir inside the indexed root is excluded too', async (t) => {
        // The dotfile default cannot save us here: this workspace's config
        // remapped its db out of .workspace/ into a plainly-named dir that sits
        // in the middle of the user's drive. Only the internal-path exclusions
        // keep the index from swallowing its own database.
        const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-home-index-'));
        t.after(() => fs.remove(rootPath));

        await fs.outputFile(path.join(rootPath, 'Documents', 'notes.txt'), 'hello');
        await fs.outputFile(path.join(rootPath, 'canvas-db', 'data.mdb'), 'BINARY');

        const { index, documents } = await buildIndex(rootPath, [path.join(rootPath, 'canvas-db')]);
        t.after(() => index.stop());
        await index.start();
        await index.resync('workspace:home');

        const urls = [...documents.values()].flatMap((doc) => (doc.locations || []).map((l) => l.url));
        assert.deepEqual(urls, ['stored://workspace:home/Documents/notes.txt']);
    });

    test('effective exclusions list the internals structurally', async (t) => {
        const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-home-index-'));
        t.after(() => fs.remove(rootPath));

        const { index } = await buildIndex(rootPath);
        t.after(() => index.stop());
        await index.start();

        const exclusions = index.getEffectiveExclusions('workspace:home');
        assert.ok(exclusions.includes('.workspace'));
        assert.ok(exclusions.includes('.workspace/**'));
        assert.ok(exclusions.includes('.workspace/db'));
        // Dotfile defaults are still there, on top of the structural ones.
        assert.ok(exclusions.includes('**/.*'));
    });
});
