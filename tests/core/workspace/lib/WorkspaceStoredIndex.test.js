import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { WorkspaceStoredIndex } from '../../../../src/core/workspace/lib/WorkspaceStoredIndex.js';
import { WORKSPACE_STORAGE_BACKENDS, WORKSPACE_STORED_DEFAULT, WORKSPACE_DIRECTORIES } from '../../../../src/core/workspace/lib/constants.js';

describe('Workspace stored defaults', () => {
    test('new workspaces get home/data backends and a first-class cache', () => {
        assert.equal(WORKSPACE_DIRECTORIES.home, 'home');
        assert.equal(WORKSPACE_DIRECTORIES.data, 'data');
        assert.equal(WORKSPACE_DIRECTORIES.cache, 'cache');
        assert.equal(WORKSPACE_STORAGE_BACKENDS['workspace:home'].enabled, true);
        assert.equal(WORKSPACE_STORAGE_BACKENDS['workspace:home'].watch, true);
        // The cache is NOT a backend — it's stored's own working store.
        assert.equal('stored.cache' in WORKSPACE_STORAGE_BACKENDS, false);
        assert.equal(WORKSPACE_STORED_DEFAULT.cache, '{WORKSPACE_ROOT}/cache');
        assert.equal(WORKSPACE_STORED_DEFAULT.root, '{WORKSPACE_ROOT}/db/stored');
        assert.deepEqual(WORKSPACE_STORED_DEFAULT.sync, { policies: [] });
    });
});

describe('WorkspaceStoredIndex', () => {
    let rootPath;
    let index;
    let documents;
    let documentPaths;
    let lockCalls;
    let migrations;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-index-'));
        await fs.ensureDir(path.join(rootPath, 'home', 'nested'));
        await fs.writeFile(path.join(rootPath, 'home', 'nested', 'a.txt'), 'hello');
        documents = new Map();
        documentPaths = new Map();
        lockCalls = [];
        migrations = [];
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
            async list({ directory, features } = {}) {
                if (features?.allOf) {
                    return [...documents.values()].filter((doc) =>
                        features.allOf.every((f) => f === 'feature/orphaned'
                            ? Boolean(doc.orphanedAt) && (doc.locations || []).length === 0
                            : (doc.features || []).includes(f)));
                }
                return [...documents.values()].filter((doc) => (documentPaths.get(doc.id) || []).some((p) => p.startsWith(directory)));
            },
            // Absence reconciliation lists the backend's mirror SUBTREE. The
            // real implementation is recursive (findRecursive); the previous
            // stub's loose prefix match was more permissive than the db, which
            // is how a non-recursive production call went unnoticed.
            async listTreeDocuments(treeNameOrId, { path: treePath = '/' } = {}) {
                assert.equal(treeNameOrId, 'backends');
                const matched = [...documents.values()].filter((doc) =>
                    (documentPaths.get(doc.id) || []).some((p) => p === treePath || p.startsWith(`${treePath}/`)));
                return { documents: matched, count: matched.length, totalCount: matched.length };
            },
            async listDocumentTreePaths(id, treeNameOrId) {
                // Regression: stale-path cleanup must query the dedicated
                // backends tree, never a legacy/default tree name.
                assert.equal(treeNameOrId, 'backends');
                return documentPaths.get(id) || [];
            },
            async delete(id) {
                for (const [key, doc] of documents) { if (doc.id === id) documents.delete(key); }
                documentPaths.delete(id);
            },
            async migrateDocumentMemberships(fromId, toId, options = {}) {
                migrations.push({ fromId, toId, options });
                return [];
            },
        };

        return new WorkspaceStoredIndex({
            rootPath,
            cachePath: path.join(rootPath, 'cache'),
            dataPath: path.join(rootPath, 'data'),
            homePath: path.join(rootPath, 'home'),
            workspaceId: 'test-workspace',
            dataBackends: WORKSPACE_STORAGE_BACKENDS,
            logger: { info() {}, warn() {}, debug() {} },
            getDb: () => db,
            getBackendsTreeSelector: (pathSpec) => pathSpec,
            lockBackendNode: (nodePath, holder) => { lockCalls.push({ nodePath, holder, locked: true }); },
            unlockBackendNode: (nodePath, holder) => { lockCalls.push({ nodePath, holder, locked: false }); },
            unlink: async (id, { directory }) => {
                documentPaths.set(id, (documentPaths.get(id) || []).filter((p) => p !== directory));
            },
            put: async (record, { directory } = {}) => {
                // Mirror synapsd: a put carrying an id merges onto the stored doc
                // (updateOne semantics — metadata is a shallow merge), a new doc
                // is keyed by its primary checksum.
                let doc = record.id ? [...documents.values()].find((d) => d.id === record.id) : null;
                if (doc) {
                    const { metadata, ...rest } = record;
                    Object.assign(doc, rest);
                    if (metadata) doc.metadata = { ...doc.metadata, ...metadata };
                } else {
                    const id = record.id || `doc-${documents.size + 1}`;
                    doc = { ...record, id };
                    documents.set(record.checksumArray[0], doc);
                }
                if (directory !== undefined) {
                    documentPaths.set(doc.id, Array.isArray(directory) ? directory : [directory]);
                }
                return doc.id;
            },
        });
    }

    test('resync indexes watched home files into the backends tree', async () => {
        index = createIndex();
        await index.start();

        // start() no longer scans; reconciliation is an explicit operation.
        await index.resync('workspace:home');

        assert.equal(documents.size, 1);
        const [doc] = documents.values();
        assert.deepEqual(doc.data, {});
        assert.deepEqual(doc.locations, [{ url: 'stored://workspace:home/nested/a.txt' }]);
        assert.deepEqual(documentPaths.get(doc.id), ['/workspace/home/nested']);
        assert.equal(index.getBackendStatus('workspace:home').running, true);
        assert.ok(index.getBackendStatus('workspace:home').lastScanAt);
        // Enable-lock applied to the backend mirror node on start
        assert.ok(lockCalls.some((c) => c.locked && c.nodePath === '/workspace/home' && c.holder === 'workspace:home'));
    });

    test('resync orphans (never deletes) docs whose only location vanished', async () => {
        index = createIndex();
        await index.start();
        await index.resync('workspace:home');
        const [doc] = documents.values();

        await fs.remove(path.join(rootPath, 'home', 'nested', 'a.txt'));
        await index.resync('workspace:home');

        // Orphan lifecycle: row + checksums survive, backend-mirror path is
        // unticked, doc is flagged feature/orphaned with an orphanedAt stamp.
        assert.equal(documents.size, 1);
        const orphan = [...documents.values()][0];
        assert.deepEqual(orphan.locations, []);
        assert.ok(orphan.orphanedAt);
        assert.ok(!(orphan.features || []).includes('feature/orphaned'));
        assert.deepEqual(documentPaths.get(doc.id), []);
    });

    test('orphaned doc re-binds when its bytes reappear', async () => {
        index = createIndex();
        await index.start();
        await index.resync('workspace:home');
        const [doc] = documents.values();

        await fs.remove(path.join(rootPath, 'home', 'nested', 'a.txt'));
        await index.resync('workspace:home');
        assert.ok([...documents.values()][0].orphanedAt);

        // Same bytes reappear (different name, same content) → checksum index
        // re-binds the location to the SAME doc; orphan markers clear.
        await fs.writeFile(path.join(rootPath, 'home', 'nested', 'restored.txt'), 'hello');
        await index.resync('workspace:home');

        assert.equal(documents.size, 1);
        const rebound = [...documents.values()][0];
        assert.equal(rebound.id, doc.id);
        assert.equal(rebound.orphanedAt, null);
        assert.ok(!(rebound.features || []).includes('feature/orphaned'));
        assert.deepEqual(rebound.locations, [{ url: 'stored://workspace:home/nested/restored.txt' }]);
    });

    test('resync does not purge when the backend root is missing (liveness gate)', async () => {
        index = createIndex();
        await index.start();
        await index.resync('workspace:home');
        assert.equal(documents.size, 1);
        const before = JSON.parse(JSON.stringify([...documents.values()][0]));

        // Simulate an unmounted drive: the root itself is gone. Absent mount
        // must be indistinguishable from empty mount — nothing may be removed.
        await fs.remove(path.join(rootPath, 'home'));
        const result = await index.resync('workspace:home');

        assert.equal(result.ok, false);
        assert.equal(result.offline, true);
        assert.equal(index.getBackendStatus('workspace:home').offline, true);
        assert.equal(documents.size, 1);
        const after = [...documents.values()][0];
        assert.deepEqual(after.locations, before.locations);
        assert.ok(!(after.features || []).includes('feature/orphaned'));
    });

    test('in-place edit migrates curated placements to the successor doc', async () => {
        index = createIndex();
        await index.start();
        await index.resync('workspace:home');
        const [oldDoc] = documents.values();

        await fs.writeFile(path.join(rootPath, 'home', 'nested', 'a.txt'), 'edited content');
        await index.resync('workspace:home');

        const successor = [...documents.values()].find((d) => d.id !== oldDoc.id && (d.locations || []).length > 0);
        const orphan = [...documents.values()].find((d) => d.id === oldDoc.id);
        assert.ok(successor, 'successor doc for the edited bytes exists');
        // Predecessor orphaned quietly (placements survive), successor carries
        // the derivedFrom breadcrumb and received the migrated placements.
        assert.ok(orphan.orphanedAt);
        assert.ok(!(orphan.features || []).includes('feature/orphaned'));
        assert.equal(successor.metadata.derivedFrom, oldDoc.checksumArray[0]);
        assert.deepEqual(migrations, [{
            fromId: oldDoc.id,
            toId: successor.id,
            options: { excludeTrees: ['backends'] },
        }]);
    });

    test('gcOrphanedDocuments honors retention (-1 keeps forever)', async () => {
        index = createIndex();
        await index.start();
        await index.resync('workspace:home');
        await fs.remove(path.join(rootPath, 'home', 'nested', 'a.txt'));
        await index.resync('workspace:home');
        const orphan = [...documents.values()][0];
        assert.ok(orphan.orphanedAt);

        // Default retention (none passed, no hook) → no purge.
        assert.deepEqual(await index.gcOrphanedDocuments(), { purged: 0 });
        assert.equal(documents.size, 1);

        // retentionDays 0 → purge all current orphans.
        const res = await index.gcOrphanedDocuments({ retentionDays: 0 });
        assert.deepEqual(res, { purged: 1 });
        assert.equal(documents.size, 0);
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
        assert.deepEqual(documentPaths.get(doc.id), ['/workspace/home/renamed']);
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
        assert.deepEqual(back.data, payload);

        // dedup: same bytes → same key
        const again = await index.persistBlob(payload);
        assert.equal(again.key, res.key);
    });
});
