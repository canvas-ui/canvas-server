import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceACLMiddleware } from '../../../src/transports/middleware/workspace-acl.js';

// Member principals (e-mail / group shares) through the ACL middleware —
// JWT and canvas-* user tokens alike, permission clamped, owner fast path
// still owner-only now that getWorkspace admits members.

function makeReply() {
    return {
        statusCode: null,
        payload: null,
        code(status) { this.statusCode = status; return this; },
        send(payload) { this.payload = payload; return this; },
    };
}

const WS = { id: '7c84589b-9268-45e8-9b7c-85c29adc9bca', name: 'team-space', owner: 'owner-1' };

function makeManager({ memberPermissions = ['read'] } = {}) {
    return {
        async getWorkspace(id, userId) {
            // Owner and members (any userId the manager admitted) get the instance
            if (id !== WS.id) return null;
            return userId === WS.owner || userId === 'mate-1' ? { ...WS } : null;
        },
        resolveWorkspaceId(userId, name) {
            if (name !== WS.name) return null;
            return userId === WS.owner || userId === 'mate-1' ? WS.id : null;
        },
        async resolveWorkspaceAccess(id, userId) {
            if (id !== WS.id) return null;
            if (userId === WS.owner) return { isOwner: true, owner: WS.owner, permissions: ['read', 'write', 'admin'], via: 'owner', principal: null, description: 'Workspace owner' };
            if (userId === 'mate-1') return { isOwner: false, owner: WS.owner, permissions: memberPermissions, via: 'group', principal: 'team-a', description: 'Shared with group team-a' };
            return null;
        },
    };
}

function makeRequest({ userId, token = 'jwt.token.value', id = WS.id, manager = makeManager() } = {}) {
    return {
        raw: { url: `/rest/v2/workspaces/${id}/documents` },
        params: { id },
        user: { id: userId },
        headers: { authorization: `Bearer ${token}` },
        server: { workspaceManager: manager, users: {} },
    };
}

describe('workspace ACL middleware — member principals', () => {
    test('owner keeps the owner fast path (full permissions)', async () => {
        const reply = makeReply();
        const request = makeRequest({ userId: WS.owner });
        await createWorkspaceACLMiddleware('admin')(request, reply);
        assert.equal(reply.statusCode, null);
        assert.equal(request.workspaceAccess.isOwner, true);
        assert.deepEqual(request.workspaceAccess.permissions, ['read', 'write', 'admin']);
    });

    test('group member with read is granted read via JWT, by id and by name', async () => {
        for (const id of [WS.id, WS.name]) {
            const reply = makeReply();
            const request = makeRequest({ userId: 'mate-1', id });
            await createWorkspaceACLMiddleware('read')(request, reply);
            assert.equal(reply.statusCode, null, `by ${id}`);
            assert.equal(request.workspaceAccess.isOwner, false);
            assert.equal(request.workspaceAccess.isMember, true);
            assert.equal(request.workspaceAccess.via, 'group');
            assert.equal(request.workspace.id, WS.id);
        }
    });

    test('member access also works with a canvas-* user token (CLI / FUSE)', async () => {
        const reply = makeReply();
        const request = makeRequest({ userId: 'mate-1', token: 'canvas-1234567890abcdef' });
        await createWorkspaceACLMiddleware('read')(request, reply);
        assert.equal(reply.statusCode, null);
        assert.equal(request.workspaceAccess.isMember, true);
    });

    test('read-only member is refused write and admin', async () => {
        for (const permission of ['write', 'admin']) {
            const reply = makeReply();
            const request = makeRequest({ userId: 'mate-1' });
            await createWorkspaceACLMiddleware(permission)(request, reply);
            assert.equal(reply.statusCode, 403, permission);
            assert.equal(request.workspaceAccess, undefined);
        }
    });

    test('member with write is granted write but not admin', async () => {
        const manager = makeManager({ memberPermissions: ['read', 'write'] });
        let reply = makeReply();
        await createWorkspaceACLMiddleware('write')(makeRequest({ userId: 'mate-1', manager }), reply);
        assert.equal(reply.statusCode, null);
        reply = makeReply();
        await createWorkspaceACLMiddleware('admin')(makeRequest({ userId: 'mate-1', manager }), reply);
        assert.equal(reply.statusCode, 403);
    });

    test('a member is never mistaken for the owner even though getWorkspace admits them', async () => {
        const reply = makeReply();
        const request = makeRequest({ userId: 'mate-1' });
        await createWorkspaceACLMiddleware('read')(request, reply);
        assert.equal(request.workspaceAccess.isOwner, false);
        assert.notDeepEqual(request.workspaceAccess.permissions, ['read', 'write', 'admin']);
    });

    test('outsider is refused', async () => {
        const reply = makeReply();
        await createWorkspaceACLMiddleware('read')(makeRequest({ userId: 'stranger' }), reply);
        assert.equal(reply.statusCode, 403);
    });
});
