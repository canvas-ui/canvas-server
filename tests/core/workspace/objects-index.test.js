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
        async getDocument(id) { return docs.get(Number(id)) ?? null; },
        async listDocumentTreePaths() { return []; },
        async migrateDocumentMemberships(from, to) { migrations.push([from, to]); },
        put(record) {
            let id = record.id;
            if (id == null) { id = nextId; nextId += 1; }
            // Row version is minted by the DB (synapsd 3.20+); this stand-in keeps every row at 1.
            const doc = { ...(docs.get(id) || {}), ...record, id, version: docs.get(id)?.version ?? 1 };
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

        const listing = await index.listObjects('workspace:home');
        assert.deepEqual(listing.objects.map((o) => o.key), ['UI/a.txt']);
        assert.equal(listing.objects[0].sha256, result.sha256);
        assert.ok(listing.head >= 1);

        const feed = await index.changes('workspace:home', { since: 0 });
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
        const feed = await index.changes('workspace:home', { since: 0 });
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

    test('If-Match: d<docId>.v<n> is resolved against the document at the key', async () => {
        const home = 'workspace:home';
        const first = await index.writeObject(home, 'versioned.txt', Buffer.from('one'), {});
        assert.equal(first.ok, true);
        assert.equal(first.version, 1, 'mutation results carry the row version');
        const stat = await index.statObject(home, 'versioned.txt');
        assert.equal(stat.docId, first.docId);
        assert.equal(stat.version, 1);

        // Wrong version → typed precondition failure carrying what is there.
        const stale = await index.writeObject(home, 'versioned.txt', Buffer.from('two'), { ifMatch: `d${first.docId}.v7` });
        assert.equal(stale.ok, false);
        assert.equal(stale.reason, 'precondition-failed');
        assert.equal(stale.current.docId, first.docId);
        assert.equal(stale.current.version, 1);

        // Right pair → the write goes through (an edit is a succession: new doc).
        const edited = await index.writeObject(home, 'versioned.txt', Buffer.from('two'), { ifMatch: `d${first.docId}.v1` });
        assert.equal(edited.ok, true);
        assert.notEqual(edited.docId, first.docId);
        assert.equal(edited.version, 1);

        // The old pair no longer matches even though its version number is "current".
        const crossed = await index.removeObject(home, 'versioned.txt', { ifMatch: `d${first.docId}.v1` });
        assert.equal(crossed.ok, false);
        assert.equal(crossed.reason, 'precondition-failed');
        assert.equal(crossed.current.docId, edited.docId);

        // Digest form is untouched by the resolver.
        const byDigest = await index.removeObject(home, 'versioned.txt', { ifMatch: edited.sha256 });
        assert.equal(byDigest.ok, true);
    });

    test('listing and feed carry docId/version; the replica table drives protection', async () => {
        const home = 'workspace:home';
        const a = await index.writeObject(home, 'Rep/a.txt', Buffer.from('alpha'), {});
        const b = await index.writeObject(home, 'Rep/b.txt', Buffer.from('beta'), {});
        const page = await index.listObjects(home, { prefix: 'Rep/' });
        const listed = Object.fromEntries(page.objects.map((o) => [o.key, o]));
        assert.equal(listed['Rep/a.txt'].docId, a.docId);
        assert.equal(listed['Rep/a.txt'].version, 1);
        const feed = await index.changes(home, { since: 0, limit: 1000 });
        const entry = feed.changes.findLast((c) => c.key === 'Rep/b.txt');
        assert.equal(entry.docId, b.docId);
        assert.equal(entry.version, 1);

        // Nothing reported yet: both required devices are behind on both documents.
        let p = await index.replicaProtection(home, { required: ['nas'], devices: ['nas', 'laptop'] });
        const only = (x) => ({ behind: x.replicas.nas.behind, held: x.replicas.nas.held, protectedCount: x.protected, unprotected: x.unprotected });
        assert.ok(p.total >= 2);
        assert.equal(p.replicas.nas.held, 0);
        assert.equal(p.replicas.laptop.held, 0);
        assert.equal(p.protected, 0);

        // The NAS reports a full snapshot holding both at their current version.
        assert.deepEqual(index.recordReplicaApplied('nas', [[a.docId, 1], [b.docId, 1]], { full: true }), { deviceId: 'nas', written: 2, full: true });
        assert.equal(index.replicaVersion('nas', a.docId), 1);
        p = await index.replicaProtection(home, { required: ['nas'], devices: ['nas', 'laptop'] });
        assert.equal(p.replicas.nas.held, 2);
        assert.equal(p.unprotected, p.total - p.unversioned - 2 - 0 >= 0 ? p.total - p.unversioned - 2 : 0);
        assert.ok(p.oldestUnprotected.every((o) => o.key !== 'Rep/a.txt' && o.key !== 'Rep/b.txt'));

        // A delta never lowers a recorded version; a stale pair is ignored.
        assert.equal(index.recordReplicaApplied('nas', [[a.docId, 0]]).written, 0);
        assert.equal(index.replicaVersion('nas', a.docId), 1);

        // Editing a.txt is a succession: a new document at version 1 that the NAS does not hold yet.
        const a2 = await index.writeObject(home, 'Rep/a.txt', Buffer.from('alpha 2'), {});
        assert.notEqual(a2.docId, a.docId);
        p = await index.replicaProtection(home, { required: ['nas'], sample: 50 });
        assert.ok(p.oldestUnprotected.some((o) => o.key === 'Rep/a.txt' && o.docId === a2.docId));
        index.recordReplicaApplied('nas', [[a2.docId, 1]]);
        p = await index.replicaProtection(home, { required: ['nas'], sample: 50 });
        assert.ok(!p.oldestUnprotected.some((o) => o.key === 'Rep/a.txt'));

        // Forgetting drops the evidence.
        assert.ok(index.forgetReplica('nas') >= 2);
        assert.equal(index.replicaVersion('nas', a2.docId), null);
        void only;
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
        assert.equal(nudges.at(-1).seq, (await index.listObjects('workspace:home')).head, 'last nudge carries the log head');
    });
});
