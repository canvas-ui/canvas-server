'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

// Device mirrors of this workspace, as reported by the devices themselves.
// The registry is per user (a device belongs to the account that paired it),
// so a listing shows the caller's own devices mirroring this workspace.
//
// Replicas (docs/durable-workspaces.md): a status report may carry `applied`
// — `[[docId, version], …]` the device has verified and fsynced since its last
// report (`full: true` = the complete set, replaces what we hold) — which the
// workspace records per device. Which devices *count* toward "protected" is
// workspace config (`replicas`, PATCH /:deviceId); the walk that compares
// every document's current version with what the replicas hold is
// GET /protection.
export default async function workspaceMirrorRoutes(fastify) {
    const send = (reply, response, code = null) => {
        if (code) response.code = code;
        return reply.code(response.statusCode).send(response.getResponse());
    };
    const fail = (request, reply, error) => {
        const statusCode = Number(error?.statusCode) || 500;
        if (statusCode >= 500) request.log.error(error);
        return send(reply, new ResponseObject().error(error?.message || 'Internal error', null, statusCode), error?.code || undefined);
    };
    const registry = () => {
        if (!fastify.deviceRegistry) throw Object.assign(new Error('Device registry not available'), { statusCode: 503, code: 'NO_DEVICE_REGISTRY' });
        return fastify.deviceRegistry;
    };
    const workspaceIdOf = (request) => request.workspace?.id || request.params.id;

    const replicaPolicy = (workspace) => {
        const list = Array.isArray(workspace?.replicas) ? workspace.replicas : [];
        return Object.fromEntries(list.map((r) => [r.device, { role: r.role, required: r.required === true }]));
    };

    fastify.get('/', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const mirrors = await registry().listMirrorsForWorkspace(request.user.id, workspaceIdOf(request));
            const policy = replicaPolicy(request.workspace);
            // Per-replica "versions behind" from the protection walk (bounded;
            // absent when the workspace cannot walk, e.g. a stopped one).
            let protection = null;
            if (mirrors.length && typeof request.workspace.replicaProtection === 'function') {
                try { protection = await request.workspace.replicaProtection('workspace:home', { devices: mirrors.map((m) => m.deviceId), sample: 0 }); }
                catch { protection = null; }
            }
            // Lag = how far behind the hub's change log the device is.
            let head = null;
            try {
                const backends = new Set(mirrors.map((m) => m.mirror?.backend || 'workspace:home'));
                head = {};
                for (const backend of backends) {
                    const page = await request.workspace.backendChanges('file', backend, { since: 0, limit: 1 });
                    head[backend] = page.head;
                }
            } catch { head = null; }
            const payload = mirrors.map((m) => {
                const backend = m.mirror?.backend || 'workspace:home';
                const hubHead = head?.[backend] ?? null;
                const cursor = Number(m.mirror?.cursor ?? 0);
                const rep = protection?.replicas?.[m.deviceId] || null;
                return {
                    ...m,
                    head: hubHead,
                    lag: hubHead != null ? Math.max(0, hubHead - cursor) : null,
                    replica: policy[m.deviceId] || { role: m.mirror?.client === 'fuse' ? 'cache' : 'full', required: false },
                    behind: rep ? rep.behind : null,
                    held: rep ? rep.held : null,
                };
            });
            return send(reply, new ResponseObject().found(payload, 'OK', 200, payload.length));
        } catch (error) { return fail(request, reply, error); }
    });

    // A device reports its mirror state. Allowed for the device itself (device
    // token) or anyone with write access (an admin forcing a record).
    fastify.post('/:deviceId/status', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            body: {
                type: 'object',
                properties: {
                    backend: { type: 'string' },
                    client: { type: 'string', enum: ['fuse', 'daemon', 'other'] },
                    path: { type: 'string', maxLength: 4096 },
                    prefixes: { type: 'array', items: { type: 'string' }, maxItems: 256 },
                    cursor: { type: 'integer', minimum: 0 },
                    pending: { type: 'integer', minimum: 0 },
                    failed: { type: 'integer', minimum: 0 },
                    conflicts: { type: 'integer', minimum: 0 },
                    skipped: { type: 'integer', minimum: 0 },
                    state: { type: 'string', maxLength: 32 },
                    lastSync: { type: 'string' },
                    lastError: { type: ['string', 'null'], maxLength: 1024 },
                    version: { type: 'string', maxLength: 64 },
                    direction: { type: 'string', enum: ['bi', 'pull', 'push'] },
                    reverted: { type: 'integer', minimum: 0 },
                    // Protection evidence: (docId, version) pairs verified + fsynced on the device.
                    applied: { type: 'array', maxItems: 100000, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 1 } } },
                    full: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const deviceId = String(request.params.deviceId || '').trim();
            // A device token is scoped to one device: it never reports for another,
            // owner or not. Plain user/API tokens (no deviceId) may — an admin
            // forcing a record.
            const client = request.client;
            if (client?.deviceId && client.deviceId !== deviceId) {
                return send(reply, new ResponseObject().forbidden('A device may only report its own mirror'), 'DEVICE_MISMATCH');
            }
            const { applied, full, ...body } = request.body || {};
            const backend = body.backend || 'workspace:home';
            const record = await registry().updateMirrorStatus(request.user.id, deviceId, workspaceIdOf(request), {
                ...body,
                backend,
                workspaceName: request.workspace?.name,
                reportedAt: new Date().toISOString(),
            });
            // The pairs never land on the device record (thousands of rows):
            // they go to the workspace's replica table.
            let replica = null;
            if ((Array.isArray(applied) && applied.length) || full === true) {
                if (typeof request.workspace.recordReplicaApplied === 'function') {
                    replica = await request.workspace.recordReplicaApplied(deviceId, applied || [], { full: full === true });
                }
            }
            let head = null;
            try { head = (await request.workspace.backendChanges('file', backend, { since: 0, limit: 1 })).head; } catch { head = null; }
            return send(reply, new ResponseObject().updated({ deviceId, workspaceId: workspaceIdOf(request), mirror: record, head, replica }, 'Mirror status recorded'));
        } catch (error) { return fail(request, reply, error); }
    });

    // Which replicas count toward "protected" (workspace config, owner-managed).
    fastify.patch('/:deviceId', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            body: {
                type: 'object',
                properties: {
                    required: { type: 'boolean' },
                    role: { type: 'string', enum: ['full', 'cache'] },
                },
            },
        },
    }, async (request, reply) => {
        try {
            if (typeof request.workspace.setReplica !== 'function') {
                return send(reply, new ResponseObject().error('Replica policy is not available on this workspace', null, 501), 'NOT_IMPLEMENTED');
            }
            const replica = request.workspace.setReplica(String(request.params.deviceId || '').trim(), request.body || {});
            return send(reply, new ResponseObject().updated({ replica, replicas: request.workspace.replicas }, 'Replica policy updated'));
        } catch (error) { return fail(request, reply, error); }
    });

    // The protection walk: every document's current version vs. what the
    // required replicas hold. `?sample=` oldest unprotected documents (default 20).
    fastify.get('/protection', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            if (typeof request.workspace.replicaProtection !== 'function') {
                return send(reply, new ResponseObject().error('Protection state is not available on this workspace', null, 501), 'NOT_IMPLEMENTED');
            }
            const sample = Math.min(200, Math.max(0, Number.parseInt(String(request.query?.sample ?? '20'), 10) || 0));
            const backend = String(request.query?.backend || 'workspace:home');
            const mirrors = await registry().listMirrorsForWorkspace(request.user.id, workspaceIdOf(request)).catch(() => []);
            const summary = await request.workspace.replicaProtection(backend, { devices: mirrors.map((m) => m.deviceId), sample });
            return send(reply, new ResponseObject().found({ ...summary, policy: request.workspace.replicas || [] }, 'OK'));
        } catch (error) { return fail(request, reply, error); }
    });

    fastify.delete('/:deviceId', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const deviceId = String(request.params.deviceId || '').trim();
            const removed = await registry().removeMirror(request.user.id, deviceId, workspaceIdOf(request));
            // Forgetting the record also drops its evidence and its policy entry.
            if (typeof request.workspace.forgetReplica === 'function') await request.workspace.forgetReplica(deviceId).catch(() => null);
            if (typeof request.workspace.removeReplica === 'function') { try { request.workspace.removeReplica(deviceId); } catch { /* config may be read-only */ } }
            return send(reply, new ResponseObject().deleted({ removed }, removed ? 'Mirror forgotten' : 'No such mirror'));
        } catch (error) { return fail(request, reply, error); }
    });
}
