import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import workspaceBackendRoutes from './backends.js';

describe('workspace unified backend routes', () => {
    let app;
    let workspace;
    let calls;

    beforeEach(async () => {
        calls = [];
        const record = (name) => (...args) => { calls.push({ name, args }); };
        workspace = {
            async listBackends() {
                record('listBackends')();
                return [
                    { driver: 'file', address: 'workspace:home', kind: 'storage', capabilities: { sync: true } },
                    { driver: 'imap', address: 'me@host.tld', kind: 'messages', capabilities: { sync: true, containers: true } },
                ];
            },
            async listBackendsByDriver(driver) {
                record('listBackendsByDriver')(driver);
                return (await this.listBackends()).filter((b) => b.driver === driver);
            },
            async getBackend(driver, address) {
                record('getBackend')(driver, address);
                return { driver, address, kind: driver === 'imap' ? 'messages' : 'storage' };
            },
            async addBackend(driver, config) { record('addBackend')(driver, config); return { driver, address: config.address || 'new' }; },
            async updateBackend(driver, address, patch) { record('updateBackend')(driver, address, patch); return { driver, address }; },
            async removeBackend(driver, address) { record('removeBackend')(driver, address); return true; },
            async syncBackend(driver, address) { record('syncBackend')(driver, address); return { driver, address, synced: true }; },
            async testBackend(driver, address) { record('testBackend')(driver, address); return { ok: true }; },
            async listBackendContainers(driver, address) { record('listBackendContainers')(driver, address); return [{ name: 'INBOX' }]; },
            async syncBackendContainer(driver, address, name) { record('syncBackendContainer')(driver, address, name); return { name, synced: true }; },
        };

        app = Fastify();
        app.decorate('authenticate', async (request) => { request.user = { id: 'user-id' }; });
        app.decorate('workspaceManager', {
            resolveWorkspaceId: () => 'workspace-id',
            getWorkspace: async () => workspace,
        });
        app.addHook('preHandler', async (request) => {
            request.workspace = workspace;
            request.workspaceAccess = { isOwner: true, permissions: ['read', 'write', 'admin'] };
        });
        app.register(workspaceBackendRoutes, { prefix: '/workspaces/:id/backends' });
        await app.ready();
    });

    afterEach(async () => { await app.close(); });

    const get = (url) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer jwt' } });
    const post = (url, payload) => app.inject({ method: 'POST', url, headers: { authorization: 'Bearer jwt' }, payload });
    const called = (name) => calls.find((c) => c.name === name)?.args;

    test('GET / lists every driver', async () => {
        const res = await get('/workspaces/universe/backends');
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().payload.length, 2);
        assert.equal(res.json().count, 2);
    });

    test('GET /:driver filters by driver', async () => {
        const res = await get('/workspaces/universe/backends/imap');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(called('listBackendsByDriver'), ['imap']);
        assert.equal(res.json().payload.length, 1);
    });

    test('GET /:driver/:address decodes the address segment', async () => {
        const res = await get('/workspaces/universe/backends/imap/me%40host.tld');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(called('getBackend'), ['imap', 'me@host.tld']);
    });

    test('POST /:driver/:address/sync dispatches with decoded args', async () => {
        const res = await post('/workspaces/universe/backends/imap/me%40host.tld/sync');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(called('syncBackend'), ['imap', 'me@host.tld']);
        assert.equal(res.json().payload.synced, true);
    });

    test('storage address with a colon round-trips', async () => {
        const res = await post('/workspaces/universe/backends/file/workspace%3Ahome/sync');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(called('syncBackend'), ['file', 'workspace:home']);
    });

    test('POST /:driver/:address/test', async () => {
        const res = await post('/workspaces/universe/backends/imap/me%40host.tld/test');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(called('testBackend'), ['imap', 'me@host.tld']);
    });

    test('GET containers + per-container sync (name decoded)', async () => {
        const list = await get('/workspaces/universe/backends/imap/me%40host.tld/containers');
        assert.equal(list.statusCode, 200);
        assert.equal(list.json().payload[0].name, 'INBOX');

        const sync = await post('/workspaces/universe/backends/imap/me%40host.tld/containers/Sent%20Items/sync');
        assert.equal(sync.statusCode, 200);
        assert.deepEqual(called('syncBackendContainer'), ['imap', 'me@host.tld', 'Sent Items']);
    });

    test('facade errors surface as an error response', async () => {
        workspace.syncBackend = async () => { throw new Error('No IMAP mailbox found for account "ghost"'); };
        const res = await post('/workspaces/universe/backends/imap/ghost/sync');
        assert.equal(res.statusCode >= 400, true);
        assert.match(res.json().message || res.json().error || '', /No IMAP mailbox/);
    });

    test('add + update + remove delegate to the facade', async () => {
        await post('/workspaces/universe/backends/imap', { host: 'x', user: 'me@host.tld', password: 'p' });
        assert.equal(called('addBackend')[0], 'imap');

        await app.inject({ method: 'PATCH', url: '/workspaces/universe/backends/imap/me%40host.tld', headers: { authorization: 'Bearer jwt' }, payload: { enabled: false } });
        assert.deepEqual(called('updateBackend').slice(0, 2), ['imap', 'me@host.tld']);

        await app.inject({ method: 'DELETE', url: '/workspaces/universe/backends/imap/me%40host.tld', headers: { authorization: 'Bearer jwt' } });
        assert.deepEqual(called('removeBackend'), ['imap', 'me@host.tld']);
    });
});
