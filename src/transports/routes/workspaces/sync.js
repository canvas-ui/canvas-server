'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

// Sync conflicts (device mirrors): list what is waiting in the inbox and
// resolve entries. Creation happens through PUT objects/* with
// X-Canvas-Conflict-Of (see objects.js).
export default async function workspaceSyncRoutes(fastify) {
    const send = (reply, response, code = null) => {
        if (code) response.code = code;
        return reply.code(response.statusCode).send(response.getResponse());
    };
    const fail = (request, reply, error) => {
        const statusCode = Number(error?.statusCode) || 500;
        if (statusCode >= 500) request.log.error(error);
        return send(reply, new ResponseObject().error(error?.message || 'Internal error', null, statusCode), error?.code || undefined);
    };

    fastify.get('/conflicts', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const conflicts = await request.workspace.listSyncConflicts();
            return send(reply, new ResponseObject().found(conflicts, 'OK', 200, conflicts.length));
        } catch (error) { return fail(request, reply, error); }
    });

    fastify.post('/conflicts/:docId/resolve', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            params: { type: 'object', required: ['docId'], properties: { docId: { type: 'string', pattern: '^[0-9]+$' } } },
            body: { type: 'object', required: ['keep'], properties: { keep: { type: 'string', enum: ['hub', 'incoming', 'both'] } } },
        },
    }, async (request, reply) => {
        try {
            const result = await request.workspace.resolveSyncConflict(Number(request.params.docId), { keep: request.body.keep });
            return send(reply, new ResponseObject().updated(result, 'Conflict resolved'));
        } catch (error) { return fail(request, reply, error); }
    });
}
