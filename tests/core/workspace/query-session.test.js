import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

import Workspace from '../../../src/core/workspace/Workspace.js';
import {
    WORKSPACE_LAYOUTS,
    workspaceInternals,
    workspaceServices,
} from '../../../src/core/workspace/lib/constants.js';

/**
 * Workspace.openSession — the seam between the workspace's query vocabulary
 * (context/directory selectors, canvas querySpec folding) and synapsd's
 * QuerySession (which speaks the ctx:/dir: paths grammar and knows nothing
 * about trees).
 *
 * What must hold:
 *   - a cue written in workspace terms ({ context: '/work' }) resolves like the
 *     equivalent list() call would;
 *   - set() is the streaming verb: re-emitting an id-set cue REPLACES it (a
 *     merge would accumulate every frame the lens ever saw);
 *   - a write lands as a delta on the open session, without a re-query;
 *   - stop() closes sessions — they hold a db subscription, and one surviving
 *     shutdown would fire against a torn-down handle.
 */

const note = (title) => ({ schema: 'data/schema/note', data: { title, content: title } });

describe('workspace query sessions', () => {
    let root;
    let ws;

    const ctxSel = (p) => ({ context: p, directory: null });
    // put() answers with the document id it resolved to (a re-put of identical
    // content lands on the SAME document — identity is the checksum).
    const putNote = async (title, contextPath) => await ws.put(note(title), ctxSel(contextPath));

    before(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-session-'));
        const store = {
            id: 'ws-session-1',
            name: 'ws',
            owner: 'user-1',
            layout: WORKSPACE_LAYOUTS.FULL,
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
    });

    after(async () => {
        await ws?.stop().catch(() => {});
        if (root) { await fs.remove(root); }
    });

    test('a cue in workspace terms scopes the session like list() would', async () => {
        const inScope = await putNote('in scope', '/work');
        await putNote('out of scope', '/elsewhere');

        const session = await ws.openSession({ context: '/work' });
        try {
            assert.deepEqual(session.ids(), [inScope]);
            assert.equal(await session.count(), 1);
        } finally {
            session.close();
        }
    });

    test('set() replaces an id-set cue instead of accumulating it', async () => {
        const a = await putNote('lens a', '/lens');
        const b = await putNote('lens b', '/lens');

        const session = await ws.openSession([{ label: 'base', spec: { context: '/lens' } }]);
        try {
            await session.set('lens', { ids: [a] });
            assert.deepEqual(session.ids(), [a]);

            // The next "frame" sees only b. A patch() would union the two id
            // sets; set() is the verb a streaming producer must use.
            await session.set('lens', { ids: [b] });
            assert.deepEqual(session.ids(), [b]);
        } finally {
            session.close();
        }
    });

    test('a write lands as a delta on the open session', async () => {
        const seeded = await putNote('already here', '/live');

        const session = await ws.openSession({ context: '/live' }, { mode: 'live', debounceMs: 0 });
        try {
            const delta = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('no delta within 5s')), 5000);
                session.on('change', (payload) => { clearTimeout(timer); resolve(payload); });
                void putNote('arrived later', '/live');
            });

            assert.equal(delta.added.length, 1);
            assert.deepEqual(delta.removed, []);
            assert.equal(delta.count, 2);
            assert.deepEqual(session.ids(), [seeded, ...delta.added]);
        } finally {
            session.close();
        }
    });

    test('buildMatch shapes the ranking stage: text alone, image alone, or fused', async () => {
        // Nothing to rank by → null, and materialize takes the cheap listing
        // path (bitmap slice, no Lance).
        assert.equal(await ws.buildMatch({}), null);
        assert.equal(await ws.buildMatch({ text: '   ' }), null);

        // Text alone stays the classic string match (fts/vector/hybrid).
        assert.equal(await ws.buildMatch({ text: '  broken door  ' }), 'broken door');

        // An image needs an embedding: without inferd this must fail loudly
        // rather than silently ranking by text only.
        await assert.rejects(
            () => ws.buildMatch({ text: 'broken door', imageBytes: Buffer.from([1, 2, 3]) }),
            /inferd/i,
        );

        // similarTo reuses a stored vector — a note has none.
        const noteId = await putNote('no image vector', '/match');
        await assert.rejects(() => ws.buildMatch({ similarTo: noteId }), /no image-space vector/);
    });

    /**
     * The house-build scenario, minus inferd: cues narrow to a place (and, in
     * the field, a GPS fix and the camera frame's kNN survivors), then a text
     * match picks out the one document a human COMMENTED "broken door" on.
     *
     * The comment is the point. A photo declares no ftsSearchFields, so without
     * Document.generateFtsData folding `comment` (and the generated
     * metadata.summary) in unconditionally, a captioned or annotated photo
     * would be lexically invisible and this whole flow would silently return
     * nothing.
     */
    test('a text match resurfaces a document by its comment, scoped to the cues', async () => {
        const doorPhoto = await ws.put(
            { schema: 'data/schema/note', data: { title: 'front entrance', content: 'entrance' }, comment: 'broken door, hinge sheared' },
            ctxSel('/project-foo'),
        );
        await putNote('gardening: hedge planting plan', '/project-foo');
        // Same words, different place — the cue must keep it out.
        await ws.put(
            { schema: 'data/schema/note', data: { title: 'other site', content: 'other' }, comment: 'broken door at the other site' },
            ctxSel('/project-bar'),
        );

        const session = await ws.openSession({ context: '/project-foo' });
        try {
            const scoped = session.ids();
            assert.ok(scoped.includes(doorPhoto), 'the cue holds the commented doc');
            assert.equal(scoped.length, 2, 'and only /project-foo docs');

            // fts mode = strict lexical narrowing within the candidate set.
            const page = await session.materialize('broken door', { limit: 10, mode: 'fts' });
            if (page.error) {
                // No Lance in this environment — the cue stage above is still
                // meaningful, so report rather than fail the suite silently.
                assert.match(page.error, /FTS not initialized/);
                return;
            }
            const ids = [...page].map((d) => d.id);
            assert.ok(ids.includes(doorPhoto), 'the comment is searchable text');
            assert.equal(ids.length, 1, 'the gardening doc and the other site are both excluded');
        } finally {
            session.close();
        }
    });

    test('close() deregisters and stop() closes whatever is left open', async () => {
        const closed = await ws.openSession({ context: '/' });
        const leaked = await ws.openSession({ context: '/' });
        closed.close();

        await ws.stop();
        // Both are torn down: the explicitly closed one by its own call, the
        // other by stop(). A closed session refuses further reads.
        assert.throws(() => leaked.ids(), /closed/i);
        assert.throws(() => closed.ids(), /closed/i);

        await ws.start();
    });
});
