'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

// Unified backend/connector API — mirrors the /.backends/<driver>/<address>
// tree. One surface over storage backends (file/cacache/s3) and message
// connectors (imap accounts). Driver dispatch + capabilities live on the
// Workspace facade (see Workspace.listBackends / syncBackend / …). Retires the
// data-backends vs services/imap split and the resync-node band-aid.
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
            const backends = await request.workspace.listBackendsByDriver(arg(request.params.driver));
            return ok(reply, backends, backends.length);
        } catch (error) { return fail(request, reply, error); }
    });

    // Add a backend instance (imap account / s3 bucket / …).
    fastify.post('/:driver', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const backend = await request.workspace.addBackend(arg(request.params.driver), request.body || {});
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
            const folders = await request.workspace.discoverBackendFolders(arg(request.params.driver), request.body || {});
            return ok(reply, folders, Array.isArray(folders) ? folders.length : undefined);
        } catch (error) { return fail(request, reply, error); }
    });

    // One instance + capabilities + status (+ inline containers).
    fastify.get('/:driver/:address', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const backend = await request.workspace.getBackend(arg(request.params.driver), arg(request.params.address));
            return ok(reply, backend);
        } catch (error) { return fail(request, reply, error); }
    });

    fastify.patch('/:driver/:address', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const backend = await request.workspace.updateBackend(arg(request.params.driver), arg(request.params.address), request.body || {});
            return ok(reply, backend);
        } catch (error) { return fail(request, reply, error); }
    });

    fastify.delete('/:driver/:address', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const removed = await request.workspace.removeBackend(arg(request.params.driver), arg(request.params.address));
            return ok(reply, { removed });
        } catch (error) { return fail(request, reply, error); }
    });

    // Pull latest (storage scan | message fetch). The tree "Resync" routes here.
    fastify.post('/:driver/:address/sync', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const result = await request.workspace.syncBackend(arg(request.params.driver), arg(request.params.address));
            return ok(reply, result);
        } catch (error) { return fail(request, reply, error); }
    });

    // Test connection (capability-gated on the facade).
    fastify.post('/:driver/:address/test', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const result = await request.workspace.testBackend(arg(request.params.driver), arg(request.params.address));
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
            const containers = await request.workspace.listBackendContainers(arg(request.params.driver), arg(request.params.address), { available });
            return ok(reply, containers, containers.length);
        } catch (error) { return fail(request, reply, error); }
    });

    // Subscribe folders/channels (creates containers).
    fastify.post('/:driver/:address/containers', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const folders = request.body?.folders || request.body?.names || [];
            const result = await request.workspace.addBackendContainers(arg(request.params.driver), arg(request.params.address), folders);
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
                arg(request.params.driver), arg(request.params.address), arg(request.params.name), String(request.body?.name || ''),
            );
            return ok(reply, result);
        } catch (error) { return fail(request, reply, error); }
    });

    fastify.delete('/:driver/:address/containers/:name', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const removed = await request.workspace.removeBackendContainer(arg(request.params.driver), arg(request.params.address), arg(request.params.name));
            return ok(reply, { removed });
        } catch (error) { return fail(request, reply, error); }
    });

    fastify.post('/:driver/:address/containers/:name/sync', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const result = await request.workspace.syncBackendContainer(
                arg(request.params.driver), arg(request.params.address), arg(request.params.name),
            );
            return ok(reply, result);
        } catch (error) { return fail(request, reply, error); }
    });
}
