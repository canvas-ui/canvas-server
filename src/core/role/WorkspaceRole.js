'use strict';

// Utils
import path from 'path';

// Base class
import Role from './Role.js';

// Logging
import { createLogger } from '../../utils/log.js';
const logger = createLogger('role-manager:workspace-role');

/**
 * Workspace Role Class
 * Represents workspace-scoped roles (including universe workspace)
 */
class WorkspaceRole extends Role {

    #workspaceManager;

    /**
     * Create a WorkspaceRole instance
     * @param {Object} options - Role options
     * @param {Object} options.workspaceManager - WorkspaceManager instance
     */
    constructor(options = {}) {
        super(options);

        if (!options.workspaceManager) {
            throw new Error('WorkspaceManager is required for WorkspaceRole');
        }

        this.#workspaceManager = options.workspaceManager;

        logger.debug(`WorkspaceRole instance created: ${this.id} (${this.name}) for workspace: ${this.workspaceId}`);
    }

    /**
     * Getters
     */
    get workspaceManager() { return this.#workspaceManager; }

    /**
     * Prepare container configuration for workspace roles
     * @param {Object} containerConfig - Base container configuration
     * @returns {Promise<Object>} Modified container configuration
     * @protected
     */
    async _prepareContainerConfig(containerConfig) {
        const config = await super._prepareContainerConfig(containerConfig);

        // Get workspace information
        const workspace = await this.#workspaceManager.getWorkspaceById(this.workspaceId);
        if (!workspace) {
            throw new Error(`Workspace not found: ${this.workspaceId}`);
        }

        // Remove port bindings for workspace roles (use sockets instead)
        config.HostConfig = {
            ...config.HostConfig,
            PortBindings: {}, // Clear port bindings
            AutoRemove: false,
            NetworkMode: 'none', // No network access by default, communication via sockets
        };
        config.ExposedPorts = {}; // Clear exposed ports

        // Add socket directory mount
        const socketDir = `${workspace.rootPath}/var/run:/var/run/sockets:rw`;
        const existingBinds = config.HostConfig.Binds || [];
        config.HostConfig.Binds = [...existingBinds, socketDir];

        // Add workspace-specific environment variables
        const workspaceEnv = [
            `CANVAS_WORKSPACE_ID=${workspace.id}`,
            `CANVAS_WORKSPACE_NAME=${workspace.name}`,
            `CANVAS_WORKSPACE_PATH=${workspace.rootPath}`,
            `CANVAS_WORKSPACE_TYPE=${workspace.type}`,
            `CANVAS_ROLE_SOCKET=/var/run/sockets/${this.id}-api.sock`,
            `CANVAS_COMMUNICATION_MODE=unix_socket`,
        ];

        config.Env = [...(config.Env || []), ...workspaceEnv];

        // Add labels to identify as workspace role
        config.Labels = {
            ...(config.Labels || {}),
            'canvas.role.type': this.type,
            'canvas.role.id': this.id,
            'canvas.role.name': this.name,
            'canvas.role.template': this.template,
            'canvas.role.workspaceId': this.workspaceId,
            'canvas.role.communication': 'unix_socket',
            'canvas.workspace.name': workspace.name,
            'canvas.workspace.type': workspace.type
        };

        logger.debug(`Prepared workspace role container config for ${this.id} (workspace: ${this.workspaceId}) with Unix socket`);
        return config;
    }

    /**
     * Get workspace information for this role
     * @returns {Promise<Object>} Workspace information
     */
    async getWorkspaceInfo() {
        return await this.#workspaceManager.getWorkspaceById(this.workspaceId);
    }

    /**
     * Get role's socket path
     * @param {string} [socketName='api'] - Socket name
     * @returns {Promise<string>} Socket path
     */
    async getSocketPath(socketName = 'api') {
        const workspace = await this.#workspaceManager.getWorkspaceById(this.workspaceId);
        if (!workspace) {
            throw new Error(`Workspace not found: ${this.workspaceId}`);
        }

        return path.join(workspace.rootPath, 'var', 'run', `${this.id}-${socketName}.sock`);
    }

    /**
     * Check if role socket is active
     * @param {string} [socketName='api'] - Socket name
     * @returns {Promise<boolean>} Socket is active
     */
    async isSocketActive(socketName = 'api') {
        try {
            const socketPath = await this.getSocketPath(socketName);
            const exists = require('fs').existsSync(socketPath);

            if (!exists) return false;

            // Simple socket test - try to stat the file
            const stats = await require('fs').promises.stat(socketPath);
            return stats.isSocket();
        } catch (error) {
            logger.debug(`Failed to check socket status: ${error.message}`);
            return false;
        }
    }

    /**
     * Convert to JSON with workspace role specific information
     * @returns {Object} JSON representation
     */
    toJSON() {
        const base = super.toJSON();
        return {
            ...base,
            scope: 'workspace',
            communication: 'unix_socket',
            workspace: {
                id: this.workspaceId
            },
            capabilities: {
                workspaceAccess: true,
                socketCommunication: true
            }
        };
    }
}

export default WorkspaceRole;
