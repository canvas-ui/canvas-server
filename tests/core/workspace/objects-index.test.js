import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';

const exists = (p) => fs.access(p).then(() => true).catch(() => false);

import { WorkspaceStoredIndex, normalizeObjectKey } from '../../../src/core/workspace/lib/WorkspaceStoredIndex.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal synapsd stand-in: documents keyed by id, looked up by checksum
// string, with the two placement calls #upsertDocument makes.
function fakeDb() {
    const docs = new Map();
    const byChecksum = new Map();
    let nextId = 100001;
    const migrations = [];
    const db = {
        docs, migrations,
        async getByChecksumString(cs) { const id = byChecksum.get(cs); return id != null ? docs.get(id) : null; },
        async listDocumentTreePaths() { return []; },
        async migrateDocumentMemberships(from, to) { migrations.push([from, to]); },
        put(record) {
            let id = record.id;
            if (id == null) { id = nextId; nextId += 1; }
            const doc = { ...(docs.get(id) || {}), ...record, id };
            docs.set(id, doc);
            for (const cs of doc.checksumArray || []) byChecksum.set(cs, id);
            return id;
        },
    };
    return db;
}

describe('WorkspaceStoredIndex keyed objects', () => {
    let root;
    let index;
    let db;
    const nudges = [];

    before(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-objects-'));
        db = fakeDb();
        const internal = path.join(root, '.workspace');
        index = new WorkspaceStoredIndex({
            rootPath: root,
            homePath: root,
            dataPath: path.join(internal, 'data'),
            cachePath: path.join(internal, 'cache'),
            storedRootPath: path.join(internal, 'db', 'stored'),
            internalPaths: [internal],
            workspaceId: 'ws-objects',
            logger: { info() {}, warn(...a) { console.warn(...a); }, debug() {}, error(...a) { console.error(...a); } },
            dataBackends: {
                'workspace:home': { driver: 'file', enabled: true, watch: false, root: '{WORKSPACE_ROOT}' },
                'workspace:data': { driver: 'cacache', enabled: true, managed: true, root: '{WORKSPACE_ROOT}/.workspace/data' },
            },
            put: async (record) => db.put(record),
            unlink: async () => {},
            getBackendsTreeSelector: (paths) => ({ tree: 'backends', paths }),
            getDb: () => db,
            onBackendChanged: (e) => nudges.push(e),
        });
        await index.start();
        assert.ok(index.isRunning, 'stored index started');
    });

    after(async () => {
        await index.stop();
        await fs.rm(root, { recursive: true, force: true });
    });

    test('normalizeObjectKey', () => {
        assert.equal(normalizeObjectKey('/UI//a.txt/'), 'UI/a.txt');
        assert.equal(normalizeObjectKey('a\\b.txt'), 'a/b.txt');
        assert.equal(normalizeObjectKey('../x'), null);
        assert.equal(normalizeObjectKey('a/./b'), null);
        assert.equal(normalizeObjectKey(''), null);
        assert.equal(normalizeObjectKey('café.txt'), 'café.txt', 'NFC');
    });

    test('writeObject lands bytes, creates the document and reports its id', async () => {
        const result = await index.writeObject('workspace:home', 'UI/a.txt', Buffer.from('alpha'), { origin: 'dev1', mtime: 1700000000000 });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.key, 'UI/a.txt');
        assert.equal(result.docId, 100001);
        assert.equal(await fs.readFile(path.join(root, 'UI/a.txt'), 'utf8'), 'alpha');

        const doc = db.docs.get(100001);
        assert.equal(doc.schema, 'data/schema/file');
        assert.equal(doc.locations[0].url, 'stored://workspace:home/UI/a.txt');
        assert.equal(doc.checksumArray[0], `sha256/${result.sha256}`);

        const stat = await index.statObject('workspace:home', 'UI/a.txt');
        assert.equal(stat.docId, 100001);
        assert.equal(stat.sha256, result.sha256);
        assert.equal(stat.mtime, 1700000000000);

        const listing = index.listObjects('workspace:home');
        assert.deepEqual(listing.objects.map((o) => o.key), ['UI/a.txt']);
        assert.equal(listing.objects[0].sha256, result.sha256);
        assert.ok(listing.head >= 1);

        const feed = index.changes('workspace:home', { since: 0 });
        assert.equal(feed.changes.length, 1);
        assert.deepEqual([feed.changes[0].op, feed.changes[0].key, feed.changes[0].origin, feed.changes[0].sha256], ['put', 'UI/a.txt', 'dev1', result.sha256]);
        assert.equal(feed.cursorTooOld, false);

        const { data } = await index.resolveObject('workspace:home', 'UI/a.txt', {});
        assert.equal(data.toString(), 'alpha');
    });

    test('an edit is a succession: new document, placements migrated from the predecessor', async () => {
        const before = await index.statObject('workspace:home', 'UI/a.txt');
        const stale = await index.writeObject('workspace:home', 'UI/a.txt', 'beta', { ifMatch: 'ff'.repeat(32) });
        assert.equal(stale.ok, false);
        assert.equal(stale.reason, 'precondition-failed');
        assert.equal(stale.current.sha256, before.sha256);

        const result = await index.writeObject('workspace:home', 'UI/a.txt', 'beta', { ifMatch: before.sha256, origin: 'dev1' });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.previous.id, before.id);
        assert.equal(result.docId, 100002, 'new content = new document');
        assert.deepEqual(db.migrations, [[100001, 100002]], 'curated placements migrated predecessor → successor');
        const old = db.docs.get(100001);
        assert.deepEqual(old.locations, [], 'old document lost its only location');
        assert.ok(old.orphanedAt, 'and is orphaned, not deleted');
    });

    test('rename keeps the document, remove orphans it', async () => {
        const stat = await index.statObject('workspace:home', 'UI/a.txt');
        const renamed = await index.renameObject('workspace:home', 'UI/a.txt', 'UI/b.txt', { origin: 'dev1' });
        assert.equal(renamed.ok, true, JSON.stringify(renamed));
        assert.equal(renamed.docId, stat.docId);
        assert.equal(await exists(path.join(root, 'UI/b.txt')), true);
        assert.equal(db.docs.get(stat.docId).locations[0].url, 'stored://workspace:home/UI/b.txt');
        const feed = index.changes('workspace:home', { since: 0 });
        const last = feed.changes.at(-1);
        assert.deepEqual([last.op, last.key, last.from], ['rename', 'UI/b.txt', 'UI/a.txt']);

        const removed = await index.removeObject('workspace:home', 'UI/b.txt', { ifMatch: stat.sha256, origin: 'dev1' });
        assert.equal(removed.ok, true, JSON.stringify(removed));
        assert.equal(removed.docId, stat.docId);
        assert.equal(await exists(path.join(root, 'UI/b.txt')), false);
        await sleep(50);
        const doc = db.docs.get(stat.docId);
        assert.deepEqual(doc.locations, []);
        assert.ok(doc.orphanedAt);
        assert.equal(await index.statObject('workspace:home', 'UI/b.txt'), null);
    });

    test('keys are validated against internals, exclusions and traversal', async () => {
        await assert.rejects(() => index.writeObject('workspace:home', '.workspace/x', 'x'), (e) => e.code === 'KEY_INTERNAL' && e.statusCode === 409);
        await assert.rejects(() => index.writeObject('workspace:home', '.hidden/x', 'x'), (e) => e.code === 'KEY_EXCLUDED' && e.statusCode === 409);
        await assert.rejects(() => index.writeObject('workspace:home', '../x', 'x'), (e) => e.code === 'INVALID_KEY' && e.statusCode === 400);
        await assert.rejects(() => index.writeObject('nope', 'x', 'x'), (e) => e.code === 'BACKEND_NOT_FOUND' && e.statusCode === 404);
        await assert.rejects(() => index.writeObject('workspace:data', 'x', 'x'), (e) => e.code === 'UNSUPPORTED_BACKEND' && e.statusCode === 400);
        assert.equal(await exists(path.join(root, '.hidden')), false);
    });

    test('change-log advances nudge the workspace, throttled per backend', async () => {
        await sleep(350); // let a trailing nudge from the previous test fire
        nudges.length = 0;
        await Promise.all([
            index.writeObject('workspace:home', 'burst/1.txt', 'one'),
            index.writeObject('workspace:home', 'burst/2.txt', 'two'),
            index.writeObject('workspace:home', 'burst/3.txt', 'three'),
        ]);
        await sleep(450);
        assert.ok(nudges.length >= 1 && nudges.length <= 2, `leading + at most one trailing nudge, got ${nudges.length}`);
        assert.equal(nudges.at(-1).backend, 'workspace:home');
        assert.equal(nudges.at(-1).seq, index.listObjects('workspace:home').head, 'last nudge carries the log head');
    });
});
