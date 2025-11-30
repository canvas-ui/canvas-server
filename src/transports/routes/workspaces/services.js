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
    const { workspaceManager } = options;

    /**
     * List all services and their status
     */
    fastify.get('/:workspaceId/services', async (request, reply) => {
        try {
            const { workspaceId } = request.params;
            const userId = request.user.id;

            const workspace = await workspaceManager.getWorkspace(workspaceId, userId);
            if (!workspace) {
                return reply.code(404).send(ResponseObject.error('Workspace not found'));
            }

            const servicesStatus = await workspaceManager.getServicesStatus(workspaceId, userId);

            return reply.send(ResponseObject.success({ services: servicesStatus }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Enable a service
     */
    fastify.post('/:workspaceId/services/:serviceName/enable', async (request, reply) => {
        try {
            const { workspaceId, serviceName } = request.params;
            const userId = request.user.id;

            const workspace = await workspaceManager.getWorkspace(workspaceId, userId);
            if (!workspace) {
                return reply.code(404).send(ResponseObject.error('Workspace not found'));
            }

            const result = await workspaceManager.enableService(workspaceId, userId, serviceName);

            return reply.send(ResponseObject.success({
                message: `Service ${serviceName} enabled successfully`,
                result
            }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Disable a service
     */
    fastify.post('/:workspaceId/services/:serviceName/disable', async (request, reply) => {
        try {
            const { workspaceId, serviceName } = request.params;
            const userId = request.user.id;

            const workspace = await workspaceManager.getWorkspace(workspaceId, userId);
            if (!workspace) {
                return reply.code(404).send(ResponseObject.error('Workspace not found'));
            }

            const result = await workspaceManager.disableService(workspaceId, userId, serviceName);

            return reply.send(ResponseObject.success({
                message: `Service ${serviceName} disabled successfully`,
                result
            }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Get service configuration
     */
    fastify.get('/:workspaceId/services/:serviceName/config', async (request, reply) => {
        try {
            const { workspaceId, serviceName } = request.params;
            const userId = request.user.id;

            const workspace = await workspaceManager.getWorkspace(workspaceId, userId);
            if (!workspace) {
                return reply.code(404).send(ResponseObject.error('Workspace not found'));
            }

            // Read config file from workspace/config/{serviceName}.json
            const configPath = path.join(workspace.rootPath, 'config', `${serviceName}.json`);

            try {
                const configContent = await fs.readFile(configPath, 'utf-8');
                const config = JSON.parse(configContent);

                return reply.send(ResponseObject.success({ config }));
            } catch (err) {
                if (err.code === 'ENOENT') {
                    return reply.send(ResponseObject.success({ config: null }));
                }
                throw err;
            }
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Update service configuration
     */
    fastify.put('/:workspaceId/services/:serviceName/config', async (request, reply) => {
        try {
            const { workspaceId, serviceName } = request.params;
            const { config } = request.body;
            const userId = request.user.id;

            if (!config) {
                return reply.code(400).send(ResponseObject.error('Config is required'));
            }

            const workspace = await workspaceManager.getWorkspace(workspaceId, userId);
            if (!workspace) {
                return reply.code(404).send(ResponseObject.error('Workspace not found'));
            }

            // Ensure config directory exists
            const configDir = path.join(workspace.rootPath, 'config');
            await fs.mkdir(configDir, { recursive: true });

            // Write config file
            const configPath = path.join(configDir, `${serviceName}.json`);
            await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

            return reply.send(ResponseObject.success({
                message: `Configuration for ${serviceName} updated successfully`,
                config
            }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });
}
