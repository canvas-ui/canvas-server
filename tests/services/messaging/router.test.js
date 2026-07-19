import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChatRouter } from '../../../src/services/messaging/src/router.js';
import { Messaging } from '../../../src/services/messaging/src/index.js';

function makeStore() {
    const map = new Map();
    return {
        get: (key) => map.get(key),
        set: (key, value) => map.set(key, value),
        delete: (key) => map.delete(key),
        map,
    };
}

function makeAdapter(name) {
    const sent = [];
    return {
        name,
        sent,
        async sendText(recipient, text) { sent.push({ recipient, text }); return { delivered: true }; },
    };
}

describe('ChatRouter', () => {
    let store, adapter, messaging, prompts, router;

    beforeEach(() => {
        store = makeStore();
        adapter = makeAdapter('whatsapp');
        messaging = new Messaging({ adapters: [adapter], bindingsStore: store, logger: { debug() {} } });
        prompts = [];
        router = new ChatRouter({
            store,
            messaging,
            promptAgent: async (userId, agentId, text) => {
                prompts.push({ userId, agentId, text });
                return `echo: ${text}`;
            },
            logger: { debug() {}, error() {} },
        });
    });

    test('unlinked peer gets linking instructions', async () => {
        await router.handle({ channel: 'whatsapp', senderId: '4915551234', text: 'any new emails?' });
        assert.equal(prompts.length, 0);
        assert.match(adapter.sent[0].text, /not linked/);
    });

    test('link code claims binding, records notify recipient, then routes to agent', async () => {
        const { code } = router.createLinkCode('user-1', { channel: 'whatsapp', agentId: 'agent-1' });

        await router.handle({ channel: 'whatsapp', senderId: '4915551234', text: `link ${code}` });
        assert.match(adapter.sent[0].text, /Linked/);
        assert.deepEqual(router.getPeerBinding('whatsapp', '4915551234').agentId, 'agent-1');
        // outbound notify recipient recorded
        assert.equal(messaging.getBindings('user-1').channels.whatsapp.recipient, '4915551234');

        await router.handle({ channel: 'whatsapp', senderId: '4915551234', text: 'any new emails?' });
        assert.deepEqual(prompts[0], { userId: 'user-1', agentId: 'agent-1', text: 'any new emails?' });
        assert.equal(adapter.sent[1].text, 'echo: any new emails?');
    });

    test('link code is single-use and channel-bound', async () => {
        const { code } = router.createLinkCode('user-1', { channel: 'slack', agentId: 'agent-1' });
        await router.handle({ channel: 'whatsapp', senderId: 'x', text: `link ${code}` });
        assert.match(adapter.sent[0].text, /for the slack channel/);

        const { code: code2 } = router.createLinkCode('user-1', { channel: 'whatsapp', agentId: 'agent-1' });
        await router.handle({ channel: 'whatsapp', senderId: 'x', text: `link ${code2}` });
        await router.handle({ channel: 'whatsapp', senderId: 'y', text: `link ${code2}` });
        assert.match(adapter.sent.at(-1).text, /Unknown or already used/);
    });

    test('agent errors are reported to the peer, not thrown', async () => {
        const failing = new ChatRouter({
            store,
            messaging,
            promptAgent: async () => { throw new Error('boom'); },
            logger: { debug() {}, error() {} },
        });
        const { code } = failing.createLinkCode('user-1', { channel: 'whatsapp', agentId: 'agent-1' });
        await failing.handle({ channel: 'whatsapp', senderId: 'z', text: `link ${code}` });
        await failing.handle({ channel: 'whatsapp', senderId: 'z', text: 'hello' });
        assert.match(adapter.sent.at(-1).text, /Agent error: boom/);
    });

    test('media becomes pi images param', async () => {
        const { code } = router.createLinkCode('user-1', { channel: 'whatsapp', agentId: 'agent-1' });
        await router.handle({ channel: 'whatsapp', senderId: 'm', text: `link ${code}` });

        let captured = null;
        const mediaRouter = new ChatRouter({
            store,
            messaging,
            promptAgent: async (userId, agentId, text, options) => { captured = options; return 'ok'; },
            logger: { debug() {}, error() {} },
        });
        await mediaRouter.handle({
            channel: 'whatsapp', senderId: 'm', text: 'what is this?',
            media: [{ data: 'aGk=', mimeType: 'image/png' }],
        });
        assert.equal(captured.images.length, 1);
        assert.deepEqual(captured.images[0], { type: 'image', data: 'aGk=', mimeType: 'image/png' });
    });
});
