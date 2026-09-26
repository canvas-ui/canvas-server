import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import messageRoutes from '../../../src/transports/routes/workspaces/messages.js';
import backendRoutes from '../../../src/transports/routes/workspaces/backends.js';

test('messaging routes enforce workspace permissions and do not lend identities to share tokens', async (t) => {
    const calls = [];
    const workspace = {
        owner: 'owner', isActive: true,
        sendMessage: async (body, actor) => { calls.push({ body, actor }); return { status: 'accepted' }; },
        messageConnection: async () => { calls.push('pair'); return {}; },
        list: async () => [], messageReplyTarget: async () => ({ driver: 'imap', address: 'me' }),
    };
    const app = Fastify();
    t.after(() => app.close());
    app.decorate('workspaceManager', { getWorkspace: async () => workspace, resolveWorkspaceId: () => 'w' });
    app.decorate('authenticate', async (request) => {
        request.user = { id: 'owner' };
        const kind = request.headers['x-kind'];
        if (kind !== 'user') request.resourceToken = {
            type: kind === 'share' ? 'workspace' : 'agent', workspaceId: 'w', agentId: 'agent-1',
            permissions: kind === 'readonly' ? ['read'] : ['read', 'write', 'admin'], basePath: '/private',
        };
    });
    await app.register(messageRoutes, { prefix: '/workspaces/:id/messages' });
    await app.register(backendRoutes, { prefix: '/workspaces/:id/backends' });
    const deniedConfig = await app.inject({ method: 'PATCH', url: '/workspaces/w/backends/slack/acme', headers: { authorization: 'Bearer test', 'x-kind': 'agent' }, payload: { allowAgentSend: true } });
    assert.equal(deniedConfig.statusCode, 403);
    const deniedSubscription = await app.inject({ method: 'POST', url: '/workspaces/w/backends/slack/acme/containers', headers: { authorization: 'Bearer test', 'x-kind': 'agent' }, payload: { names: ['other-channel'] } });
    assert.equal(deniedSubscription.statusCode, 403);
    const request = (kind, method = 'POST', path = '/send', payload = { requestId: 'request-0000000001', text: 'Hello' }) => app.inject({
        method, url: `/workspaces/w/messages${path}`, headers: { authorization: 'Bearer test', 'x-kind': kind },
        ...(method === 'POST' ? { payload } : {}),
    });
    assert.equal((await request('readonly')).statusCode, 403);
    assert.equal((await request('share')).statusCode, 403);
    assert.equal((await request('agent', 'DELETE', '/whatsapp/personal/connection')).statusCode, 403);
    assert.equal((await request('agent', 'GET', '/reply-target/3')).statusCode, 403);
    assert.equal(calls.length, 0);
    assert.equal((await request('agent')).statusCode, 200);
    assert.deepEqual(calls[0].actor, { id: 'agent-1', isAgent: true, basePath: '/private' });
    assert.equal((await request('user')).statusCode, 200);
    assert.equal(calls[1].actor.id, 'owner');
    assert.equal((await request('user', 'POST', '/send', { requestId: 'short', text: 'Hello' })).statusCode, 400);
    assert.equal(calls.length, 2);
    assert.equal((await request('user', 'GET', '/whatsapp/personal/connection')).statusCode, 200);
});
