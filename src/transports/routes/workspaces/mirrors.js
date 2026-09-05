'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

// Device mirrors of this workspace, as reported by the devices themselves.
// The registry is per user (a device belongs to the account that paired it),
// so a listing shows the caller's own devices mirroring this workspace.
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

    fastify.get('/', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const mirrors = await registry().listMirrorsForWorkspace(request.user.id, workspaceIdOf(request));
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
                return { ...m, head: hubHead, lag: hubHead != null ? Math.max(0, hubHead - cursor) : null };
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
                },
            },
        },
    }, async (request, reply) => {
        try {
            const deviceId = String(request.params.deviceId || '').trim();
            const client = request.client;
            if (client?.deviceId && client.deviceId !== deviceId && !request.workspaceAccess?.isOwner) {
                return send(reply, new ResponseObject().forbidden('A device may only report its own mirror'), 'DEVICE_MISMATCH');
            }
            const body = request.body || {};
            const backend = body.backend || 'workspace:home';
            const record = await registry().updateMirrorStatus(request.user.id, deviceId, workspaceIdOf(request), {
                ...body,
                backend,
                workspaceName: request.workspace?.name,
                reportedAt: new Date().toISOString(),
            });
            let head = null;
            try { head = (await request.workspace.backendChanges('file', backend, { since: 0, limit: 1 })).head; } catch { head = null; }
            return send(reply, new ResponseObject().updated({ deviceId, workspaceId: workspaceIdOf(request), mirror: record, head }, 'Mirror status recorded'));
        } catch (error) { return fail(request, reply, error); }
    });

    fastify.delete('/:deviceId', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const removed = await registry().removeMirror(request.user.id, String(request.params.deviceId || '').trim(), workspaceIdOf(request));
            return send(reply, new ResponseObject().deleted({ removed }, removed ? 'Mirror forgotten' : 'No such mirror'));
        } catch (error) { return fail(request, reply, error); }
    });
}
