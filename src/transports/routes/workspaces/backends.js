'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';
import { getServerDevice } from '../../../core/device/ServerDevice.js';

// Unified backend/connector API — mirrors the backends tree's
// /<driver>/<address> nodes. One surface over storage backends
// (file/cacache/s3) and message connectors (imap accounts). Driver dispatch +
// capabilities live on the Workspace facade (see Workspace.listBackends /
// syncBackend / …). Retires the data-backends vs services/imap split and the
// resync-node band-aid.
export default async function workspaceBackendRoutes(fastify) {
    const ok = (reply, payload, count) => {
        const response = count != null
            ? new ResponseObject().found(payload, 'OK', 200, count)
            : new ResponseObject().success(payload);
        return reply.code(response.statusCode).send(response.getResponse());
    };
    const fail = (request, reply, error) => {
        request.log.error(error);
        const response = new ResponseObject().error(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
    };
    const arg = (v) => decodeURIComponent(String(v || ''));
    // 'fs' is a UX alias for the local-folder driver; canonical name is 'file'.
    const drv = (v) => { const d = arg(v); return d === 'fs' ? 'file' : d; };

    // List every backend across all drivers.
    fastify.get('/', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const backends = await request.workspace.listBackends();
            return ok(reply, backends, backends.length);
        } catch (error) { return fail(request, reply, error); }
    });

    // List backends of one driver.
    fastify.get('/:driver', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const backends = await request.workspace.listBackendsByDriver(drv(request.params.driver));
            return ok(reply, backends, backends.length);
        } catch (error) { return fail(request, reply, error); }
    });

    // Add a backend instance (imap account / s3 bucket / …).
    fastify.post('/:driver', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const driver = drv(request.params.driver);
            const backend = await request.workspace.addBackend(driver, request.body || {});
            // A local-folder mount pins content to THIS server's device — make
            // sure that device exists in the user's registry (named,
            // re-associable) and is bound into the workspace like any client
            // device. Best-effort: the mount works without it.
            if ((driver === 'file' || driver === 'fs') && backend?.config?.device?.id && fastify.deviceRegistry) {
                try {
                    const serverDevice = getServerDevice();
                    const existing = await fastify.deviceRegistry.getDevice(request.user.id, serverDevice.deviceId);
                    const record = existing
                        ? await fastify.deviceRegistry.touchDevice(request.user.id, serverDevice.deviceId, {})
                        : await fastify.deviceRegistry.upsertDevice(request.user.id, {
                            deviceId: serverDevice.deviceId,
                            name: serverDevice.name,
                            description: serverDevice.description,
                            hostname: serverDevice.hostname,
                            fqdn: serverDevice.fqdn,
                            platform: serverDevice.platform,
                            arch: serverDevice.arch,
                            type: serverDevice.type,
                            username: serverDevice.username,
                        });
                    await fastify.deviceRegistry.ensureWorkspaceBinding(request.workspace, record);
                } catch (deviceError) {
                    request.log.warn({ err: deviceError }, 'Failed to register server device for local-folder backend');
                }
            }
            const response = new ResponseObject().created(backend);
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) { return fail(request, reply, error); }
    });

    // Pre-create folder discovery — probe a connector with candidate creds
    // before the instance exists (the "add account" flow). POST-only literal so
    // it can't collide with GET /:driver/:address.
    fastify.post('/:driver/discover', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const folders = await request.workspace.discoverBackendFolders(drv(request.params.driver), request.body || {});
            return ok(reply, folders, Array.isArray(folders) ? folders.length : undefined);
        } catch (error) { return fail(request, reply, error); }
    });

    // One instance + capabilities + status (+ inline containers).
    fastify.get('/:driver/:address', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const backend = await request.workspace.getBackend(drv(request.params.driver), arg(request.params.address));
            return ok(reply, backend);
        } catch (error) { return fail(request, reply, error); }
    });

    fastify.patch('/:driver/:address', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const backend = await request.workspace.updateBackend(drv(request.params.driver), arg(request.params.address), request.body || {});
            return ok(reply, backend);
        } catch (error) { return fail(request, reply, error); }
    });

    fastify.delete('/:driver/:address', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const removed = await request.workspace.removeBackend(drv(request.params.driver), arg(request.params.address));
            return ok(reply, { removed });
        } catch (error) { return fail(request, reply, error); }
    });

    // Documents mirrored under a backend address, filtered by linkage into
    // other trees. ?linked=false → present ONLY on the backend, never filed
    // into any context/directory tree (safe-to-purge candidates);
    // ?linked=true → the inverse; omitted → everything under the address.
    fastify.get('/:driver/:address/documents', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
        schema: {
            querystring: {
                type: 'object',
                properties: {
                    linked: { type: 'boolean' },
                    limit: { type: 'integer', minimum: 0, default: 200 },
                    offset: { type: 'integer', minimum: 0, default: 0 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { linked = null, limit, offset } = request.query || {};
            const result = await request.workspace.listBackendDocuments(
                drv(request.params.driver), arg(request.params.address),
                { linked, limit, offset },
            );
            const response = new ResponseObject().found(result.documents, 'OK', 200, result.count, result.totalCount);
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) { return fail(request, reply, error); }
    });

    // Pull latest (storage scan | message fetch). The tree "Resync" routes here.
    fastify.post('/:driver/:address/sync', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const result = await request.workspace.syncBackend(drv(request.params.driver), arg(request.params.address));
            return ok(reply, result);
        } catch (error) { return fail(request, reply, error); }
    });

    // Cancel an in-flight storage resync — the walk stops at the next file
    // boundary; indexed rows stay and a later sync resumes via the checksum
    // cache, so this doubles as "pause".
    fastify.post('/:driver/:address/sync/cancel', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const result = await request.workspace.cancelSyncBackend(drv(request.params.driver), arg(request.params.address));
            return ok(reply, result);
        } catch (error) { return fail(request, reply, error); }
    });

    // On-demand disk usage of a local storage backend (walks the backend root —
    // potentially slow on large trees, hence user-triggered, never automatic).
    fastify.get('/:driver/:address/usage', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const usage = await request.workspace.getBackendDiskUsage(drv(request.params.driver), arg(request.params.address));
            return ok(reply, usage);
        } catch (error) { return fail(request, reply, error); }
    });

    // Test connection (capability-gated on the facade).
    fastify.post('/:driver/:address/test', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const result = await request.workspace.testBackend(drv(request.params.driver), arg(request.params.address));
            return ok(reply, result);
        } catch (error) { return fail(request, reply, error); }
    });

    // Containers = folders | channels | buckets (generic). ?available=1 lists
    // what can still be subscribed (server-side), else the subscribed set.
    fastify.get('/:driver/:address/containers', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const available = request.query?.available === '1' || request.query?.available === 'true';
            const containers = await request.workspace.listBackendContainers(drv(request.params.driver), arg(request.params.address), { available });
            return ok(reply, containers, containers.length);
        } catch (error) { return fail(request, reply, error); }
    });

    // Subscribe folders/channels (creates containers).
    fastify.post('/:driver/:address/containers', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const folders = request.body?.folders || request.body?.names || [];
            const result = await request.workspace.addBackendContainers(drv(request.params.driver), arg(request.params.address), folders);
            const response = new ResponseObject().created(result);
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) { return fail(request, reply, error); }
    });

    // Rename/move a container (file-backend folders). Body: { name: newName }.
    fastify.patch('/:driver/:address/containers/:name', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const result = await request.workspace.renameBackendFolder(
                drv(request.params.driver), arg(request.params.address), arg(request.params.name), String(request.body?.name || ''),
            );
            return ok(reply, result);
        } catch (error) { return fail(request, reply, error); }
    });

    fastify.delete('/:driver/:address/containers/:name', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const removed = await request.workspace.removeBackendContainer(drv(request.params.driver), arg(request.params.address), arg(request.params.name));
            return ok(reply, { removed });
        } catch (error) { return fail(request, reply, error); }
    });

    fastify.post('/:driver/:address/containers/:name/sync', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const result = await request.workspace.syncBackendContainer(
                drv(request.params.driver), arg(request.params.address), arg(request.params.name),
            );
            return ok(reply, result);
        } catch (error) { return fail(request, reply, error); }
    });

    // Write-back: create a document in a connector container (v1: a calendar
    // event on a rw caldav backend). The remote object is created first, then
    // mirrored into the index — see WorkspaceConnectorIndex.createDocument.
    fastify.post('/:driver/:address/containers/:name/documents', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const result = await request.workspace.createBackendContainerDocument(
                drv(request.params.driver), arg(request.params.address), arg(request.params.name),
                request.body || {},
            );
            const response = new ResponseObject().created(result, 'Document created');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) { return fail(request, reply, error); }
    });

    // Write-back: update the remote object behind a synced document (edit /
    // close / reopen a GitHub issue, …). Body is a driver-shaped patch.
    fastify.patch('/:driver/:address/documents/:docId', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const result = await request.workspace.updateBackendDocument(
                drv(request.params.driver), arg(request.params.address), request.params.docId,
                request.body || {},
            );
            return ok(reply, result);
        } catch (error) { return fail(request, reply, error); }
    });

    // Write-back: delete the remote object (GitHub: closes as not_planned —
    // issues cannot be deleted via REST; caldav: real DELETE + local drop).
    fastify.delete('/:driver/:address/documents/:docId', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const result = await request.workspace.deleteBackendDocument(
                drv(request.params.driver), arg(request.params.address), request.params.docId,
            );
            return ok(reply, result);
        } catch (error) { return fail(request, reply, error); }
    });
}
