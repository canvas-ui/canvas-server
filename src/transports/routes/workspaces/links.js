'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

/**
 * Workspace Links Routes
 *
 * Manages portable, workspace-scoped references to other resources.
 *
 * Stored in workspace config:
 *   links: { [type]: string[] }
 */
export default async function workspaceLinksRoutes(fastify, _options) {
    /**
     * Get all links (by type)
     */
    fastify.get('/', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const links = request.workspace?.links || {};
            const response = new ResponseObject().found({ links }, 'Workspace links retrieved successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().serverError('Failed to get workspace links');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    /**
     * Get links for a specific type
     */
    fastify.get('/:type', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
        schema: {
            params: {
                type: 'object',
                required: ['type'],
                properties: {
                    type: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { type } = request.params;
            const refs = request.workspace?.listLinks(type) || [];
            const response = new ResponseObject().found({ type, refs }, 'Workspace links retrieved successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().serverError('Failed to get workspace links');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    /**
     * Add link(s) for a specific type
     *
     * Body supports:
     *  - { ref: "..." }
     *  - { refs: ["...", "..."] }
     */
    fastify.post('/:type', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            params: {
                type: 'object',
                required: ['type'],
                properties: {
                    type: { type: 'string' },
                },
            },
            body: {
                type: 'object',
                properties: {
                    ref: { type: 'string' },
                    refs: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { type } = request.params;
            const refs = request.body?.refs || (request.body?.ref ? [request.body.ref] : []);
            if (!refs.length) {
                const response = new ResponseObject().badRequest('ref or refs is required');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            for (const ref of refs) {
                request.workspace.addLink(type, ref);
            }

            const updated = request.workspace.listLinks(type);
            const response = new ResponseObject().success({ type, refs: updated }, 'Workspace links updated successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().serverError('Failed to update workspace links');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    /**
     * Remove link(s) for a specific type
     *
     * Body supports:
     *  - { ref: "..." }
     *  - { refs: ["...", "..."] }
     */
    fastify.delete('/:type', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            params: {
                type: 'object',
                required: ['type'],
                properties: {
                    type: { type: 'string' },
                },
            },
            body: {
                type: 'object',
                properties: {
                    ref: { type: 'string' },
                    refs: { type: 'array', items: { type: 'string' } },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { type } = request.params;
            const refs = request.body?.refs || (request.body?.ref ? [request.body.ref] : []);
            if (!refs.length) {
                const response = new ResponseObject().badRequest('ref or refs is required');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            for (const ref of refs) {
                request.workspace.removeLink(type, ref);
            }

            const updated = request.workspace.listLinks(type);
            const response = new ResponseObject().success({ type, refs: updated }, 'Workspace links updated successfully');
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().serverError('Failed to update workspace links');
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });
}

