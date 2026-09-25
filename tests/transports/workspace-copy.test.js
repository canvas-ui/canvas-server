import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import documentRoutes from '../../src/transports/routes/workspaces/documents.js';

async function setup(t, permissions = ['read'], resourceToken = null) {
    const app = Fastify();
    const auth = async request => { request.user = { id: 'user' }; request.resourceToken = resourceToken; };
    app.decorate('authenticate', auth);
    app.decorate('authenticateClient', auth);
    app.decorate('workspaceManager', {
        resolveWorkspaceId: async (_user, id) => id,
        getWorkspace: async (id, user) => { assert.equal(user, 'user'); return { id, isActive: true }; },
        resolveWorkspaceAccess: async () => ({ permissions, isOwner: false }),
    });
    await app.register(documentRoutes, { prefix: '/:id/documents' });
    t.after(() => app.close());
    return app;
}
const payload = { documentId: 7, destination: 'destination', context: ['/'], operationId: 'job-1' };
test('destination read-only access cannot copy', async t => {
    const app = await setup(t);
    const response = await app.inject({ method: 'POST', url: '/source/documents/copy-to-workspace', payload });
    assert.equal(response.statusCode, 403);
});
test('resource-bound token cannot use owner access across workspaces', async t => {
    const app = await setup(t, ['read', 'write'], { type: 'agent' });
    const response = await app.inject({ method: 'POST', url: '/source/documents/copy-to-workspace', payload });
    assert.equal(response.statusCode, 403);
});
test('same-workspace copy is rejected before writing', async t => {
    const app = await setup(t, ['read', 'write']);
    const response = await app.inject({ method: 'POST', url: '/source/documents/copy-to-workspace', payload: { ...payload, destination: 'source' } });
    assert.equal(response.statusCode, 400);
});


test('authorized copy inserts into the chosen destination virtual tree', async t => {
    const app = await setup(t, ['read', 'write']);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-route-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const calls = [];
    app.workspaceManager.getWorkspace = async id => id === 'source'
        ? { id, isActive: true, get: async () => ({ id: 7, schema: 'data/schema/note', data: { content: 'Copy me' } }) }
        : { id, isActive: true, varPath: root,
            getContextTreeSelector: (paths, tree) => ({ tree, paths }),
            put: async (document, spec) => { calls.push({ document, spec }); return 88; },
        };
    const request = { method: 'POST', url: '/source/documents/copy-to-workspace', payload: { ...payload, context: ['/Work/New'], treeNameOrTreeId: 'context' } };
    const response = await app.inject(request);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().payload.destinationId, 88);
    assert.deepEqual(calls[0].spec, { context: { tree: 'context', paths: ['/Work/New'] }, directory: null });
    assert.equal(calls[0].document.id, undefined);
    assert.equal(calls[0].document.data.content, 'Copy me');
    await app.inject(request);
    assert.equal(calls.length, 1);
});
