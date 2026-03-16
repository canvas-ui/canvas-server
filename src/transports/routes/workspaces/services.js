'use strict';

import ResponseObject from '../../ResponseObject.js';
import path from 'path';
import fs from 'fs/promises';

/**
 * Workspace Services Routes
 *
 * Manages workspace service configuration and lifecycle
 */
export default async function workspaceServicesRoutes(fastify, options) {
    /**
     * List all services and their status
     */
    fastify.get('/', {
        onRequest: [fastify.authenticate]
    }, async (request, reply) => {
        try {
            const { id: workspaceId, workspaceId: paramWorkspaceId } = request.params;
            const userId = request.user.id;

            const resolvedWorkspaceId = workspaceId || paramWorkspaceId;
            if (!resolvedWorkspaceId) {
                const response = new ResponseObject().badRequest('Workspace id is required');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const workspace = await fastify.workspaceManager.getWorkspace(resolvedWorkspaceId, userId);
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const servicesStatus = await fastify.workspaceManager.getServicesStatus(resolvedWorkspaceId, userId);

            const response = new ResponseObject().success(servicesStatus);
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    /**
     * Enable a service
     */
    fastify.post('/:serviceName/enable', {
        onRequest: [fastify.authenticate]
    }, async (request, reply) => {
        try {
            const { id: workspaceId, workspaceId: paramWorkspaceId, serviceName } = request.params;
            const userId = request.user.id;

            const resolvedWorkspaceId = workspaceId || paramWorkspaceId;
            if (!resolvedWorkspaceId) {
                const response = new ResponseObject().badRequest('Workspace id is required');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const workspace = await fastify.workspaceManager.getWorkspace(resolvedWorkspaceId, userId);
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const result = await fastify.workspaceManager.enableService(resolvedWorkspaceId, userId, serviceName);

            const response = new ResponseObject().success({
                message: `Service ${serviceName} enabled successfully`,
                result
            });
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    /**
     * Disable a service
     */
    fastify.post('/:serviceName/disable', {
        onRequest: [fastify.authenticate]
    }, async (request, reply) => {
        try {
            const { id: workspaceId, workspaceId: paramWorkspaceId, serviceName } = request.params;
            const userId = request.user.id;

            const resolvedWorkspaceId = workspaceId || paramWorkspaceId;
            if (!resolvedWorkspaceId) {
                const response = new ResponseObject().badRequest('Workspace id is required');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const workspace = await fastify.workspaceManager.getWorkspace(resolvedWorkspaceId, userId);
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const result = await fastify.workspaceManager.disableService(resolvedWorkspaceId, userId, serviceName);

            const response = new ResponseObject().success({
                message: `Service ${serviceName} disabled successfully`,
                result
            });
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    /**
     * Get service configuration
     */
    fastify.get('/:serviceName/config', {
        onRequest: [fastify.authenticate]
    }, async (request, reply) => {
        try {
            const { id: workspaceId, workspaceId: paramWorkspaceId, serviceName } = request.params;
            const userId = request.user.id;

            const resolvedWorkspaceId = workspaceId || paramWorkspaceId;
            if (!resolvedWorkspaceId) {
                const response = new ResponseObject().badRequest('Workspace id is required');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const workspace = await fastify.workspaceManager.getWorkspace(resolvedWorkspaceId, userId);
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            // Read config file from workspace/config/{serviceName}.json
            const configPath = path.join(workspace.rootPath, 'config', `${serviceName}.json`);

            try {
                const configContent = await fs.readFile(configPath, 'utf-8');
                const config = JSON.parse(configContent);

                const response = new ResponseObject().success({ config });
                return reply.code(response.statusCode).send(response.getResponse());
            } catch (err) {
                if (err.code === 'ENOENT') {
                    const response = new ResponseObject().success({ config: null });
                    return reply.code(response.statusCode).send(response.getResponse());
                }
                throw err;
            }
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    /**
     * Update service configuration
     */
    fastify.put('/:serviceName/config', {
        onRequest: [fastify.authenticate]
    }, async (request, reply) => {
        try {
            const { id: workspaceId, workspaceId: paramWorkspaceId, serviceName } = request.params;
            const { config } = request.body;
            const userId = request.user.id;

            const resolvedWorkspaceId = workspaceId || paramWorkspaceId;
            if (!resolvedWorkspaceId) {
                const response = new ResponseObject().badRequest('Workspace id is required');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            if (!config) {
                const response = new ResponseObject().badRequest('Config is required');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const workspace = await fastify.workspaceManager.getWorkspace(resolvedWorkspaceId, userId);
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            // Ensure config directory exists
            const configDir = path.join(workspace.rootPath, 'config');
            await fs.mkdir(configDir, { recursive: true });

            // Write config file
            const configPath = path.join(configDir, `${serviceName}.json`);
            await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

            if (serviceName === 'imap' && fastify.workspaceManager?.imapService && workspace.isServiceEnabled('imap')) {
                await fastify.workspaceManager.imapService.reload(workspace);
            }

            const response = new ResponseObject().success({
                message: `Configuration for ${serviceName} updated successfully`,
                config
            });
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });
}
