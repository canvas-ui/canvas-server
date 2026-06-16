import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import workspaceDataBackendRoutes from './data-backends.js';

describe('workspace data backend routes', () => {
    let app;
    let workspace;

    beforeEach(async () => {
        workspace = {
            getDataBackendStatus() {
                return { 'workspace:home': { enabled: true, root: '/tmp/workspace/home', resync: true } };
            },
            setDataBackendConfig(backendName, config) {
                this.lastBackendUpdate = { backendName, config };
            },
            async startHomeService() {},
            async stopHomeService() {},
            async resyncDataBackend(backendName) {
                return { backend: backendName, count: 3 };
            },
        };

        app = Fastify();
        app.decorate('authenticate', async (request) => {
            request.user = { id: 'user-id' };
        });
        app.decorate('workspaceManager', {
            resolveWorkspaceId: () => 'workspace-id',
            getWorkspace: async () => workspace,
        });
        app.addHook('preHandler', async (request) => {
            request.workspace = workspace;
            request.workspaceAccess = { isOwner: true, permissions: ['read', 'write', 'admin'] };
        });
        app.register(workspaceDataBackendRoutes, { prefix: '/workspaces/:id/data-backends' });
        await app.ready();
    });

    afterEach(async () => {
        await app.close();
    });

    test('lists backend status', async () => {
        const response = await app.inject({ method: 'GET', url: '/workspaces/universe/data-backends', headers: { authorization: 'Bearer jwt' } });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().payload['workspace:home'].root, '/tmp/workspace/home');
    });

    test('patches backend config', async () => {
        const response = await app.inject({
            method: 'PATCH',
            url: '/workspaces/universe/data-backends',
            headers: { authorization: 'Bearer jwt' },
            payload: { dataBackends: { 'workspace:home': { enabled: false } } },
        });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(workspace.lastBackendUpdate, { backendName: 'workspace:home', config: { enabled: false } });
    });

    test('resyncs backend', async () => {
        const response = await app.inject({ method: 'POST', url: '/workspaces/universe/data-backends/workspace%3Ahome/resync', headers: { authorization: 'Bearer jwt' } });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json().payload, { backend: 'workspace:home', count: 3 });
    });
});
