'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

export default async function workspaceDataBackendRoutes(fastify) {
    fastify.get('/', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()]
    }, async (request, reply) => {
        try {
            const response = new ResponseObject().success(request.workspace.getDataBackendStatus());
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.patch('/', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()]
    }, async (request, reply) => {
        try {
            const updates = request.body?.dataBackends || request.body || {};
            if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
                const response = new ResponseObject().badRequest('Data backend config object is required');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            for (const [backendName, config] of Object.entries(updates)) {
                if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
                request.workspace.setDataBackendConfig(backendName, config);
                if (backendName === 'fs:home' && typeof config.enabled === 'boolean') {
                    if (config.enabled) {
                        await request.workspace.startHomeService();
                    } else {
                        await request.workspace.stopHomeService();
                    }
                }
            }

            const response = new ResponseObject().success(request.workspace.getDataBackendStatus());
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    fastify.post('/:backendId/resync', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()]
    }, async (request, reply) => {
        try {
            const backendId = decodeURIComponent(request.params.backendId);
            const result = await request.workspace.resyncDataBackend(backendId);
            const response = new ResponseObject().success(result);
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });
}
