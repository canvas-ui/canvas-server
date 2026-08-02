import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    enforceWorkspaceTokenScope,
    createWorkspaceACLMiddleware,
} from '../../../src/transports/middleware/workspace-acl.js';

function makeReply() {
    return {
        statusCode: null,
        payload: null,
        code(status) { this.statusCode = status; return this; },
        send(payload) { this.payload = payload; return this; },
    };
}

const WS = { id: '7c84589b-9268-45e8-9b7c-85c29adc9bca', name: 'my-ws', owner: 'owner-1' };

function makeRequest(overrides = {}) {
    return {
        raw: { url: `/rest/v2/workspaces/${WS.id}/tree` },
        params: { id: WS.id },
        user: { id: WS.owner },
        headers: { authorization: 'Bearer canvas-workspace-abc' },
        resourceToken: {
            type: 'workspace',
            workspaceId: WS.id,
            workspaceName: WS.name,
            permissions: ['read', 'write'],
        },
        server: {
            workspaceManager: {
                async getWorkspace(id, userId) {
                    return id === WS.id && userId === WS.owner ? { ...WS } : null;
                },
                resolveWorkspaceId() { return null; },
            },
        },
        ...overrides,
    };
}

describe('enforceWorkspaceTokenScope', () => {
    test('non-workspace principals pass through untouched', async () => {
        const reply = makeReply();
        await enforceWorkspaceTokenScope(makeRequest({ resourceToken: undefined }), reply);
        await enforceWorkspaceTokenScope(makeRequest({ resourceToken: { type: 'agent' } }), reply);
        assert.equal(reply.statusCode, null);
    });

    test('bound workspace passes by id and by name', async () => {
        const reply = makeReply();
        await enforceWorkspaceTokenScope(makeRequest(), reply);
        const byName = makeRequest();
        byName.params.id = WS.name;
        byName.raw.url = `/rest/v2/workspaces/${WS.name}/tree`;
        await enforceWorkspaceTokenScope(byName, reply);
        assert.equal(reply.statusCode, null);
    });

    test('other workspaces and non-workspace routes are rejected', async () => {
        let reply = makeReply();
        const other = makeRequest();
        other.params.id = 'some-other-ws';
        await enforceWorkspaceTokenScope(other, reply);
        assert.equal(reply.statusCode, 403);

        reply = makeReply();
        const contexts = makeRequest();
        contexts.raw.url = `/rest/v2/contexts/${WS.id}`;
        await enforceWorkspaceTokenScope(contexts, reply);
        assert.equal(reply.statusCode, 403);

        // no :id at all (list, import, exports)
        reply = makeReply();
        const list = makeRequest();
        list.params = {};
        list.raw.url = '/rest/v2/workspaces/exports';
        await enforceWorkspaceTokenScope(list, reply);
        assert.equal(reply.statusCode, 403);
    });
});

describe('workspace ACL middleware — share-token principals', () => {
    test('bound workspace with sufficient permission is granted', async () => {
        const middleware = createWorkspaceACLMiddleware('write');
        const request = makeRequest();
        const reply = makeReply();
        await middleware(request, reply);
        assert.equal(reply.statusCode, null);
        assert.equal(request.workspace.id, WS.id);
        assert.equal(request.workspaceAccess.isOwner, false);
        assert.equal(request.workspaceAccess.isShareToken, true);
    });

    test('other workspaces of the same owner are refused', async () => {
        const middleware = createWorkspaceACLMiddleware('read');
        const request = makeRequest();
        request.params.id = 'other-ws';
        const reply = makeReply();
        await middleware(request, reply);
        assert.equal(reply.statusCode, 403);
    });

    test('missing permission is refused', async () => {
        const middleware = createWorkspaceACLMiddleware('admin');
        const request = makeRequest();
        const reply = makeReply();
        await middleware(request, reply);
        assert.equal(reply.statusCode, 403);
    });

    test('device-token owners are granted via request.user (no authService round-trip)', async () => {
        const middleware = createWorkspaceACLMiddleware('read');
        const request = makeRequest({ resourceToken: undefined });
        request.headers.authorization = 'Bearer canvas-1234567890abcdef';
        // no authService on server — must not be needed when request.user is set
        const reply = makeReply();
        await middleware(request, reply);
        assert.equal(reply.statusCode, null);
        assert.equal(request.workspaceAccess.isOwner, true);
    });
});
