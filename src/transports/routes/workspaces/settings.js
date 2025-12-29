'use strict';

import ResponseObject from '../../ResponseObject.js';

/**
 * Workspace Settings Routes
 *
 * Manages workspace settings and configuration
 */
export default async function workspaceSettingsRoutes(fastify, options) {
    const { workspaceManager } = options;

    /**
     * Get workspace settings
     */
    fastify.get('/:workspaceId/settings', async (request, reply) => {
        try {
            const { workspaceId } = request.params;
            const userId = request.user.id;

            const workspace = await workspaceManager.getWorkspace(workspaceId, userId);
            if (!workspace) {
                return reply.code(404).send(ResponseObject.error('Workspace not found'));
            }

            const settings = {
                id: workspace.id,
                name: workspace.name,
                label: workspace.label,
                description: workspace.description,
                color: workspace.color,
                type: workspace.type,
                owner: workspace.owner,
                services: workspace.services,
                acl: workspace.acl,
                rootPath: workspace.rootPath,
                status: workspace.status,
            };

            return reply.send(ResponseObject.success({ settings }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });

    /**
     * Update workspace settings
     */
    fastify.put('/:workspaceId/settings', async (request, reply) => {
        try {
            const { workspaceId } = request.params;
            const { name, label, description, color, services } = request.body;
            const userId = request.user.id;

            const workspace = await workspaceManager.getWorkspace(workspaceId, userId);
            if (!workspace) {
                return reply.code(404).send(ResponseObject.error('Workspace not found'));
            }

            // Build updates object
            const updates = {};
            if (name !== undefined) updates.name = name;
            if (label !== undefined) updates.label = label;
            if (description !== undefined) updates.description = description;
            if (color !== undefined) updates.color = color;
            if (services !== undefined) updates.services = services;

            // Update workspace configuration
            const success = await workspaceManager.updateWorkspaceConfig(
                workspace.owner,
                workspaceId,
                userId,
                updates
            );

            if (!success) {
                return reply.code(500).send(ResponseObject.error('Failed to update workspace settings'));
            }

            // Reload workspace to get updated settings
            const updatedWorkspace = await workspaceManager.getWorkspace(workspaceId, userId);

            const settings = {
                id: updatedWorkspace.id,
                name: updatedWorkspace.name,
                label: updatedWorkspace.label,
                description: updatedWorkspace.description,
                color: updatedWorkspace.color,
                type: updatedWorkspace.type,
                owner: updatedWorkspace.owner,
                services: updatedWorkspace.services,
            };

            return reply.send(ResponseObject.success({
                message: 'Workspace settings updated successfully',
                settings
            }));
        } catch (error) {
            request.log.error(error);
            return reply.code(500).send(ResponseObject.error(error.message));
        }
    });
}
