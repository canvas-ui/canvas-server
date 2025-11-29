'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceAdmin } from '../../middleware/workspace-acl.js';

/**
 * Workspace services routes - enable/disable dotfiles, home, etc.
 * @param {FastifyInstance} fastify - Fastify instance
 */
export default async function workspaceServicesRoutes(fastify, options) {
    /**
     * GET /workspaces/:id/services
     * Get status of all services for a workspace
     */
    fastify.get('/', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
        schema: {
            params: {
                type: 'object',
                required: ['id'],
                properties: {
                    id: { type: 'string' }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const workspace = request.workspace;

            const status = await fastify.workspaceManager.getServicesStatus(
                workspace.id,
                request.user.id
            );

            const responseObject = new ResponseObject().found(
                status,
                'Services status retrieved successfully'
            );
            return reply.code(responseObject.statusCode).send(responseObject.getResponse());
        } catch (error) {
            fastify.log.error(error);
            const responseObject = new ResponseObject().serverError('Failed to get services status');
            return reply.code(responseObject.statusCode).send(responseObject.getResponse());
        }
    });

    /**
     * POST /workspaces/:id/services/:service/enable
     * Enable a service for a workspace
     */
    fastify.post('/:service/enable', {
        onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
        schema: {
            params: {
                type: 'object',
                required: ['id', 'service'],
                properties: {
                    id: { type: 'string' },
                    service: { type: 'string', enum: ['dotfiles', 'home'] }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const workspace = request.workspace;
            const serviceName = request.params.service;

            const result = await fastify.workspaceManager.enableService(
                workspace.id,
                request.user.id,
                serviceName
            );

            const responseObject = new ResponseObject().success(
                result,
                `Service '${serviceName}' enabled successfully`
            );
            return reply.code(responseObject.statusCode).send(responseObject.getResponse());
        } catch (error) {
            fastify.log.error(error);
            const responseObject = new ResponseObject().serverError(
                error.message || `Failed to enable service`
            );
            return reply.code(responseObject.statusCode).send(responseObject.getResponse());
        }
    });

    /**
     * POST /workspaces/:id/services/:service/disable
     * Disable a service for a workspace
     */
    fastify.post('/:service/disable', {
        onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
        schema: {
            params: {
                type: 'object',
                required: ['id', 'service'],
                properties: {
                    id: { type: 'string' },
                    service: { type: 'string', enum: ['dotfiles', 'home'] }
                }
            }
        }
    }, async (request, reply) => {
        try {
            const workspace = request.workspace;
            const serviceName = request.params.service;

            const result = await fastify.workspaceManager.disableService(
                workspace.id,
                request.user.id,
                serviceName
            );

            const responseObject = new ResponseObject().success(
                result,
                `Service '${serviceName}' disabled successfully`
            );
            return reply.code(responseObject.statusCode).send(responseObject.getResponse());
        } catch (error) {
            fastify.log.error(error);
            const responseObject = new ResponseObject().serverError(
                error.message || `Failed to disable service`
            );
            return reply.code(responseObject.statusCode).send(responseObject.getResponse());
        }
    });
}

