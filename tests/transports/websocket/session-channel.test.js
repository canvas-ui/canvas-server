import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

import Workspace from '../../../src/core/workspace/Workspace.js';
import {
    WORKSPACE_LAYOUTS,
    workspaceInternals,
    workspaceServices,
} from '../../../src/core/workspace/lib/constants.js';
import registerSessionWebSocket from '../../../src/transports/websocket/channels/session.js';

/**
 * The session RPC channel — the one request/response surface on a transport
 * that is otherwise push-only fan-out.
 *
 * Driven through a stub socket rather than a live socket.io server: what is
 * under test is the channel's contract (ack envelopes, scoping, lifecycle), and
 * a real workspace behind it keeps the query results honest.
 */

const WS_ID = 'e1a4a0ce-0000-4000-8000-000000000001';

// Scoped FTS was bounded by the candidate-set SIZE before synapsd 3.2.1, so a
// narrow scope (one camera frame's survivors) usually searched to nothing. The
// test below is the regression gate for that fix; it self-activates as soon as
// the pin advances, rather than sitting red in CI in the meantime.
const SCOPED_FTS_FIXED_IN = [3, 2, 1];
const synapsdVersion = createRequire(import.meta.url)('canvas-synapsd/package.json').version;
const scopedFtsSkip = (() => {
    const v = String(synapsdVersion).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((v[i] ?? 0) > SCOPED_FTS_FIXED_IN[i]) { return false; }
        if ((v[i] ?? 0) < SCOPED_FTS_FIXED_IN[i]) {
            return `needs canvas-synapsd >= ${SCOPED_FTS_FIXED_IN.join('.')} (have ${synapsdVersion}) — run npm run deps:bump`;
        }
    }
    return false;
})();

function makeSocket(user = { id: 'user-1', email: 'u@example.com' }) {
    const handlers = new Map();
    return {
        id: 'socket-1',
        user,
        subscriptions: new Set(),
        emitted: [],
        on(event, handler) { handlers.set(event, handler); },
        emit(event, payload) { this.emitted.push({ event, payload }); },
        // Test-side driver: invoke an RPC and resolve its ack envelope.
        call(event, data) {
            const handler = handlers.get(event);
            if (!handler) { throw new Error(`No handler registered for ${event}`); }
            return new Promise((resolve) => { void handler(data, resolve); });
        },
        fire(event, data) { return handlers.get(event)?.(data); },
    };
}

describe('session websocket channel', () => {
    let root;
    let ws;
    let fastify;

    const putNote = async (title, contextPath) => await ws.put(
        { schema: 'data/schema/note', data: { title, content: title } },
        { context: contextPath, directory: null },
    );

    before(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-session-ch-'));
        const store = {
            id: WS_ID,
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

        fastify = {
            workspaceManager: {
                resolveWorkspaceId: (userId, name) => (userId === 'user-1' && name === 'ws' ? WS_ID : null),
                getWorkspaceOrThrow: async (workspaceId, userId) => {
                    if (workspaceId !== WS_ID) { throw new Error(`Workspace not found: ${workspaceId}`); }
                    if (userId !== 'user-1') { throw new Error('Access denied'); }
                    return ws;
                },
            },
        };
    });

    after(async () => {
        await ws?.stop().catch(() => {});
        if (root) { await fs.remove(root); }
    });

    test('open answers with the session id and its current survivor set', async () => {
        const id = await putNote('scoped', '/rpc');
        const socket = makeSocket();
        registerSessionWebSocket(fastify, socket);

        const res = await socket.call('session.open', { workspace: 'ws', specs: [{ label: 'scope', spec: { context: '/rpc' } }] });
        assert.equal(res.status, 'success');
        assert.ok(res.payload.sessionId);
        assert.deepEqual(res.payload.ids, [id]);
        assert.equal(res.payload.count, 1);

        await socket.call('session.close', { sessionId: res.payload.sessionId });
    });

    test('set replaces a cue and a write pushes a delta', async () => {
        const a = await putNote('delta a', '/rpc2');
        const socket = makeSocket();
        registerSessionWebSocket(fastify, socket);

        const { payload: opened } = await socket.call('session.open', {
            workspace: 'ws',
            specs: [{ label: 'scope', spec: { context: '/rpc2' } }],
            opts: { mode: 'live', debounceMs: 0 },
        });

        const set = await socket.call('session.set', { sessionId: opened.sessionId, label: 'lens', spec: { ids: [a] } });
        assert.equal(set.status, 'success');
        assert.deepEqual(set.payload.ids, [a]);

        // The lens cue now pins exactly {a}, so a document arriving in /rpc2
        // must NOT enter the set — that AND is the whole point of a session.
        const b = await putNote('delta b', '/rpc2');
        await socket.call('session.remove', { sessionId: opened.sessionId, label: 'lens' });
        const state = await socket.call('session.ids', { sessionId: opened.sessionId });
        assert.deepEqual(state.payload.ids, [a, b]);

        const deltas = socket.emitted.filter((e) => e.event === 'session.delta');
        assert.ok(deltas.length > 0, 'mutations and writes push session.delta');
        assert.equal(deltas.at(-1).payload.sessionId, opened.sessionId);

        await socket.call('session.close', { sessionId: opened.sessionId });
    });

    test('materialize without a match is a plain page of the candidate set', async () => {
        const a = await putNote('page one', '/mat');
        const b = await putNote('page two', '/mat');
        const socket = makeSocket();
        registerSessionWebSocket(fastify, socket);

        const { payload: opened } = await socket.call('session.open', {
            workspace: 'ws',
            specs: [{ label: 'scope', spec: { context: '/mat' } }],
        });

        const page = await socket.call('session.materialize', { sessionId: opened.sessionId, limit: 10 });
        assert.equal(page.status, 'success');
        assert.deepEqual(page.payload.ids.slice().sort((x, y) => x - y), [a, b]);
        assert.equal(page.payload.totalCount, 2);
        assert.equal(page.payload.documents.length, 2);

        await socket.call('session.close', { sessionId: opened.sessionId });
    });

    test('text belongs to the match, not to a cue — cues reject it loudly', async () => {
        const socket = makeSocket();
        registerSessionWebSocket(fastify, socket);

        // Silently dropping the term would leave the user staring at unfiltered
        // results wondering why their search box does nothing.
        const opened = await socket.call('session.open', {
            workspace: 'ws',
            specs: [{ label: 'scope', spec: { context: '/mat', query: 'broken door' } }],
        });
        assert.equal(opened.status, 'error');
        assert.match(opened.message, /session\.materialize/);

        const { payload } = await socket.call('session.open', { workspace: 'ws', specs: [{ label: 'scope', spec: { context: '/mat' } }] });
        const set = await socket.call('session.set', { sessionId: payload.sessionId, label: 'lens', spec: { q: 'broken door' } });
        assert.equal(set.status, 'error');
        assert.match(set.message, /no text/i);

        await socket.call('session.close', { sessionId: payload.sessionId });
    });

    test('ranking re-evaluates against a MOVING candidate set', { skip: scopedFtsSkip }, async () => {
        // Two documents a human commented "broken door" on, in two places. The
        // camera moving is modelled by replacing the id-set cue — exactly what
        // the lens does per frame.
        const here = await ws.put(
            { schema: 'data/schema/note', data: { title: 'entrance A', content: 'a' }, comment: 'broken door hinge' },
            { context: '/live-rank', directory: null },
        );
        const there = await ws.put(
            { schema: 'data/schema/note', data: { title: 'entrance B', content: 'b' }, comment: 'broken door frame' },
            { context: '/live-rank', directory: null },
        );

        const socket = makeSocket();
        registerSessionWebSocket(fastify, socket);
        const { payload: opened } = await socket.call('session.open', {
            workspace: 'ws',
            specs: [{ label: 'scope', spec: { context: '/live-rank' } }],
            opts: { mode: 'live', debounceMs: 0 },
        });

        const rank = async () => {
            const res = await socket.call('session.materialize', {
                sessionId: opened.sessionId, match: { text: 'broken door' }, limit: 10, mode: 'fts',
            });
            assert.equal(res.status, 'success', res.message);
            return res.payload.ids;
        };

        await socket.call('session.set', { sessionId: opened.sessionId, label: 'lens', spec: { ids: [here] } });
        assert.deepEqual(await rank(), [here]);

        // The frame now sees the OTHER door. Re-ranking must follow the cue —
        // a ranking pinned from the first frame would have kept `here` and
        // never surfaced `there`.
        await socket.call('session.set', { sessionId: opened.sessionId, label: 'lens', spec: { ids: [there] } });
        assert.deepEqual(await rank(), [there]);

        await socket.call('session.close', { sessionId: opened.sessionId });
    });

    test('unknown sessions and workspaces fail with an error envelope, never a throw', async () => {
        const socket = makeSocket();
        registerSessionWebSocket(fastify, socket);

        const missing = await socket.call('session.ids', { sessionId: 'nope' });
        assert.equal(missing.status, 'error');
        assert.match(missing.message, /No such session/);

        const denied = await socket.call('session.open', { workspace: 'someone-elses-ws', specs: [] });
        assert.equal(denied.status, 'error');
        assert.match(denied.message, /not found/i);
    });

    test('a share-token socket may only open its bound workspace', async () => {
        const socket = makeSocket();
        socket.workspaceBinding = { workspaceId: WS_ID, workspaceName: 'ws', permissions: ['read'] };
        registerSessionWebSocket(fastify, socket);

        const allowed = await socket.call('session.open', { workspace: 'ws', specs: [] });
        assert.equal(allowed.status, 'success');
        await socket.call('session.close', { sessionId: allowed.payload.sessionId });

        const other = await socket.call('session.open', { workspace: 'other-ws', specs: [] });
        assert.equal(other.status, 'error');
        assert.match(other.message, /not bound/);
    });

    test('disconnect closes every session the socket left open', async () => {
        const socket = makeSocket();
        registerSessionWebSocket(fastify, socket);
        const { payload } = await socket.call('session.open', { workspace: 'ws', specs: [] });

        socket.fire('disconnect');

        // The registry is gone, so the id no longer resolves — and the
        // underlying QuerySession has been closed (no db subscription left).
        const after = await socket.call('session.ids', { sessionId: payload.sessionId });
        assert.equal(after.status, 'error');
    });
});
