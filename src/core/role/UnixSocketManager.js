'use strict';

// Utils
import path from 'path';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';

// Logging
import { createLogger } from '../../utils/log.js';
const logger = createLogger('role-manager:socket-manager');

/**
 * Unix Socket Manager
 * Manages Unix socket communication for workspace roles
 */
class UnixSocketManager {

    #users;
    #workspaceManager;

    /**
     * Create UnixSocketManager instance
     * @param {Object} options - Configuration options
     * @param {Object} options.users - Users service instance
     * @param {Object} options.workspaceManager - WorkspaceManager instance
     */
    constructor(options = {}) {
        if (!options.users) {
            throw new Error('Users service is required for UnixSocketManager');
        }
        if (!options.workspaceManager) {
            throw new Error('WorkspaceManager is required for UnixSocketManager');
        }

        this.#users = options.users;
        this.#workspaceManager = options.workspaceManager;

        logger.debug('UnixSocketManager initialized');
    }

    /**
     * Get socket path for a role
     * @param {Object} context - Role context
     * @param {string} context.roleId - Role ID
     * @param {string} context.type - Role type (global, workspace)
     * @param {string} [context.workspaceId] - Workspace ID for workspace roles
     * @param {string} [socketName='api'] - Socket name
     * @returns {Promise<string>} Socket path
     */
    async getSocketPath(context, socketName = 'api') {
        const socketFileName = `${context.roleId}-${socketName}.sock`;

        switch (context.type) {
            case 'global':
                // Global roles use system socket directory
                return path.join('/var', 'run', 'canvas', 'roles', socketFileName);

            case 'workspace':
                // Workspace roles use workspace var/run directory
                if (!context.workspaceId) {
                    throw new Error('Workspace ID required for workspace role socket');
                }
                const workspace = await this.#workspaceManager.getWorkspaceById(context.workspaceId);
                if (!workspace) {
                    throw new Error(`Workspace not found: ${context.workspaceId}`);
                }
                return path.join(workspace.rootPath, 'var', 'run', socketFileName);

            default:
                throw new Error(`Unknown role type: ${context.type}`);
        }
    }

    /**
     * Create socket directory structure
     * @param {Object} context - Role context
     * @returns {Promise<string>} Created socket directory path
     */
    async createSocketDirectory(context) {
        const socketPath = await this.getSocketPath(context);
        const socketDir = path.dirname(socketPath);

        if (!existsSync(socketDir)) {
            await fsPromises.mkdir(socketDir, { recursive: true });
            logger.debug(`Created socket directory: ${socketDir}`);
        }

        // Set appropriate permissions for socket directory
        await this.#setSocketDirectoryPermissions(socketDir, context);

        return socketDir;
    }

    /**
     * Get socket mount configuration for container
     * @param {Object} context - Role context
     * @param {Array<string>} [sockets=['api']] - Socket names to mount
     * @returns {Promise<Array>} Array of volume mount strings for sockets
     */
    async getSocketMounts(context, sockets = ['api']) {
        const mounts = [];

        for (const socketName of sockets) {
            const hostSocketPath = await this.getSocketPath(context, socketName);
            const hostSocketDir = path.dirname(hostSocketPath);
            const containerSocketDir = '/var/run/sockets';

            // Mount the entire socket directory
            mounts.push(`${hostSocketDir}:${containerSocketDir}:rw`);
        }

        // Remove duplicates (multiple sockets might share the same directory)
        return [...new Set(mounts)];
    }

    /**
     * Generate socket-based container configuration
     * @param {Object} containerConfig - Base container configuration
     * @param {Object} context - Role context
     * @param {Object} socketConfig - Socket configuration
     * @returns {Promise<Object>} Updated container configuration
     */
    async configureSocketCommunication(containerConfig, context, socketConfig = {}) {
        const updatedConfig = { ...containerConfig };

        // Only apply socket configuration for workspace roles
        if (context.type === 'global') {
            return updatedConfig;
        }

        // Remove port bindings for workspace roles (use sockets instead)
        if (updatedConfig.HostConfig) {
            updatedConfig.HostConfig.PortBindings = {};
        }
        updatedConfig.ExposedPorts = {};

        // Add socket directory mounts
        const socketMounts = await this.getSocketMounts(context, socketConfig.sockets);
        const existingBinds = updatedConfig.HostConfig?.Binds || [];
        updatedConfig.HostConfig = updatedConfig.HostConfig || {};
        updatedConfig.HostConfig.Binds = [...existingBinds, ...socketMounts];

        // Add socket-related environment variables
        const socketEnv = await this.#getSocketEnvironment(context, socketConfig);
        const existingEnv = updatedConfig.Env || [];
        updatedConfig.Env = [...existingEnv, ...socketEnv];

        logger.debug(`Configured socket communication for role ${context.roleId} (${context.type})`);
        return updatedConfig;
    }

    /**
     * Get socket proxy configuration for external access
     * @param {Object} context - Role context
     * @param {string} socketName - Socket name
     * @param {number} [proxyPort] - Port for HTTP-to-socket proxy
     * @returns {Promise<Object>} Proxy configuration
     */
    async getSocketProxyConfig(context, socketName = 'api', proxyPort) {
        const socketPath = await this.getSocketPath(context, socketName);

        // Generate a dynamic port if not provided
        if (!proxyPort) {
            proxyPort = await this.#generateProxyPort(context, socketName);
        }

        return {
            socketPath,
            proxyPort,
            enabled: context.type !== 'global', // Only proxy for user/workspace roles
            proxyName: `${context.roleId}-${socketName}-proxy`,
            upstream: `unix:${socketPath}:`,
            location: `/${context.roleId}/${socketName}`
        };
    }

    /**
     * Clean up socket files for a role
     * @param {Object} context - Role context
     * @param {Array<string>} [sockets=['api']] - Socket names to clean up
     * @returns {Promise<Array>} Cleanup results
     */
    async cleanupSockets(context, sockets = ['api']) {
        const results = [];

        for (const socketName of sockets) {
            try {
                const socketPath = await this.getSocketPath(context, socketName);

                if (existsSync(socketPath)) {
                    await fsPromises.unlink(socketPath);
                    results.push({
                        socket: socketName,
                        path: socketPath,
                        status: 'removed'
                    });
                    logger.debug(`Cleaned up socket: ${socketPath}`);
                } else {
                    results.push({
                        socket: socketName,
                        path: socketPath,
                        status: 'not_found'
                    });
                }
            } catch (error) {
                results.push({
                    socket: socketName,
                    status: 'error',
                    error: error.message
                });
                logger.debug(`Failed to cleanup socket ${socketName}: ${error.message}`);
            }
        }

        return results;
    }

    /**
     * List active sockets for a context
     * @param {Object} context - Role context
     * @returns {Promise<Array>} Array of active socket information
     */
    async listActiveSockets(context) {
        const sockets = [];

        try {
            const socketPath = await this.getSocketPath(context, 'api');
            const socketDir = path.dirname(socketPath);

            if (existsSync(socketDir)) {
                const files = await fsPromises.readdir(socketDir);

                for (const file of files) {
                    if (file.endsWith('.sock') && file.startsWith(context.roleId)) {
                        const fullPath = path.join(socketDir, file);
                        const stats = await fsPromises.stat(fullPath);

                        sockets.push({
                            name: file.replace(`.sock`, '').replace(`${context.roleId}-`, ''),
                            path: fullPath,
                            created: stats.birthtime,
                            size: stats.size,
                            active: stats.mtime > new Date(Date.now() - 60000) // Active in last minute
                        });
                    }
                }
            }
        } catch (error) {
            logger.debug(`Failed to list sockets for role ${context.roleId}: ${error.message}`);
        }

        return sockets;
    }

    /**
     * Private Methods
     */

    /**
     * Set socket directory permissions
     * @param {string} socketDir - Socket directory path
     * @param {Object} context - Role context
     * @private
     */
    async #setSocketDirectoryPermissions(socketDir, context) {
        try {
            // Set directory permissions based on role type
            const mode = context.type === 'global' ? 0o755 : 0o750;
            await fsPromises.chmod(socketDir, mode);
            logger.debug(`Set socket directory permissions: ${socketDir} (mode: ${mode.toString(8)})`);
        } catch (error) {
            logger.debug(`Failed to set socket directory permissions: ${error.message}`);
            // Don't fail the entire operation for permission issues
        }
    }

    /**
     * Get socket-related environment variables
     * @param {Object} context - Role context
     * @param {Object} socketConfig - Socket configuration
     * @returns {Promise<Array>} Environment variable strings
     * @private
     */
    async #getSocketEnvironment(context, socketConfig) {
        const env = [];

        // Add socket directory environment variable
        const socketDir = path.dirname(await this.getSocketPath(context));
        env.push(`SOCKET_DIR=/var/run/sockets`);
        env.push(`ROLE_ID=${context.roleId}`);
        env.push(`ROLE_TYPE=${context.type}`);

        // Add specific socket paths
        const sockets = socketConfig.sockets || ['api'];
        for (const socketName of sockets) {
            const socketPath = `/var/run/sockets/${context.roleId}-${socketName}.sock`;
            env.push(`${socketName.toUpperCase()}_SOCKET=${socketPath}`);
        }

        return env;
    }

    /**
     * Generate a dynamic proxy port for socket access
     * @param {Object} context - Role context
     * @param {string} socketName - Socket name
     * @returns {Promise<number>} Generated port number
     * @private
     */
    async #generateProxyPort(context, socketName) {
        // Generate port based on role ID hash to ensure consistency
        const hash = this.#hashString(`${context.roleId}-${socketName}`);
        const basePort = 9000; // Start from port 9000
        const port = basePort + (hash % 1000); // Use hash to generate port in range 9000-9999

        logger.debug(`Generated proxy port ${port} for role ${context.roleId} socket ${socketName}`);
        return port;
    }

    /**
     * Simple string hash function
     * @param {string} str - String to hash
     * @returns {number} Hash value
     * @private
     */
    #hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash);
    }
}

export default UnixSocketManager;
