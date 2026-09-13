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
            // Replica policy + evidence (docs/durable-workspaces.md), in memory.
            replicas: [],
            applied: {},
            setReplica(deviceId, patch) {
                const existing = this.replicas.find((r) => r.device === deviceId) || { device: deviceId, role: 'full', required: false };
                const next = { ...existing, ...patch };
                if (next.role === 'cache') next.required = false;
                this.replicas = [...this.replicas.filter((r) => r.device !== deviceId), next];
                return next;
            },
            removeReplica(deviceId) { this.replicas = this.replicas.filter((r) => r.device !== deviceId); return true; },
            async recordReplicaApplied(deviceId, pairs, { full = false } = {}) {
                if (full) this.applied[deviceId] = {};
                this.applied[deviceId] = this.applied[deviceId] || {};
                for (const [docId, version] of pairs) this.applied[deviceId][docId] = Math.max(this.applied[deviceId][docId] || 0, version);
                return { deviceId, written: pairs.length, full };
            },
            async forgetReplica(deviceId) { delete this.applied[deviceId]; return 0; },
            docs: { 1: 3, 2: 1 },   // docId → current version
            async replicaProtection(backend, { devices = [], sample = 20 } = {}) {
                const required = this.replicas.filter((r) => r.required).map((r) => r.device);
                const all = [...new Set([...required, ...devices])];
                const replicas = Object.fromEntries(all.map((d) => [d, { behind: 0, held: 0, required: required.includes(d) }]));
                let prot = 0; const oldest = [];
                for (const [docId, version] of Object.entries(this.docs)) {
                    let ok = required.length > 0;
                    for (const d of all) {
                        const cur = (this.applied[d]?.[docId] || 0) >= version;
                        if (cur) replicas[d].held += 1; else replicas[d].behind += 1;
                        if (!cur && required.includes(d)) ok = false;
                    }
                    if (ok) prot += 1; else if (required.length && oldest.length < sample) oldest.push({ key: `doc${docId}.txt`, docId: Number(docId), version });
                }
                const total = Object.keys(this.docs).length;
                return { backend, required, total, unversioned: 0, protected: required.length ? prot : null, unprotected: required.length ? total - prot : null, partial: false, replicas, oldestUnprotected: oldest };
            },
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

    test('applied pairs feed the replica table, policy is PATCHed, protection walks the versions', async () => {
        // The NAS reports what it holds; the pairs must not land on the device record.
        const rep = await inject('POST', '/workspaces/universe/mirrors/nas/status', { client: 'daemon', direction: 'pull', cursor: 42, applied: [[1, 3], [2, 1]], full: true });
        assert.equal(rep.statusCode, 200, rep.body);
        assert.equal(rep.json().payload.replica.written, 2);
        assert.equal(rep.json().payload.mirror.applied, undefined);
        assert.equal(rep.json().payload.mirror.direction, 'pull');

        // The laptop is behind on doc 1.
        await inject('POST', '/workspaces/universe/mirrors/laptop/status', { client: 'daemon', direction: 'bi', cursor: 40, applied: [[1, 2], [2, 1]] });

        // Nothing is required yet → protection is not computed, but behind/held are.
        let list = await inject('GET', '/workspaces/universe/mirrors');
        const byId = Object.fromEntries(list.json().payload.map((m) => [m.deviceId, m]));
        assert.deepEqual(byId.nas.replica, { role: 'full', required: false });
        assert.equal(byId.nas.behind, 0);
        assert.equal(byId.laptop.behind, 1);
        let prot = await inject('GET', '/workspaces/universe/mirrors/protection');
        assert.equal(prot.json().payload.protected, null);

        // Require the NAS: everything it holds current is protected.
        const patched = await inject('PATCH', '/workspaces/universe/mirrors/nas', { required: true });
        assert.equal(patched.statusCode, 200, patched.body);
        assert.equal(patched.json().payload.replica.required, true);
        prot = await inject('GET', '/workspaces/universe/mirrors/protection');
        assert.deepEqual(prot.json().payload.required, ['nas']);
        assert.equal(prot.json().payload.protected, 2);
        assert.equal(prot.json().payload.unprotected, 0);

        // Require the laptop too: doc 1 is now exposed and shows up as oldest unprotected.
        await inject('PATCH', '/workspaces/universe/mirrors/laptop', { required: true });
        prot = await inject('GET', '/workspaces/universe/mirrors/protection');
        assert.equal(prot.json().payload.unprotected, 1);
        assert.deepEqual(prot.json().payload.oldestUnprotected.map((o) => o.docId), [1]);

        // A cache never counts, whatever the flag says.
        const cache = await inject('PATCH', '/workspaces/universe/mirrors/gpu', { role: 'cache', required: true });
        assert.deepEqual(cache.json().payload.replica, { device: 'gpu', role: 'cache', required: false });

        // Forgetting the mirror drops its policy entry.
        await inject('DELETE', '/workspaces/universe/mirrors/laptop');
        list = await inject('GET', '/workspaces/universe/mirrors');
        assert.equal(list.json().payload.some((m) => m.deviceId === 'laptop'), false);
        prot = await inject('GET', '/workspaces/universe/mirrors/protection');
        assert.deepEqual(prot.json().payload.required, ['nas']);
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
