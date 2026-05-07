import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import workspaceServicesRoutes from './services.js';

describe('workspace data backend service routes', () => {
    let app;
    let workspace;

    beforeEach(async () => {
        workspace = {
            id: 'workspace-id',
            getDataBackendStatus() {
                return {
                    'fs:home': {
                        enabled: true,
                        supported: true,
                        root: '/tmp/workspace/home',
                        watch: true,
                        resync: true,
                    },
                };
            },
            setDataBackendConfig(backendName, config) {
                this.lastBackendUpdate = { backendName, config };
            },
            async startHomeService() {},
            async stopHomeService() {},
            async resyncDataBackend(backendName) {
                return { backend: backendName, count: 2 };
            },
        };

        app = Fastify();
        app.decorate('authenticate', async (request) => {
            request.user = { id: 'user-id' };
        });
        app.decorate('workspaceManager', {
            resolveWorkspaceId: () => workspace.id,
            getWorkspace: async () => workspace,
            getServicesStatus: async () => ({}),
            enableService: async () => true,
            disableService: async () => true,
        });
        app.register(workspaceServicesRoutes, { prefix: '/:id/services' });
        await app.ready();
    });

    afterEach(async () => {
        await app.close();
    });

    test('GET /data-backends returns backend status', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/test/services/data-backends',
            headers: { authorization: 'Bearer jwt' },
        });

        assert.equal(response.statusCode, 200);
        assert.equal(response.json().payload['fs:home'].root, '/tmp/workspace/home');
    });

    test('PATCH /data-backends stores backend updates', async () => {
        const response = await app.inject({
            method: 'PATCH',
            url: '/test/services/data-backends',
            headers: { authorization: 'Bearer jwt' },
            payload: { dataBackends: { 'fs:home': { enabled: false } } },
        });

        assert.equal(response.statusCode, 200);
        assert.deepEqual(workspace.lastBackendUpdate, {
            backendName: 'fs:home',
            config: { enabled: false },
        });
    });

    test('POST /data-backends/:backendId/resync runs resync', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/test/services/data-backends/fs%3Ahome/resync',
            headers: { authorization: 'Bearer jwt' },
        });

        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json().payload, { backend: 'fs:home', count: 2 });
    });
});
