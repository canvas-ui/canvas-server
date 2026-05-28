'use strict';

import ResponseObject from '../../ResponseObject.js';
import path from 'path';
import fs from 'fs/promises';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

/**
 * Workspace Services Routes
 *
 * Manages workspace service configuration and lifecycle
 */
export default async function workspaceServicesRoutes(fastify, options) {
    /**
     * List data backends and runtime status
     */
    fastify.get('/data-backends', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()]
    }, async (request, reply) => {
        try {
            const workspace = request.workspace;
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const response = new ResponseObject().success(workspace.getDataBackendStatus());
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    /**
     * Patch data backend configuration
     */
    fastify.patch('/data-backends', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()]
    }, async (request, reply) => {
        try {
            const workspace = request.workspace;
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const updates = request.body?.dataBackends || request.body || {};
            if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
                const response = new ResponseObject().badRequest('Data backend config object is required');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            for (const [backendName, config] of Object.entries(updates)) {
                if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
                await workspace.setDataBackendConfig(backendName, config);
                if (backendName === 'fs:home' && typeof config.enabled === 'boolean') {
                    if (config.enabled) {
                        await workspace.startHomeService();
                    } else {
                        await workspace.stopHomeService();
                    }
                }
            }

            const response = new ResponseObject().success(workspace.getDataBackendStatus());
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    /**
     * Resync one data backend
     */
    fastify.post('/data-backends/:backendId/resync', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()]
    }, async (request, reply) => {
        try {
            const workspace = request.workspace;
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const backendId = decodeURIComponent(request.params.backendId);
            const result = await workspace.resyncDataBackend(backendId);
            const response = new ResponseObject().success(result);
            return reply.code(response.statusCode).send(response.getResponse());
        } catch (error) {
            request.log.error(error);
            const response = new ResponseObject().error(error.message);
            return reply.code(response.statusCode).send(response.getResponse());
        }
    });

    /**
     * List all services and their status
     */
    fastify.get('/', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()]
    }, async (request, reply) => {
        try {
            const workspace = request.workspace;
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const servicesStatus = await fastify.workspaceManager.getServicesStatus(workspace.id, request.user.id);

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
        onRequest: [fastify.authenticate, requireWorkspaceWrite()]
    }, async (request, reply) => {
        try {
            const { serviceName } = request.params;
            const workspace = request.workspace;
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const result = await fastify.workspaceManager.enableService(workspace.id, request.user.id, serviceName);

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
        onRequest: [fastify.authenticate, requireWorkspaceWrite()]
    }, async (request, reply) => {
        try {
            const { serviceName } = request.params;
            const workspace = request.workspace;
            if (!workspace) {
                const response = new ResponseObject().notFound('Workspace not found');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const result = await fastify.workspaceManager.disableService(workspace.id, request.user.id, serviceName);

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
        onRequest: [fastify.authenticate, requireWorkspaceRead()]
    }, async (request, reply) => {
        try {
            const { serviceName } = request.params;
            const workspace = request.workspace;
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
        onRequest: [fastify.authenticate, requireWorkspaceWrite()]
    }, async (request, reply) => {
        try {
            const { serviceName } = request.params;
            const { config } = request.body;

            if (!config) {
                const response = new ResponseObject().badRequest('Config is required');
                return reply.code(response.statusCode).send(response.getResponse());
            }

            const workspace = request.workspace;
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

            // IMAP mailbox config lives in config/stored.json (managed via the
            // /services/imap routes); re-arm sources when the service is enabled.
            if (serviceName === 'imap' && workspace.isServiceEnabled('imap')) {
                await workspace.enableImap();
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
