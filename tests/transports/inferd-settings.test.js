import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import inferdRoutes from '../../src/transports/routes/inferd.js';

async function setup(t, overrides = {}) {
    const calls = [];
    const inferd = {
        async contextFor(id) { assert.equal(id, 'alice'); return { config: { spaces: { text: { model: 'inherited' } } } }; },
        async serverConfig() { return { allowHosts: ['approved.local'] }; },
        async redactConfig(value) { return value; },
        async validate(value) { return value; },
        async checkConfigEndpoints(_config, policy) { calls.push(['policy', policy]); return []; },
        async invalidateUser(id) { calls.push(['invalidate', id]); },
        async workspacesOf(id) { assert.equal(id, 'alice'); return ['photos']; },
        async endpointFor() { return { value: 'https://approved.local/v1' }; },
        async checkEndpoint(_url, policy) { calls.push(['policy', policy]); return { ok: true }; },
        async testProvider(_spec, options) { calls.push(['test', options]); return options.probe ? { cached: false, modality: options.modality } : { ok: true, dim: 512, modality: options.modality }; },
        ...overrides,
    };
    const app = Fastify();
    app.decorate('authenticate', async request => { request.user = { id: 'alice' }; });
    app.decorate('workspaceManager', { inferd });
    app.decorate('users', { get: async () => ({ userType: 'user' }) });
    app.decorate('userConfig', { read: async () => ({}), write: async (...args) => calls.push(['write', ...args]) });
    await app.register(inferdRoutes);
    t.after(() => app.close());
    return { app, calls };
}

test('account settings read effective defaults through asynchronous daemon methods', async t => {
    const { app } = await setup(t);
    const response = await app.inject('/config');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().payload.effective.spaces.text.model, 'inherited');
});

test('account save awaits invalidation and affected workspaces and forwards the host policy', async t => {
    const { app, calls } = await setup(t);
    const response = await app.inject({ method: 'PUT', url: '/config', payload: { spaces: {} } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().payload.workspaces, ['photos']);
    assert.equal(response.json().payload.restartRequired, true);
    assert.deepEqual(calls.map(c => c[0]), ['policy', 'write', 'invalidate']);
    assert.deepEqual(calls[0][1], { allowHosts: ['approved.local'] });
});

test('provider test and cache probe return daemon results without transferring live providers', async t => {
    const { app, calls } = await setup(t);
    for (const probe of [true, false]) {
        const response = await app.inject({ method: 'POST', url: '/test', payload: { provider: { type: 'clip' }, model: 'clip-model', modality: 'image', probe } });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().payload.modality, 'image');
        assert.equal(response.json().payload[probe ? 'cached' : 'ok'], !probe);
    }
    assert.deepEqual(calls.find(c => c[0] === 'policy')[1], { allowHosts: ['approved.local'] });
    assert.equal(calls.filter(c => c[0] === 'test').length, 2);
});

test('endpoint rejection prevents a provider test', async t => {
    const { app, calls } = await setup(t, { checkEndpoint: async () => ({ ok: false, reason: 'host not allowed' }) });
    const response = await app.inject({ method: 'POST', url: '/test', payload: { provider: { type: 'openai' } } });
    assert.equal(response.statusCode, 400);
    assert.equal(calls.some(c => c[0] === 'test'), false);
});
