import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import workspaceMirrorRoutes from '../../../../src/transports/routes/workspaces/mirrors.js';

describe('workspace mirror routes', () => {
    let app;
    let registry;
    let client;

    beforeEach(async () => {
        client = null;
        registry = {
            records: {},
            async listMirrorsForWorkspace(userId, wsId) {
                return Object.values(this.records).filter((r) => r.mirror.workspaceId === wsId);
            },
            async updateMirrorStatus(userId, deviceId, wsId, patch) {
                if (deviceId === 'ghost') throw Object.assign(new Error('Device "ghost" not found'), { statusCode: 404, code: 'DEVICE_NOT_FOUND' });
                const mirror = { ...(this.records[deviceId]?.mirror || {}), ...patch, workspaceId: wsId };
                this.records[deviceId] = { deviceId, name: deviceId, mirror };
                return mirror;
            },
            async removeMirror(userId, deviceId, wsId) { const had = !!this.records[deviceId]; delete this.records[deviceId]; return had; },
        };
        const workspace = {
            id: 'ws-1', name: 'universe',
            async backendChanges() { return { changes: [], head: 42 }; },
        };
        app = Fastify();
        app.decorate('authenticate', async (request) => { request.user = { id: 'user-id' }; if (client) request.client = client; });
        app.decorate('deviceRegistry', registry);
        app.decorate('workspaceManager', { resolveWorkspaceId: () => 'ws-1', getWorkspace: async () => workspace });
        app.addHook('preHandler', async (request) => {
            request.workspace = workspace;
            request.workspaceAccess = { isOwner: true, permissions: ['read', 'write', 'admin'] };
        });
        app.register(workspaceMirrorRoutes, { prefix: '/workspaces/:id/mirrors' });
        await app.ready();
    });

    afterEach(async () => { await app.close(); });

    const inject = (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: 'Bearer jwt' } });

    test('status report → listing with lag', async () => {
        const res = await inject('POST', '/workspaces/universe/mirrors/laptop/status', { client: 'fuse', path: '/home/me/Workspaces/universe', cursor: 40, pending: 2, conflicts: 1, state: 'syncing' });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(res.json().payload.head, 42);
        assert.equal(res.json().payload.mirror.backend, 'workspace:home');
        assert.equal(res.json().payload.mirror.workspaceName, 'universe');

        const list = await inject('GET', '/workspaces/universe/mirrors');
        assert.equal(list.statusCode, 200);
        assert.equal(list.json().payload.length, 1);
        assert.equal(list.json().payload[0].lag, 2);
        assert.equal(list.json().payload[0].head, 42);

        const gone = await inject('DELETE', '/workspaces/universe/mirrors/laptop');
        assert.equal(gone.statusCode, 200);
        assert.equal(gone.json().payload.removed, true);
        assert.equal((await inject('GET', '/workspaces/universe/mirrors')).json().payload.length, 0);
    });

    test('a device token may only report for itself (owner or not)', async () => {
        client = { deviceId: 'laptop', authMode: 'device' };
        const other = await inject('POST', '/workspaces/universe/mirrors/desktop/status', { cursor: 1 });
        assert.equal(other.statusCode, 403);
        assert.equal(other.json().code, 'DEVICE_MISMATCH');
        const own = await inject('POST', '/workspaces/universe/mirrors/laptop/status', { cursor: 1 });
        assert.equal(own.statusCode, 200);
    });

    test('unknown device → 404', async () => {
        const res = await inject('POST', '/workspaces/universe/mirrors/ghost/status', { cursor: 1 });
        assert.equal(res.statusCode, 404);
        assert.equal(res.json().code, 'DEVICE_NOT_FOUND');
    });
});
