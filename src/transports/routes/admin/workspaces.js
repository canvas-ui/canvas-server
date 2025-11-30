'use strict';

import ResponseObject from '../../ResponseObject.js';

/**
 * Admin Workspaces Routes
 *
 * Admin-only routes for managing all workspaces
 */
export default async function adminWorkspacesRoutes(fastify, options) {
    const { workspaceManager, users } = options;

    // Middleware to check admin role
    const checkAdmin = async (request, reply) => {
        const userId = request.user.id;
        const user = await users.get(userId);

        if (!user || user.userType !== 'admin') {
            return reply.code(403).send(ResponseObject.error('Admin access required'));
        }
    };

    fastify.addHook('onRequest', checkAdmin);

    /**
     * List all workspaces
     */
    fastify.get('/', async (request, reply) => {
        try {
            // List all workspaces (no userId filter for admin)
            const allWorkspaces = await workspaceManager.listWorkspaces();

            return reply.send(ResponseObject.success({ workspaces: allWorkspaces }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Get workspace details
     */
    fastify.get('/:workspaceId', async (request, reply) => {
        try {
            const { workspaceId } = request.params;

            // Admin can access any workspace
            const workspace = await workspaceManager.getWorkspace(workspaceId);
            if (!workspace) {
                return reply.code(404).send(ResponseObject.error('Workspace not found'));
            }

            const details = {
                id: workspace.id,
                name: workspace.name,
                label: workspace.label,
                description: workspace.description,
                color: workspace.color,
                type: workspace.type,
                owner: workspace.owner,
                rootPath: workspace.rootPath,
                status: workspace.status,
                isActive: workspace.isActive,
                services: workspace.services,
            };

            return reply.send(ResponseObject.success({ workspace: details }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Update workspace
     */
    fastify.put('/:workspaceId', async (request, reply) => {
        try {
            const { workspaceId } = request.params;
            const { name, label, description, color, owner } = request.body;

            const workspace = await workspaceManager.getWorkspace(workspaceId);
            if (!workspace) {
                return reply.code(404).send(ResponseObject.error('Workspace not found'));
            }

            // Build updates
            const updates = {};
            if (name !== undefined) updates.name = name;
            if (label !== undefined) updates.label = label;
            if (description !== undefined) updates.description = description;
            if (color !== undefined) updates.color = color;
            if (owner !== undefined) updates.owner = owner;

            const success = await workspaceManager.updateWorkspaceConfig(
                workspace.owner,
                workspaceId,
                request.user.id,
                updates
            );

            if (!success) {
                return reply.code(500).send(ResponseObject.error('Failed to update workspace'));
            }

            return reply.send(ResponseObject.success({ message: 'Workspace updated successfully' }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Delete workspace
     */
    fastify.delete('/:workspaceId', async (request, reply) => {
        try {
            const { workspaceId } = request.params;
            const { destroyData } = request.query;

            const workspace = await workspaceManager.getWorkspace(workspaceId);
            if (!workspace) {
                return reply.code(404).send(ResponseObject.error('Workspace not found'));
            }

            await workspaceManager.removeWorkspace(
                workspaceId,
                workspace.owner,
                destroyData === 'true'
            );

            return reply.send(ResponseObject.success({
                message: 'Workspace deleted successfully',
                dataDestroyed: destroyData === 'true'
            }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });
}
