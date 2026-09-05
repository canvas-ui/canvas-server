import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

import Workspace from '../../../src/core/workspace/Workspace.js';
import { WorkspaceStoredIndex } from '../../../src/core/workspace/lib/WorkspaceStoredIndex.js';
import { conflictKey, SYNC_CONFLICT_TAG } from '../../../src/core/workspace/lib/SyncConflicts.js';
import { WORKSPACE_LAYOUTS, workspaceInternals, workspaceServices } from '../../../src/core/workspace/lib/constants.js';

const HOME = WorkspaceStoredIndex.HOME_STORED_BACKEND;
const exists = (p) => fs.access(p).then(() => true).catch(() => false);

/**
 * The conflict inbox end to end on a real workspace: a device's version of a
 * key the hub changed lands as a tagged document in the managed store, and
 * each resolution leaves the curation (tags, relations) on the survivor.
 */
describe('sync conflict inbox', () => {
    let root;
    let ws;

    before(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-sync-'));
        const store = {
            id: 'ws-sync-1', name: 'ws', owner: 'user-1', layout: WORKSPACE_LAYOUTS.FULL,
            internals: { ...workspaceInternals(WORKSPACE_LAYOUTS.FULL) },
            services: workspaceServices(WORKSPACE_LAYOUTS.FULL),
        };
        ws = new Workspace({
            rootPath: root,
            configStore: {
                store,
                get: (key, fallback) => (store[key] !== undefined ? store[key] : fallback),
                set: (key, value) => { store[key] = value; },
                delete: (key) => { delete store[key]; },
            },
            logger: { info() {}, warn() {}, debug() {}, error() {} },
        });
        await ws.start();
        await ws.updateBackend('file', HOME, { enabled: true, watch: false });
    });

    after(async () => {
        await ws?.stop().catch(() => {});
        if (root) await fs.rm(root, { recursive: true, force: true });
    });

    const conflicts = () => ws.listSyncConflicts();
    const tagged = async (tag) => (await ws.list({ attributes: { allOf: [tag] }, limit: 100 })).map((d) => d.id);

    test('conflictKey names the copy after the device and the minute', () => {
        const d = new Date(2026, 8, 5, 14, 12);
        assert.equal(conflictKey('Docs/contract.docx', 'laptop', d), 'Docs/contract (conflict from laptop 2026-09-05 1412).docx');
        assert.equal(conflictKey('README', 'a/b:c', d), 'README (conflict from a-b-c 2026-09-05 1412)');
    });

    test('create: device version → tagged inbox document related to the hub document', async () => {
        const hub = await ws.writeBackendObject('file', HOME, 'Docs/c.txt', 'hub version', { origin: 'hub' });
        assert.equal(hub.ok, true, JSON.stringify(hub));
        assert.ok(hub.docId, 'hub file has a document');
        await ws.link(hub.docId, { context: null, features: ['tag/important'] });

        const created = await ws.createSyncConflict({
            backend: HOME, key: 'Docs/c.txt', conflictOf: 'Docs/c.txt', source: Buffer.from('device version'),
            device: 'dev-laptop', deviceName: 'laptop', baseSha256: 'ee'.repeat(32),
        });
        assert.equal(created.mode, 'inbox');
        assert.equal(created.hubDocId, hub.docId);
        assert.notEqual(created.docId, hub.docId);
        assert.equal(created.hubSha256, hub.sha256);
        assert.match(created.url, /^stored:\/\/workspace:data\//);
        assert.equal(await fs.readFile(path.join(ws.homePath, 'Docs/c.txt'), 'utf8'), 'hub version', 'the key is untouched');

        const list = await conflicts();
        assert.equal(list.length, 1);
        assert.equal(list[0].docId, created.docId);
        assert.equal(list[0].key, 'Docs/c.txt');
        assert.equal(list[0].deviceName, 'laptop');
        assert.equal(list[0].hub.sha256, hub.sha256);
        assert.equal(list[0].hub.docId, hub.docId);
        assert.equal(list[0].base.sha256, 'ee'.repeat(32));
        assert.equal(list[0].resolvable, true);
        assert.ok((await tagged(SYNC_CONFLICT_TAG)).includes(created.docId));

        const rel = ws.listDocumentRelations(created.docId);
        assert.ok(rel.outgoing.some((e) => e.p === 'derived-from' && e.to === hub.docId), 'inbox doc is derived-from the hub doc');

        // A retried upload of the same bytes is one inbox entry.
        const again = await ws.createSyncConflict({ backend: HOME, key: 'Docs/c.txt', source: Buffer.from('device version'), device: 'dev-laptop' });
        assert.equal(again.docId, created.docId);
        assert.equal(again.duplicate, true);
        assert.equal((await conflicts()).length, 1);
    });

    test('resolve incoming: device bytes take the key, hub document orphaned, curation carried over', async () => {
        const [entry] = await conflicts();
        const hubDocId = entry.hub.docId;
        const result = await ws.resolveSyncConflict(entry.docId, { keep: 'incoming' });
        assert.equal(result.keep, 'incoming');
        assert.equal(result.survivorDocId, entry.docId);
        assert.equal(await fs.readFile(path.join(ws.homePath, 'Docs/c.txt'), 'utf8'), 'device version');

        const stat = await ws.statBackendObject('file', HOME, 'Docs/c.txt');
        assert.equal(stat.docId, entry.docId, 'the key now belongs to the incoming document');
        assert.ok((await tagged('tag/important')).includes(entry.docId), 'tag copied to the survivor');
        assert.ok(!(await tagged(SYNC_CONFLICT_TAG)).includes(entry.docId), 'conflict tag removed');
        assert.equal((await conflicts()).length, 0);

        const rel = ws.listDocumentRelations(entry.docId);
        assert.ok(!rel.outgoing.some((e) => e.p === 'derived-from' && e.to === hubDocId), 'derived-from retracted');
        const gone = await ws.statBackendObject('file', HOME, 'Docs/c.txt');
        assert.notEqual(gone.docId, hubDocId);
    });

    test('resolve both: the copy lands under a conflict name next to the untouched hub file', async () => {
        const hub = await ws.statBackendObject('file', HOME, 'Docs/c.txt');
        const created = await ws.createSyncConflict({ backend: HOME, key: 'Docs/c.txt', source: Buffer.from('third version'), device: 'dev-phone', deviceName: 'phone' });
        const result = await ws.resolveSyncConflict(created.docId, { keep: 'both' });
        assert.equal(result.keep, 'both');
        assert.match(result.resultKey, /^Docs\/c \(conflict from phone \d{4}-\d{2}-\d{2} \d{4}\)\.txt$/);
        assert.equal(await fs.readFile(path.join(ws.homePath, result.resultKey), 'utf8'), 'third version');
        assert.equal(await fs.readFile(path.join(ws.homePath, 'Docs/c.txt'), 'utf8'), 'device version', 'hub file untouched');
        const copy = await ws.statBackendObject('file', HOME, result.resultKey);
        assert.equal(copy.docId, created.docId);
        assert.ok((await tagged('tag/important')).includes(created.docId), 'tag copied onto the copy');
        assert.ok((await tagged('tag/important')).includes(hub.docId), 'original keeps its tag');
        const rel = ws.listDocumentRelations(created.docId);
        assert.ok(rel.outgoing.some((e) => e.p === 'derived-from' && e.to === hub.docId), 'copy stays derived-from the original');
        assert.equal((await conflicts()).length, 0);
    });

    test('resolve hub: the incoming version is destroyed', async () => {
        const created = await ws.createSyncConflict({ backend: HOME, key: 'Docs/c.txt', source: Buffer.from('fourth version'), device: 'dev-laptop' });
        const dataKey = created.url.replace('stored://workspace:data/', '');
        assert.ok(await ws.statBlobByChecksum(created.sha256), 'bytes in the managed store');
        const result = await ws.resolveSyncConflict(created.docId, { keep: 'hub' });
        assert.equal(result.keep, 'hub');
        assert.equal((await conflicts()).length, 0);
        assert.equal(await ws.statBlobByChecksum(created.sha256), null, 'managed-store bytes gone');
        assert.ok(dataKey);
        await assert.rejects(() => ws.resolveSyncConflict(created.docId, { keep: 'hub' }), (e) => e.statusCode === 404 || e.statusCode === 409);
    });

    test('rename mode: the device already picked the conflict name; the hub only marks it', async () => {
        const key = conflictKey('Docs/c.txt', 'tablet', new Date(2026, 8, 5, 12, 0));
        const created = await ws.createSyncConflict({ mode: 'rename', backend: HOME, key, conflictOf: 'Docs/c.txt', source: Buffer.from('tablet version'), device: 'dev-tablet', deviceName: 'tablet' });
        assert.equal(created.mode, 'rename');
        assert.equal(created.key, key);
        assert.equal(await fs.readFile(path.join(ws.homePath, key), 'utf8'), 'tablet version');
        const list = await conflicts();
        assert.equal(list.length, 1);
        assert.equal(list[0].resolvable, false);
        assert.equal(list[0].conflictKey, key);
        await assert.rejects(() => ws.resolveSyncConflict(created.docId, { keep: 'hub' }), (e) => e.code === 'NOT_RESOLVABLE');
        assert.ok(await exists(path.join(ws.homePath, key)));
    });

    test('bad input is refused with typed errors', async () => {
        await assert.rejects(() => ws.createSyncConflict({ backend: HOME, key: '../x', source: Buffer.from('x') }), (e) => e.code === 'INVALID_KEY');
        await assert.rejects(() => ws.resolveSyncConflict(999999, { keep: 'hub' }), (e) => e.code === 'NOT_FOUND');
        await assert.rejects(() => ws.resolveSyncConflict(1, { keep: 'maybe' }), (e) => e.code === 'INVALID_RESOLUTION');
    });
});
