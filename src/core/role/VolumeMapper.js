'use strict';

// Utils
import path from 'path';
import { existsSync } from 'fs';
import * as fsPromises from 'fs/promises';

// Logging
import { createDebug } from '../../utils/log/index.js';
const debug = createDebug('role-manager:volume-mapper');

/**
 * Volume Mapper
 * Handles workspace-to-container volume mapping with proper path resolution
 */
class VolumeMapper {

    #users;
    #workspaceManager;
    #serverConfig;

    /**
     * Create VolumeMapper instance
     * @param {Object} options - Configuration options
     * @param {Object} options.users - Users service instance
     * @param {Object} options.workspaceManager - WorkspaceManager instance
     * @param {Object} options.serverConfig - Server configuration
     */
    constructor(options = {}) {
        if (!options.users) {
            throw new Error('Users service is required for VolumeMapper');
        }
        if (!options.workspaceManager) {
            throw new Error('WorkspaceManager is required for VolumeMapper');
        }
        if (!options.serverConfig) {
            throw new Error('Server configuration is required for VolumeMapper');
        }

        this.#users = options.users;
        this.#workspaceManager = options.workspaceManager;
        this.#serverConfig = options.serverConfig;

        debug('VolumeMapper initialized');
    }

    /**
     * Resolve volume mappings for a role
     * @param {Array} volumes - Volume definitions from role template
     * @param {Object} context - Role context
     * @param {string} context.roleId - Role ID
     * @param {string} context.type - Role type (global, workspace)
     * @param {string} [context.workspaceId] - Workspace ID for workspace roles
     * @returns {Promise<Array>} Array of resolved volume mount strings
     */
    async resolveVolumes(volumes, context) {
        if (!volumes || !Array.isArray(volumes)) {
            return [];
        }

        const resolved = [];

        for (const volume of volumes) {
            try {
                const resolvedVolume = await this.#resolveVolumeMapping(volume, context);
                if (resolvedVolume) {
                    resolved.push(resolvedVolume);
                }
            } catch (error) {
                debug(`Failed to resolve volume mapping: ${error.message}`);
                // Skip invalid volume mappings
            }
        }

        debug(`Resolved ${resolved.length}/${volumes.length} volume mappings for role ${context.roleId}`);
        return resolved;
    }

    /**
     * Create volume directories if they don't exist
     * @param {Array} volumeMounts - Array of volume mount strings
     * @param {Object} context - Role context
     * @returns {Promise<Array>} Array of creation results
     */
    async ensureVolumePaths(volumeMounts, context) {
        const results = [];

        for (const mount of volumeMounts) {
            try {
                const hostPath = this.#extractHostPath(mount);
                await this.#ensurePath(hostPath, context);
                results.push({ mount, status: 'created', path: hostPath });
                debug(`Ensured volume path: ${hostPath}`);
            } catch (error) {
                results.push({ mount, status: 'failed', error: error.message });
                debug(`Failed to ensure volume path for ${mount}: ${error.message}`);
            }
        }

        return results;
    }

    /**
     * Validate volume access permissions
     * @param {Array} volumeMounts - Array of volume mount strings
     * @param {Object} context - Role context
     * @returns {Promise<Array>} Array of validation results
     */
    async validateVolumeAccess(volumeMounts, context) {
        const results = [];

        for (const mount of volumeMounts) {
            try {
                const hostPath = this.#extractHostPath(mount);
                const access = await this.#checkVolumeAccess(hostPath, context);
                results.push({ mount, ...access });
            } catch (error) {
                results.push({
                    mount,
                    allowed: false,
                    reason: error.message
                });
            }
        }

        return results;
    }

    /**
     * Get volume usage statistics
     * @param {Array} volumeMounts - Array of volume mount strings
     * @returns {Promise<Array>} Array of usage statistics
     */
    async getVolumeStats(volumeMounts) {
        const stats = [];

        for (const mount of volumeMounts) {
            try {
                const hostPath = this.#extractHostPath(mount);
                const stat = await this.#getPathStats(hostPath);
                stats.push({ mount, path: hostPath, ...stat });
            } catch (error) {
                stats.push({
                    mount,
                    path: this.#extractHostPath(mount),
                    error: error.message
                });
            }
        }

        return stats;
    }

    /**
     * Private Methods
     */

    /**
     * Resolve individual volume mapping
     * @param {string|Object} volume - Volume definition
     * @param {Object} context - Role context
     * @returns {Promise<string>} Resolved volume mount string
     * @private
     */
    async #resolveVolumeMapping(volume, context) {
        // Handle string format: "host:container:mode"
        if (typeof volume === 'string') {
            return await this.#resolveStringVolume(volume, context);
        }

        // Handle object format: { host, container, mode }
        if (typeof volume === 'object' && volume.host && volume.container) {
            const resolvedHost = await this.#resolveHostPath(volume.host, context);
            const mode = volume.mode || 'rw';
            return `${resolvedHost}:${volume.container}:${mode}`;
        }

        throw new Error(`Invalid volume format: ${JSON.stringify(volume)}`);
    }

    /**
     * Resolve string volume definition
     * @param {string} volumeStr - Volume string
     * @param {Object} context - Role context
     * @returns {Promise<string>} Resolved volume string
     * @private
     */
    async #resolveStringVolume(volumeStr, context) {
        const parts = volumeStr.split(':');
        if (parts.length < 2) {
            throw new Error(`Invalid volume string format: ${volumeStr}`);
        }

        const hostPath = await this.#resolveHostPath(parts[0], context);
        const containerPath = parts[1];
        const mode = parts[2] || 'rw';

        return `${hostPath}:${containerPath}:${mode}`;
    }

    async #resolveHostPath(hostPath, context) {
        debug(`Resolving host path: ${hostPath} for ${context.type} role`);

        // Server-wide paths (for global roles)
        if (hostPath.startsWith('server:')) {
            const relativePath = hostPath.substring(7);
            return path.resolve(this.#serverConfig.dataPath, relativePath);
        }

        // Workspace-relative paths (for workspace roles)
        if (hostPath.startsWith('workspace:')) {
            if (context.type !== 'workspace') {
                throw new Error('workspace: paths are only valid for workspace roles');
            }
            const relativePath = hostPath.substring(10);
            const workspacePath = await this.#getWorkspacePath(context);
            return path.resolve(workspacePath, relativePath);
        }

        // Role data paths for workspace roles
        if (hostPath.startsWith('role:')) {
            const relativePath = hostPath.substring(5);
            const roleDataPath = await this.#getRoleDataPath(context);
            return path.resolve(roleDataPath, relativePath);
        }

        // Socket paths for workspace roles
        if (hostPath.startsWith('socket:')) {
            const relativePath = hostPath.substring(7);
            const socketPath = await this.#getSocketPath(context);
            return path.resolve(socketPath, relativePath);
        }

        // Absolute paths remain unchanged
        if (path.isAbsolute(hostPath)) {
            debug(`Using absolute path: ${hostPath}`);
            return hostPath;
        }

        throw new Error(`Invalid host path format: ${hostPath}. Must use server:, workspace:, role:, socket: prefix or absolute path`);
    }

    /**
     * Get workspace path based on context
     * @param {Object} context - Role context
     * @returns {Promise<string>} Workspace path
     * @private
     */
    async #getWorkspacePath(context) {
        if (context.type !== 'workspace') {
            throw new Error('Workspace paths are only valid for workspace roles');
        }

        if (!context.workspaceId) {
            throw new Error('Workspace ID required for workspace role');
        }

        const workspace = await this.#workspaceManager.getWorkspaceById(context.workspaceId);
        if (!workspace) {
            throw new Error(`Workspace not found: ${context.workspaceId}`);
        }

        return workspace.rootPath;
    }
    /**
     * Get role data path based on context type
     * @param {Object} context - Role context
     * @returns {Promise<string>} Role data path
     * @private
     */
    async #getRoleDataPath(context) {
        switch (context.type) {
            case 'global':
                return path.join(this.#serverConfig.dataPath || process.cwd(), 'roles', context.roleId);

            case 'workspace':
                const workspace = await this.#workspaceManager.getWorkspaceById(context.workspaceId);
                if (!workspace) {
                    throw new Error(`Workspace not found: ${context.workspaceId}`);
                }
                return path.join(workspace.rootPath, 'roles', context.roleId);

            default:
                throw new Error(`Unsupported role type for role data path: ${context.type}`);
        }
    }

    /**
     * Get socket path based on context
     * @param {Object} context - Role context
     * @returns {Promise<string>} Socket path
     * @private
     */
    async #getSocketPath(context) {
        switch (context.type) {
            case 'global':
                return path.join(this.#serverConfig.dataPath, 'sockets');

            case 'workspace':
                const workspace = await this.#workspaceManager.getWorkspaceById(context.workspaceId);
                if (!workspace) {
                    throw new Error(`Workspace not found: ${context.workspaceId}`);
                }
                return path.join(workspace.rootPath, 'var', 'run');

            default:
                throw new Error(`Unsupported role type for socket path: ${context.type}`);
        }
    }

    /**
     * Validate absolute path access
     * @param {string} absolutePath - Absolute path to validate
     * @param {Object} context - Role context
     * @private
     */
    async #validateAbsolutePath(absolutePath, context) {
        // Define allowed absolute path prefixes based on role type
        const allowedPrefixes = [];

        switch (context.type) {
            case 'global':
                // Global roles can access server data directories
                allowedPrefixes.push(
                    this.#serverConfig.dataPath || process.cwd(),
                    '/tmp',
                    '/var/lib/canvas'
                );
                break;

            case 'user':
            case 'workspace':
                // User/workspace roles have restricted access
                if (context.userId) {
                    const user = await this.#users.get(context.userId);
                    if (user && user.homePath) {
                        allowedPrefixes.push(user.homePath);
                    }
                }
                allowedPrefixes.push('/tmp');
                break;
        }

        const isAllowed = allowedPrefixes.some(prefix =>
            absolutePath.startsWith(path.resolve(prefix))
        );

        if (!isAllowed) {
            throw new Error(`Absolute path not allowed for ${context.type} role: ${absolutePath}`);
        }
    }

    /**
     * Extract host path from volume mount string
     * @param {string} mount - Volume mount string
     * @returns {string} Host path
     * @private
     */
    #extractHostPath(mount) {
        return mount.split(':')[0];
    }

    /**
     * Ensure path exists, create if necessary
     * @param {string} hostPath - Host path to ensure
     * @param {Object} context - Role context
     * @private
     */
    async #ensurePath(hostPath, context) {
        if (!existsSync(hostPath)) {
            await fsPromises.mkdir(hostPath, { recursive: true });
            debug(`Created directory: ${hostPath}`);
        }

        // Set appropriate permissions based on role type
        await this.#setPathPermissions(hostPath, context);
    }

    /**
     * Set appropriate permissions for path
     * @param {string} hostPath - Host path
     * @param {Object} context - Role context
     * @private
     */
    async #setPathPermissions(hostPath, context) {
        try {
            // Basic permission setup - in production, this would be more sophisticated
            const mode = context.type === 'global' ? 0o755 : 0o750;
            await fsPromises.chmod(hostPath, mode);
        } catch (error) {
            debug(`Failed to set permissions for ${hostPath}: ${error.message}`);
            // Don't fail the entire operation for permission issues
        }
    }

    /**
     * Check volume access permissions
     * @param {string} hostPath - Host path to check
     * @param {Object} context - Role context
     * @returns {Promise<Object>} Access check result
     * @private
     */
    async #checkVolumeAccess(hostPath, context) {
        try {
            const stats = await fsPromises.stat(hostPath);

            return {
                allowed: true,
                exists: true,
                readable: true, // Simplified - would check actual permissions
                writable: true, // Simplified - would check actual permissions
                type: stats.isDirectory() ? 'directory' : 'file',
                size: stats.size,
                modified: stats.mtime
            };
        } catch (error) {
            if (error.code === 'ENOENT') {
                return {
                    allowed: true,
                    exists: false,
                    reason: 'Path will be created on mount'
                };
            }

            return {
                allowed: false,
                exists: false,
                reason: error.message
            };
        }
    }

    /**
     * Get path statistics
     * @param {string} hostPath - Host path
     * @returns {Promise<Object>} Path statistics
     * @private
     */
    async #getPathStats(hostPath) {
        try {
            const stats = await fsPromises.stat(hostPath);

            return {
                exists: true,
                type: stats.isDirectory() ? 'directory' : 'file',
                size: stats.size,
                modified: stats.mtime,
                created: stats.birthtime
            };
        } catch (error) {
            return {
                exists: false,
                error: error.message
            };
        }
    }
}

export default VolumeMapper;
