import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPathToBase, enforceAgentBinding, rejectAgentTokens } from './agent-acl.js';

describe('clampPathToBase', () => {
    test('root base passes any normalized path through', () => {
        assert.equal(clampPathToBase('/', '/mail/inbox'), '/mail/inbox');
        assert.equal(clampPathToBase('/', undefined), '/');
        assert.equal(clampPathToBase('/', 'relative/path'), '/relative/path');
    });

    test('missing path defaults to base', () => {
        assert.equal(clampPathToBase('/mail', undefined), '/mail');
        assert.equal(clampPathToBase('/mail', ''), '/mail');
        assert.equal(clampPathToBase('/mail', null), '/mail');
    });

    test('paths under base pass, others rejected', () => {
        assert.equal(clampPathToBase('/mail', '/mail'), '/mail');
        assert.equal(clampPathToBase('/mail', '/mail/inbox'), '/mail/inbox');
        assert.equal(clampPathToBase('/mail', '/mail/inbox/'), '/mail/inbox');
        assert.equal(clampPathToBase('/mail', '/other'), null);
        // '/' aliases to the base (route schemas default missing context to '/')
        assert.equal(clampPathToBase('/mail', '/'), '/mail');
        // prefix must respect the segment boundary
        assert.equal(clampPathToBase('/mail', '/mailbox'), null);
    });

    test('traversal escapes rejected', () => {
        assert.equal(clampPathToBase('/mail', '/mail/../secrets'), null);
        assert.equal(clampPathToBase('/mail', '/mail/inbox/../../other'), null);
        // normalizes to /mail — inside base, allowed
        assert.equal(clampPathToBase('/mail', '/../mail'), '/mail');
        // normalization that STAYS inside base is fine
        assert.equal(clampPathToBase('/mail', '/mail/inbox/../archive'), '/mail/archive');
    });
});

function makeReply() {
    const reply = {
        statusCode: null,
        payload: null,
        code(status) { this.statusCode = status; return this; },
        send(payload) { this.payload = payload; return this; },
    };
    return reply;
}

function makeRequest(overrides = {}) {
    return {
        method: 'GET',
        params: { id: 'ws-1' },
        query: {},
        body: undefined,
        user: { id: 'owner-1' },
        resourceToken: {
            type: 'agent',
            agentId: 'agent-1',
            workspaceId: 'ws-1',
            basePath: '/mail',
            permissions: ['read'],
        },
        server: {
            workspaceManager: { resolveWorkspaceId: () => 'ws-1' },
        },
        ...overrides,
    };
}

describe('enforceAgentBinding', () => {
    test('non-agent tokens pass through untouched', async () => {
        const reply = makeReply();
        const request = makeRequest({ resourceToken: { type: 'workspace' } });
        await enforceAgentBinding(request, reply);
        assert.equal(reply.statusCode, null);
    });

    test('other workspace -> 403', async () => {
        const reply = makeReply();
        const request = makeRequest({ params: { id: 'ws-2' }, server: { workspaceManager: { resolveWorkspaceId: () => 'ws-2' } } });
        await enforceAgentBinding(request, reply);
        assert.equal(reply.statusCode, 403);
    });

    test('write without write permission -> 403', async () => {
        const reply = makeReply();
        const request = makeRequest({ method: 'POST', body: { documents: [{}], context: '/mail' } });
        await enforceAgentBinding(request, reply);
        assert.equal(reply.statusCode, 403);
    });

    test('read defaults context to base and forces path scope', async () => {
        const reply = makeReply();
        const request = makeRequest({ query: { scope: 'workspace' } });
        await enforceAgentBinding(request, reply);
        assert.equal(reply.statusCode, null);
        assert.equal(request.query.context, '/mail');
        assert.equal(request.query.scope, 'path');
    });

    test('query context outside base -> 403', async () => {
        const reply = makeReply();
        const request = makeRequest({ query: { context: '/private' } });
        await enforceAgentBinding(request, reply);
        assert.equal(reply.statusCode, 403);
    });

    test('write body contexts clamped, escapes rejected', async () => {
        const write = { ...makeRequest(), method: 'POST' };
        write.resourceToken.permissions = ['read', 'write'];
        write.body = { documents: [{}], context: '/mail/inbox/' };
        const reply = makeReply();
        await enforceAgentBinding(write, reply);
        assert.equal(reply.statusCode, null);
        assert.equal(write.body.context, '/mail/inbox');

        const escape = { ...makeRequest(), method: 'POST' };
        escape.resourceToken.permissions = ['read', 'write'];
        escape.body = { documents: [{}], context: ['/mail/a', '/other'] };
        const reply2 = makeReply();
        await enforceAgentBinding(escape, reply2);
        assert.equal(reply2.statusCode, 403);
    });

    test('top-level array body rejected for path-bound agents', async () => {
        const request = { ...makeRequest(), method: 'POST', body: [1, 2, 3] };
        request.resourceToken.permissions = ['read', 'write'];
        const reply = makeReply();
        await enforceAgentBinding(request, reply);
        assert.equal(reply.statusCode, 403);
    });

    test('tree wildcard clamped', async () => {
        const request = makeRequest({ params: { id: 'ws-1', '*': '/other' } });
        const reply = makeReply();
        await enforceAgentBinding(request, reply);
        assert.equal(reply.statusCode, 403);
    });

    test('workspace-wide binding (basePath /) skips path clamp', async () => {
        const request = makeRequest({ query: { context: '/anything' } });
        request.resourceToken.basePath = '/';
        const reply = makeReply();
        await enforceAgentBinding(request, reply);
        assert.equal(reply.statusCode, null);
        assert.equal(request.query.context, '/anything');
    });
});

describe('rejectAgentTokens', () => {
    test('agent token -> 403, others pass', async () => {
        const reply = makeReply();
        await rejectAgentTokens(makeRequest(), reply);
        assert.equal(reply.statusCode, 403);

        const reply2 = makeReply();
        await rejectAgentTokens(makeRequest({ resourceToken: undefined }), reply2);
        assert.equal(reply2.statusCode, null);
    });
});
