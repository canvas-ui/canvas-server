'use strict';

// Utils
import express from 'express';

// Logging
import { createDebug } from '../../../utils/log/index.js';
const debug = createDebug('api:roles');

/**
 * Role API Routes
 * Provides REST endpoints for role lifecycle management
 */
class RoleAPI {

    #roles;
    #userManager;
    #workspaceManager;
    #router;

    /**
     * Create RoleAPI instance
     * @param {Object} options - Configuration options
     * @param {Object} options.roles - Roles service instance
     * @param {Object} options.userManager - UserManager instance
     * @param {Object} options.workspaceManager - WorkspaceManager instance
     */
    constructor(options = {}) {
        if (!options.roles) {
            throw new Error('Roles service is required for RoleAPI');
        }
        if (!options.userManager) {
            throw new Error('UserManager is required for RoleAPI');
        }
        if (!options.workspaceManager) {
            throw new Error('WorkspaceManager is required for RoleAPI');
        }

        this.#roles = options.roles;
        this.#userManager = options.userManager;
        this.#workspaceManager = options.workspaceManager;
        this.#router = express.Router();

        this.#setupRoutes();
        debug('RoleAPI initialized');
    }

    /**
     * Get Express router
     * @returns {express.Router} Configured router
     */
    getRouter() {
        return this.#router;
    }

    /**
     * Setup API routes
     * @private
     */
    #setupRoutes() {
        // Role management routes
        this.#router.get('/roles', this.#listRoles.bind(this));
        this.#router.post('/roles', this.#createRole.bind(this));
        this.#router.get('/roles/:roleId', this.#getRole.bind(this));
        this.#router.put('/roles/:roleId', this.#updateRole.bind(this));
        this.#router.delete('/roles/:roleId', this.#removeRole.bind(this));

        // Role lifecycle routes
        this.#router.post('/roles/:roleId/start', this.#startRole.bind(this));
        this.#router.post('/roles/:roleId/stop', this.#stopRole.bind(this));
        this.#router.post('/roles/:roleId/restart', this.#restartRole.bind(this));

        // Role information routes
        this.#router.get('/roles/:roleId/logs', this.#getRoleLogs.bind(this));
        this.#router.get('/roles/:roleId/stats', this.#getRoleStats.bind(this));
        this.#router.get('/roles/:roleId/health', this.#getRoleHealth.bind(this));

        // Role template routes
        this.#router.get('/role-templates', this.#listRoleTemplates.bind(this));
        this.#router.get('/role-templates/:templateName', this.#getRoleTemplate.bind(this));

        // Workspace role association routes
        this.#router.get('/workspaces/:workspaceId/roles', this.#getWorkspaceRoles.bind(this));
        this.#router.post('/workspaces/:workspaceId/roles/:roleId', this.#associateWorkspaceRole.bind(this));
        this.#router.delete('/workspaces/:workspaceId/roles/:roleId', this.#disassociateWorkspaceRole.bind(this));

        debug('Role API routes configured');
    }

    /**
     * List roles
     * GET /api/roles?type=user&userId=123
     */
    async #listRoles(req, res) {
        try {
            const { type, userId, workspaceId, status } = req.query;
            const requestingUserId = req.user?.id;

            const filters = {};
            if (type) filters.type = type;
            if (userId) filters.userId = userId;
            if (workspaceId) filters.workspaceId = workspaceId;
            if (status) filters.status = status;

            const roles = this.#roles.list(filters);

            // Filter based on user permissions
            const accessibleRoles = roles.filter(role => {
                return this.#checkRoleAccess(role, requestingUserId, 'read');
            });

            res.json({
                success: true,
                roles: accessibleRoles,
                total: accessibleRoles.length
            });

            debug(`Listed ${accessibleRoles.length} roles for user ${requestingUserId}`);
        } catch (error) {
            this.#handleError(res, error, 'Failed to list roles');
        }
    }

    /**
     * Create new role
     * POST /api/roles
     */
    async #createRole(req, res) {
        try {
            const { template, name, type, userId, workspaceId, config } = req.body;
            const requestingUserId = req.user?.id;

            if (!template || !name || !type) {
                return res.status(400).json({
                    success: false,
                    error: 'template, name, and type are required'
                });
            }

            // Check permissions for role creation
            if (!this.#checkRoleCreationPermissions(type, userId, workspaceId, requestingUserId)) {
                return res.status(403).json({
                    success: false,
                    error: 'Permission denied to create this type of role'
                });
            }

            const roleConfig = await this.#roles.create(template, {
                name,
                type,
                userId,
                workspaceId,
                config
            });

            res.status(201).json({
                success: true,
                role: roleConfig
            });

            debug(`Created role ${roleConfig.id} (${name}) for user ${requestingUserId}`);
        } catch (error) {
            this.#handleError(res, error, 'Failed to create role');
        }
    }

    /**
     * Get role by ID
     * GET /api/roles/:roleId
     */
    async #getRole(req, res) {
        try {
            const { roleId } = req.params;
            const requestingUserId = req.user?.id;

            const role = await this.#roles.get(roleId, requestingUserId);
            if (!role) {
                return res.status(404).json({
                    success: false,
                    error: 'Role not found'
                });
            }

            res.json({
                success: true,
                role: role.toJSON()
            });
        } catch (error) {
            this.#handleError(res, error, 'Failed to get role');
        }
    }

    /**
     * Update role configuration
     * PUT /api/roles/:roleId
     */
    async #updateRole(req, res) {
        try {
            const { roleId } = req.params;
            const { config } = req.body;
            const requestingUserId = req.user?.id;

            const role = await this.#roles.get(roleId, requestingUserId);
            if (!role) {
                return res.status(404).json({
                    success: false,
                    error: 'Role not found'
                });
            }

            await role.updateConfig(config);

            res.json({
                success: true,
                role: role.toJSON()
            });

            debug(`Updated role ${roleId} configuration`);
        } catch (error) {
            this.#handleError(res, error, 'Failed to update role');
        }
    }

    /**
     * Remove role
     * DELETE /api/roles/:roleId?force=true
     */
    async #removeRole(req, res) {
        try {
            const { roleId } = req.params;
            const { force } = req.query;
            const requestingUserId = req.user?.id;

            const success = await this.#roles.remove(roleId, requestingUserId, force === 'true');

            res.json({
                success,
                message: success ? 'Role removed successfully' : 'Failed to remove role'
            });

            debug(`Removed role ${roleId}, force: ${force}`);
        } catch (error) {
            this.#handleError(res, error, 'Failed to remove role');
        }
    }

    /**
     * Start role
     * POST /api/roles/:roleId/start
     */
    async #startRole(req, res) {
        try {
            const { roleId } = req.params;
            const requestingUserId = req.user?.id;

            const role = await this.#roles.start(roleId, requestingUserId);

            res.json({
                success: true,
                role: role.toJSON()
            });

            debug(`Started role ${roleId}`);
        } catch (error) {
            this.#handleError(res, error, 'Failed to start role');
        }
    }

    /**
     * Stop role
     * POST /api/roles/:roleId/stop
     */
    async #stopRole(req, res) {
        try {
            const { roleId } = req.params;
            const requestingUserId = req.user?.id;

            const success = await this.#roles.stop(roleId, requestingUserId);

            res.json({
                success,
                message: success ? 'Role stopped successfully' : 'Failed to stop role'
            });

            debug(`Stopped role ${roleId}`);
        } catch (error) {
            this.#handleError(res, error, 'Failed to stop role');
        }
    }

    /**
     * Restart role
     * POST /api/roles/:roleId/restart
     */
    async #restartRole(req, res) {
        try {
            const { roleId } = req.params;
            const requestingUserId = req.user?.id;

            const role = await this.#roles.get(roleId, requestingUserId);
            if (!role) {
                return res.status(404).json({
                    success: false,
                    error: 'Role not found'
                });
            }

            await role.restart();

            res.json({
                success: true,
                role: role.toJSON()
            });

            debug(`Restarted role ${roleId}`);
        } catch (error) {
            this.#handleError(res, error, 'Failed to restart role');
        }
    }

    /**
     * Get role logs
     * GET /api/roles/:roleId/logs?tail=100&follow=false
     */
    async #getRoleLogs(req, res) {
        try {
            const { roleId } = req.params;
            const { tail, follow } = req.query;
            const requestingUserId = req.user?.id;

            const role = await this.#roles.get(roleId, requestingUserId);
            if (!role) {
                return res.status(404).json({
                    success: false,
                    error: 'Role not found'
                });
            }

            const logStream = await role.getLogs({
                tail: parseInt(tail) || 100,
                follow: follow === 'true'
            });

            if (follow === 'true') {
                // Stream logs for follow mode
                res.setHeader('Content-Type', 'text/plain');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                logStream.pipe(res);
            } else {
                // Return logs as JSON
                let logs = '';
                logStream.on('data', chunk => logs += chunk);
                logStream.on('end', () => {
                    res.json({
                        success: true,
                        logs: logs.split('\n').filter(line => line.trim())
                    });
                });
            }
        } catch (error) {
            this.#handleError(res, error, 'Failed to get role logs');
        }
    }

    /**
     * Get role statistics
     * GET /api/roles/:roleId/stats
     */
    async #getRoleStats(req, res) {
        try {
            const { roleId } = req.params;
            const requestingUserId = req.user?.id;

            const role = await this.#roles.get(roleId, requestingUserId);
            if (!role) {
                return res.status(404).json({
                    success: false,
                    error: 'Role not found'
                });
            }

            const stats = await role.getStats();

            res.json({
                success: true,
                stats
            });
        } catch (error) {
            this.#handleError(res, error, 'Failed to get role statistics');
        }
    }

    /**
     * Get role health status
     * GET /api/roles/:roleId/health
     */
    async #getRoleHealth(req, res) {
        try {
            const { roleId } = req.params;
            const requestingUserId = req.user?.id;

            const role = await this.#roles.get(roleId, requestingUserId);
            if (!role) {
                return res.status(404).json({
                    success: false,
                    error: 'Role not found'
                });
            }

            let health = { status: 'unknown' };
            if (role.getHealthStatus) {
                health = await role.getHealthStatus();
            } else {
                health = {
                    status: role.isRunning ? 'healthy' : 'stopped'
                };
            }

            res.json({
                success: true,
                health
            });
        } catch (error) {
            this.#handleError(res, error, 'Failed to get role health');
        }
    }

    /**
     * List available role templates
     * GET /api/role-templates
     */
    async #listRoleTemplates(req, res) {
        try {
            // This would scan the extensions/roles directory
            // For now, return a placeholder
            res.json({
                success: true,
                templates: [
                    { id: 'minio-s3', name: 'MinIO S3 Storage', type: 'global' },
                    { id: 'llm-agent', name: 'LLM Agent', type: 'user' },
                    { id: 'dev-environment', name: 'Development Environment', type: 'workspace' }
                ]
            });
        } catch (error) {
            this.#handleError(res, error, 'Failed to list role templates');
        }
    }

    /**
     * Get role template
     * GET /api/role-templates/:templateName
     */
    async #getRoleTemplate(req, res) {
        try {
            const { templateName } = req.params;

            // This would load the actual template from extensions/roles
            // For now, return a placeholder
            res.json({
                success: true,
                template: {
                    id: templateName,
                    name: `Template ${templateName}`,
                    description: `Role template for ${templateName}`
                }
            });
        } catch (error) {
            this.#handleError(res, error, 'Failed to get role template');
        }
    }

    /**
     * Get workspace roles
     * GET /api/workspaces/:workspaceId/roles
     */
    async #getWorkspaceRoles(req, res) {
        try {
            const { workspaceId } = req.params;
            const requestingUserId = req.user?.id;

            // Get user from workspace
            const workspace = await this.#workspaceManager.getWorkspaceById(workspaceId, requestingUserId);
            if (!workspace) {
                return res.status(404).json({
                    success: false,
                    error: 'Workspace not found'
                });
            }

            const roleIds = await this.#workspaceManager.getWorkspaceRoles(workspace.owner, workspaceId, requestingUserId);
            const roles = [];

            for (const roleId of roleIds) {
                try {
                    const role = await this.#roles.get(roleId, requestingUserId);
                    if (role) {
                        roles.push(role.toJSON());
                    }
                } catch (error) {
                    debug(`Failed to get role ${roleId}: ${error.message}`);
                }
            }

            res.json({
                success: true,
                roles,
                total: roles.length
            });
        } catch (error) {
            this.#handleError(res, error, 'Failed to get workspace roles');
        }
    }

    /**
     * Associate role with workspace
     * POST /api/workspaces/:workspaceId/roles/:roleId
     */
    async #associateWorkspaceRole(req, res) {
        try {
            const { workspaceId, roleId } = req.params;
            const requestingUserId = req.user?.id;

            // Get workspace to find owner
            const workspace = await this.#workspaceManager.getWorkspaceById(workspaceId, requestingUserId);
            if (!workspace) {
                return res.status(404).json({
                    success: false,
                    error: 'Workspace not found'
                });
            }

            const success = await this.#workspaceManager.associateRole(
                workspace.owner,
                workspaceId,
                roleId,
                requestingUserId
            );

            res.json({
                success,
                message: success ? 'Role associated successfully' : 'Failed to associate role'
            });
        } catch (error) {
            this.#handleError(res, error, 'Failed to associate role with workspace');
        }
    }

    /**
     * Disassociate role from workspace
     * DELETE /api/workspaces/:workspaceId/roles/:roleId
     */
    async #disassociateWorkspaceRole(req, res) {
        try {
            const { workspaceId, roleId } = req.params;
            const requestingUserId = req.user?.id;

            // Get workspace to find owner
            const workspace = await this.#workspaceManager.getWorkspaceById(workspaceId, requestingUserId);
            if (!workspace) {
                return res.status(404).json({
                    success: false,
                    error: 'Workspace not found'
                });
            }

            const success = await this.#workspaceManager.disassociateRole(
                workspace.owner,
                workspaceId,
                roleId,
                requestingUserId
            );

            res.json({
                success,
                message: success ? 'Role disassociated successfully' : 'Failed to disassociate role'
            });
        } catch (error) {
            this.#handleError(res, error, 'Failed to disassociate role from workspace');
        }
    }

    /**
     * Private helper methods
     */

    /**
     * Check if user has access to a role
     * @param {Object} role - Role configuration
     * @param {string} userId - User ID
     * @param {string} action - Action to check
     * @returns {boolean} Access granted
     * @private
     */
    #checkRoleAccess(role, userId, action) {
        // For now, simple ownership check
        if (role.type === 'global') {
            return true; // Global roles visible to all
        }

        return role.userId === userId;
    }

    /**
     * Check role creation permissions
     * @param {string} type - Role type
     * @param {string} userId - Target user ID
     * @param {string} workspaceId - Target workspace ID
     * @param {string} requestingUserId - Requesting user ID
     * @returns {boolean} Permission granted
     * @private
     */
    #checkRoleCreationPermissions(type, userId, workspaceId, requestingUserId) {
        switch (type) {
            case 'global':
                // Only admins can create global roles (simplified)
                return true; // For now, allow all
            case 'user':
                // Can only create roles for self
                return userId === requestingUserId;
            case 'workspace':
                // Must own the workspace
                return userId === requestingUserId;
            default:
                return false;
        }
    }

    /**
     * Handle API errors
     * @param {express.Response} res - Response object
     * @param {Error} error - Error to handle
     * @param {string} message - Default error message
     * @private
     */
    #handleError(res, error, message) {
        debug(`API Error: ${message} - ${error.message}`);

        const statusCode = error.status || 500;
        res.status(statusCode).json({
            success: false,
            error: error.message || message
        });
    }
}

export default RoleAPI;
