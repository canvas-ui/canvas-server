import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import workspaceSyncRoutes from '../../../../src/transports/routes/workspaces/sync.js';

describe('workspace sync conflict routes', () => {
    let app;
    let calls;

    beforeEach(async () => {
        calls = [];
        const workspace = {
            async listSyncConflicts() { calls.push(['list']); return [{ docId: 100007, key: 'Docs/c.txt', resolvable: true }]; },
            async resolveSyncConflict(docId, options) {
                calls.push(['resolve', docId, options]);
                if (docId === 404) throw Object.assign(new Error('nope'), { code: 'NOT_FOUND', statusCode: 404 });
                return { docId, keep: options.keep, survivorDocId: docId };
            },
        };
        app = Fastify();
        app.decorate('authenticate', async (request) => { request.user = { id: 'user-id' }; });
        app.decorate('workspaceManager', { resolveWorkspaceId: () => 'workspace-id', getWorkspace: async () => workspace });
        app.addHook('preHandler', async (request) => {
            request.workspace = workspace;
            request.workspaceAccess = { isOwner: true, permissions: ['read', 'write', 'admin'] };
        });
        app.register(workspaceSyncRoutes, { prefix: '/workspaces/:id/sync' });
        await app.ready();
    });

    afterEach(async () => { await app.close(); });

    const inject = (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: 'Bearer jwt' } });

    test('GET conflicts', async () => {
        const res = await inject('GET', '/workspaces/universe/sync/conflicts');
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().count, 1);
        assert.equal(res.json().payload[0].docId, 100007);
    });

    test('POST resolve validates keep and maps typed errors', async () => {
        const ok = await inject('POST', '/workspaces/universe/sync/conflicts/100007/resolve', { keep: 'both' });
        assert.equal(ok.statusCode, 200, ok.body);
        assert.deepEqual(calls.at(-1), ['resolve', 100007, { keep: 'both' }]);
        const bad = await inject('POST', '/workspaces/universe/sync/conflicts/100007/resolve', { keep: 'maybe' });
        assert.equal(bad.statusCode, 400);
        const missing = await inject('POST', '/workspaces/universe/sync/conflicts/404/resolve', { keep: 'hub' });
        assert.equal(missing.statusCode, 404);
        assert.equal(missing.json().code, 'NOT_FOUND');
    });
});
