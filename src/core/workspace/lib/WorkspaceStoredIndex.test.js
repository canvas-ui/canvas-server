import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { WorkspaceStoredIndex } from './WorkspaceStoredIndex.js';
import { WORKSPACE_DATA_BACKENDS, WORKSPACE_DIRECTORIES } from './constants.js';

describe('Workspace data backend defaults', () => {
    test('new workspaces get home, data, and cache defaults', () => {
        assert.equal(WORKSPACE_DIRECTORIES.home, 'home');
        assert.equal(WORKSPACE_DIRECTORIES.data, 'data');
        assert.equal(WORKSPACE_DIRECTORIES.cache, 'cache');
        assert.equal(WORKSPACE_DATA_BACKENDS['workspace:home'].enabled, true);
        assert.equal(WORKSPACE_DATA_BACKENDS['workspace:home'].watch, true);
        assert.equal(WORKSPACE_DATA_BACKENDS['stored.cache'].enabled, true);
        assert.equal(WORKSPACE_DATA_BACKENDS['stored.cache'].root, '{WORKSPACE_ROOT}/cache');
    });
});

describe('WorkspaceStoredIndex', () => {
    let rootPath;
    let index;
    let documents;
    let documentPaths;
    let lockCalls;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-index-'));
        await fs.ensureDir(path.join(rootPath, 'home', 'nested'));
        await fs.writeFile(path.join(rootPath, 'home', 'nested', 'a.txt'), 'hello');
        documents = new Map();
        documentPaths = new Map();
        lockCalls = [];
    });

    afterEach(async () => {
        if (index) await index.stop();
        if (rootPath) await fs.remove(rootPath);
        index = null;
        rootPath = null;
    });

    function createIndex() {
        const db = {
            async getByChecksumString(checksum) {
                return documents.get(checksum) || null;
            },
            async list({ directory }) {
                return [...documents.values()].filter((doc) => (documentPaths.get(doc.id) || []).some((p) => p.startsWith(directory)));
            },
            async listDocumentTreePaths(id, treeNameOrId) {
                // Regression: stale-path cleanup must query the 'directory' tree
                // (the legacy 'incoming' tree name silently resolved to nothing).
                assert.equal(treeNameOrId, 'directory');
                return documentPaths.get(id) || [];
            },
            async delete(id) {
                for (const [key, doc] of documents) { if (doc.id === id) documents.delete(key); }
                documentPaths.delete(id);
            },
        };

        return new WorkspaceStoredIndex({
            rootPath,
            cachePath: path.join(rootPath, 'cache'),
            dataPath: path.join(rootPath, 'data'),
            homePath: path.join(rootPath, 'home'),
            workspaceId: 'test-workspace',
            dataBackends: WORKSPACE_DATA_BACKENDS,
            logger: { warn() {}, debug() {} },
            getDb: () => db,
            getBackendsTreeSelector: (pathSpec) => pathSpec,
            lockBackendNode: (nodePath, holder) => { lockCalls.push({ nodePath, holder, locked: true }); },
            unlockBackendNode: (nodePath, holder) => { lockCalls.push({ nodePath, holder, locked: false }); },
            unlink: async (id, { directory }) => {
                documentPaths.set(id, (documentPaths.get(id) || []).filter((p) => p !== directory));
            },
            put: async (record, { directory } = {}) => {
                const id = record.id || `doc-${documents.size + 1}`;
                const doc = { ...record, id };
                documents.set(record.checksumArray[0], doc);
                if (directory !== undefined) {
                    documentPaths.set(id, Array.isArray(directory) ? directory : [directory]);
                }
                return id;
            },
        });
    }

    test('resync indexes watched home files into the /.backends tree', async () => {
        index = createIndex();
        await index.start();

        // start() no longer scans; reconciliation is an explicit operation.
        await index.resync('workspace:home');

        assert.equal(documents.size, 1);
        const [doc] = documents.values();
        assert.deepEqual(doc.data, {});
        assert.deepEqual(doc.locations, [{ url: 'stored://workspace:home/nested/a.txt' }]);
        assert.deepEqual(documentPaths.get(doc.id), ['/.backends/file/workspace:home/nested']);
        assert.equal(index.getBackendStatus('workspace:home').running, true);
        assert.ok(index.getBackendStatus('workspace:home').lastScanAt);
        // Enable-lock applied to the backend mirror node on start
        assert.ok(lockCalls.some((c) => c.locked && c.nodePath === '/.backends/file/workspace:home' && c.holder === 'workspace:home'));
    });

    test('resync purges docs whose only location was deleted', async () => {
        index = createIndex();
        await index.start();
        await index.resync('workspace:home');
        const [doc] = documents.values();

        await fs.remove(path.join(rootPath, 'home', 'nested', 'a.txt'));
        await index.resync('workspace:home');

        assert.equal(documents.size, 0);
        assert.equal(documentPaths.get(doc.id), undefined);
    });

    test('resync updates backend paths when a home file moves', async () => {
        index = createIndex();
        await index.start();
        await index.resync('workspace:home');
        const [doc] = documents.values();

        await fs.ensureDir(path.join(rootPath, 'home', 'renamed'));
        await fs.move(path.join(rootPath, 'home', 'nested', 'a.txt'), path.join(rootPath, 'home', 'renamed', 'a.txt'));
        await index.resync('workspace:home');

        assert.equal(documents.size, 1);
        assert.deepEqual(documentPaths.get(doc.id), ['/.backends/file/workspace:home/renamed']);
        assert.deepEqual([...documents.values()][0].locations, [
            { url: 'stored://workspace:home/renamed/a.txt' },
        ]);
    });

    test('destroy of last location deletes the doc unless keepDocument is set', async () => {
        index = createIndex();
        await index.start();
        await index.resync('workspace:home');
        const [doc] = documents.values();

        // keepDocument: bytes wiped, index entry stays with locations: []
        const kept = await index.destroy({ ...doc }, { keepDocument: true });
        assert.deepEqual(kept.deleted, ['stored://workspace:home/nested/a.txt']);
        assert.equal(kept.docDeleted, false);
        assert.equal(documents.size, 1);
        assert.deepEqual([...documents.values()][0].locations, []);
        assert.equal(await fs.pathExists(path.join(rootPath, 'home', 'nested', 'a.txt')), false);

        // default: last location gone → doc removed from index
        await fs.writeFile(path.join(rootPath, 'home', 'nested', 'b.txt'), 'again');
        await index.resync('workspace:home');
        const doc2 = [...documents.values()].find((d) => d.locations.length > 0);
        const destroyed = await index.destroy({ ...doc2 }, {});
        assert.equal(destroyed.docDeleted, true);
        assert.ok(![...documents.values()].some((d) => d.id === doc2.id));
    });

    test('resolve rejects file:// keys escaping the workspace root', async () => {
        index = createIndex();
        await index.start();
        await assert.rejects(
            () => index.resolve('file://{WORKSPACE_ROOT}/../outside.txt'),
            /escapes workspace root/,
        );
    });

    test('persistBlob stores into workspace:data and resolves back', async () => {
        index = createIndex();
        await index.start();

        const payload = Buffer.from('hello blob store');
        const res = await index.persistBlob(payload);

        assert.match(res.url, /^stored:\/\/workspace:data\//);
        assert.equal(res.size, payload.length);
        assert.ok(res.checksum);

        const back = await index.resolve(res.url);
        assert.deepEqual(back, payload);

        // dedup: same bytes → same key
        const again = await index.persistBlob(payload);
        assert.equal(again.key, res.key);
    });
});
