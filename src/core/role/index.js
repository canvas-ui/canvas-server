'use strict';

// Utils
import path from 'path';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';
import EventEmitter from 'eventemitter2';
import Conf from 'conf';
import Docker from 'dockerode';
import { generateUUID } from '../../utils/id.js';

// Logging
import { createLogger } from '../../utils/log.js';
const logger = createLogger('role-manager');

// Includes
import Role from './Role.js';
import GlobalRole from './GlobalRole.js';
import WorkspaceRole from './WorkspaceRole.js';
import VolumeMapper from './VolumeMapper.js';
import UnixSocketManager from './UnixSocketManager.js';

/**
 * Constants
 */
const ROLE_STATUS = {
    CREATED: 'created',
    CONFIGURED: 'configured',
    STARTING: 'starting',
    RUNNING: 'running',
    STOPPING: 'stopping',
    STOPPED: 'stopped',
    ERROR: 'error',
    REMOVED: 'removed'
};

const ROLE_TYPES = {
    GLOBAL: 'global',       // Server-wide roles
    WORKSPACE: 'workspace'  // Workspace-tied roles
};

const ROLE_CONFIG_FILENAME = 'role.json';

/**
 * Roles Service
 * Manages Docker-based roles with workspace integration
 */
class Roles extends EventEmitter {

    #docker;
    #indexStore;
    #users;
    #workspaceManager;
    #serverConfig;
    #volumeMapper;
    #socketManager;

    // Runtime state
    #roles = new Map(); // Cache for loaded Role instances (key: roleId -> Role)
    #initialized = false;

    /**
     * Constructor
     * @param {Object} options - Configuration options
     * @param {Object} options.indexStore - Initialized Conf instance for role index
     * @param {Object} options.users - Users service instance
     * @param {Object} options.workspaceManager - WorkspaceManager instance
     * @param {Object} options.serverConfig - Server configuration
     * @param {Object} [options.dockerOptions] - Docker client options
     * @param {Object} [options.eventEmitterOptions] - EventEmitter2 options
     */
    constructor(options = {}) {
        super(options.eventEmitterOptions || {});

        if (!options.indexStore) {
            throw new Error('Index store is required for Roles service');
        }
        if (!options.users) {
            throw new Error('Users service is required for Roles service');
        }
        if (!options.workspaceManager) {
            throw new Error('WorkspaceManager is required for Roles service');
        }
        if (!options.serverConfig) {
            throw new Error('Server configuration is required for Roles service');
        }

        this.#indexStore = options.indexStore;
        this.#users = options.users;
        this.#workspaceManager = options.workspaceManager;
        this.#serverConfig = options.serverConfig;

        // Initialize Docker client
        this.#docker = new Docker(options.dockerOptions || {
            socketPath: '/var/run/docker.sock'
        });

        // Initialize volume mapper
        this.#volumeMapper = new VolumeMapper({
            users: this.#users,
            workspaceManager: this.#workspaceManager,
            serverConfig: this.#serverConfig
        });

        // Initialize socket manager
        this.#socketManager = new UnixSocketManager({
            users: this.#users,
            workspaceManager: this.#workspaceManager
        });

        logger.debug('Roles service initialized');
    }

    /**
     * Getters
     */
    get users() { return this.#users; }
    get workspaceManager() { return this.#workspaceManager; }
    get docker() { return this.#docker; }
    get socketManager() { return this.#socketManager; }

    /**
     * Initialize Roles service
     */
    async initialize() {
        if (this.#initialized) return true;

        logger.debug('Initializing Roles service...');

        // Test Docker connection (non-fatal)
        try {
            await this.#docker.ping();
            logger.debug('Docker connection established');
        } catch (error) {
            console.warn(`Docker not available: ${error.message}. Role management features will be disabled.`);
            // Continue initialization without Docker
        }

        // Scan existing roles
        try {
            await this.#scanExistingRoles();
        } catch (error) {
            console.warn(`Failed to scan existing roles: ${error.message}`);
        }

        this.#initialized = true;
        logger.debug(`Roles service initialized with ${this.#indexStore.size} role(s) in index`);

        return this;
    }

    /**
     * Create a new role
     * @param {string} templateName - Role template name from extensions/roles
     * @param {Object} options - Role configuration options
     * @param {string} options.name - Role instance name
     * @param {string} options.type - Role type (global, workspace)
     * @param {string} [options.workspaceId] - Workspace ID for workspace roles (required for workspace roles)
     * @param {Object} [options.config] - Additional role configuration
     * @returns {Promise<Object>} Created role entry
     */
    async create(templateName, options = {}) {
        if (!this.#initialized) {
            throw new Error('Roles service not initialized');
        }
        if (!templateName || !options.name || !options.type) {
            throw new Error('templateName, name, and type are required');
        }

        const roleId = generateUUID();
        const timestamp = new Date().toISOString();

        const template = await this.#loadRoleTemplate(templateName);

        // Validate role type and scope
        this.#validateRoleScope(options.type, options.workspaceId);

        // Create role configuration
        const roleConfig = {
            id: roleId,
            name: options.name,
            template: templateName,
            type: options.type,
            workspaceId: options.workspaceId || null,
            status: ROLE_STATUS.CREATED,
            container: {
                ...template.container,
                name: `canvas-role-${options.name}-${roleId}`,
                ...options.config?.container
            },
            lifecycle: {
                ...template.lifecycle,
                ...options.config?.lifecycle
            },
            volumes: await this.#resolveVolumeMounts(template.volumes || [], options),
            environment: {
                ...template.environment,
                ...options.config?.environment
            },
            networks: template.networks || [],
            createdAt: timestamp,
            updatedAt: timestamp
        };

        // Store in index
        this.#indexStore.set(roleId, roleConfig);

        logger.debug(`Role created: ${roleId} (${options.name}) type: ${options.type}`);
        this.emit('role.created', { roleId, config: roleConfig });

        return roleConfig;
    }

    /**
     * Start a role
     * @param {string} roleId - Role ID to start
     * @param {string} [requestingUserId] - User making the request
     * @returns {Promise<Role>} Started role instance
     */
    async start(roleId, requestingUserId) {
        if (!this.#initialized) {
            throw new Error('Roles service not initialized');
        }

        const roleConfig = this.#indexStore.get(roleId);
        if (!roleConfig) {
            throw new Error(`Role not found: ${roleId}`);
        }

        if (!this.#checkRolePermissions(roleConfig, requestingUserId)) {
            throw new Error(`Permission denied to start role: ${roleId}`);
        }

        logger.debug(`Starting role: ${roleId} (${roleConfig.name})`);

        let role = this.#roles.get(roleId);
        if (!role) {
            role = this.#createRoleInstance(roleConfig);
            this.#roles.set(roleId, role);
        }

        if (role.status === ROLE_STATUS.RUNNING) {
            logger.debug(`Role ${roleId} is already running`);
            return role;
        }

        try {
            await role.start();
            this.#updateRoleStatus(roleId, ROLE_STATUS.RUNNING);
            this.emit('role.started', { roleId, role: role.toJSON() });
            return role;
        } catch (error) {
            this.#updateRoleStatus(roleId, ROLE_STATUS.ERROR);
            this.emit('role.startFailed', { roleId, error: error.message });
            throw error;
        }
    }

    /**
     * Stop a role
     * @param {string} roleId - Role ID to stop
     * @param {string} [requestingUserId] - User making the request
     * @returns {Promise<boolean>} Success status
     */
    async stop(roleId, requestingUserId) {
        if (!this.#initialized) {
            throw new Error('Roles service not initialized');
        }

        const roleConfig = this.#indexStore.get(roleId);
        if (!roleConfig) {
            throw new Error(`Role not found: ${roleId}`);
        }

        if (!this.#checkRolePermissions(roleConfig, requestingUserId)) {
            throw new Error(`Permission denied to stop role: ${roleId}`);
        }

        const role = this.#roles.get(roleId);
        if (!role) {
            logger.debug(`Role ${roleId} is not running`);
            this.#updateRoleStatus(roleId, ROLE_STATUS.STOPPED);
            return true;
        }

        logger.debug(`Stopping role: ${roleId} (${roleConfig.name})`);

        try {
            await role.stop();
            this.#updateRoleStatus(roleId, ROLE_STATUS.STOPPED);
            this.emit('role.stopped', { roleId });
            return true;
        } catch (error) {
            this.#updateRoleStatus(roleId, ROLE_STATUS.ERROR);
            this.emit('role.stopFailed', { roleId, error: error.message });
            throw error;
        }
    }

    /**
     * Remove a role
     * @param {string} roleId - Role ID to remove
     * @param {string} [requestingUserId] - User making the request
     * @param {boolean} [force=false] - Force removal even if running
     * @returns {Promise<boolean>} Success status
     */
    async remove(roleId, requestingUserId, force = false) {
        if (!this.#initialized) {
            throw new Error('Roles service not initialized');
        }

        const roleConfig = this.#indexStore.get(roleId);
        if (!roleConfig) {
            throw new Error(`Role not found: ${roleId}`);
        }

        if (!this.#checkRolePermissions(roleConfig, requestingUserId)) {
            throw new Error(`Permission denied to remove role: ${roleId}`);
        }

        logger.debug(`Removing role: ${roleId} (${roleConfig.name}), force: ${force}`);

        // Stop role if running
        if (this.#roles.has(roleId)) {
            if (!force && roleConfig.status === ROLE_STATUS.RUNNING) {
                throw new Error(`Role ${roleId} is running. Stop first or use force=true`);
            }
            await this.stop(roleId, requestingUserId);
            this.#roles.delete(roleId);
        }

        // Remove container if exists
        try {
            const container = this.#docker.getContainer(roleConfig.container.name);
            await container.remove({ force: true });
        } catch (error) {
            logger.debug(`Container removal failed (may not exist): ${error.message}`);
        }

        // Remove from index
        this.#indexStore.delete(roleId);
        this.emit('role.removed', { roleId, config: roleConfig });

        return true;
    }

    /**
     * List roles by scope
     * @param {Object} filter - Filter options
     * @param {string} [filter.type] - Role type filter
     * @param {string} [filter.workspaceId] - Workspace ID filter
     * @param {string} [filter.status] - Status filter
     * @returns {Array<Object>} Array of role configurations
     */
    list(filter = {}) {
        const allRoles = Object.values(this.#indexStore.store || {});

        return allRoles.filter(role => {
            if (filter.type && role.type !== filter.type) return false;
            if (filter.workspaceId && role.workspaceId !== filter.workspaceId) return false;
            if (filter.status && role.status !== filter.status) return false;
            return true;
        });
    }

    /**
     * Get role by ID
     * @param {string} roleId - Role ID
     * @param {string} [requestingUserId] - User making the request
     * @returns {Promise<Role|null>} Role instance or null
     */
    async get(roleId, requestingUserId) {
        const roleConfig = this.#indexStore.get(roleId);
        if (!roleConfig) return null;

        if (!this.#checkRolePermissions(roleConfig, requestingUserId)) {
            return null;
        }

        let role = this.#roles.get(roleId);
        if (!role) {
            role = this.#createRoleInstance(roleConfig);
            this.#roles.set(roleId, role);
        }

        return role;
    }

    /**
     * Private Methods
     */

    /**
     * Load role template from extensions/roles directory
     * @param {string} templateName - Template name
     * @returns {Promise<Object>} Template configuration
     * @private
     */
    async #loadRoleTemplate(templateName) {
        const templatePath = path.join(process.cwd(), 'extensions', 'roles', templateName, 'role.json');

        if (!existsSync(templatePath)) {
            throw new Error(`Role template not found: ${templateName}`);
        }

        try {
            const templateData = await fsPromises.readFile(templatePath, 'utf8');
            return JSON.parse(templateData);
        } catch (error) {
            throw new Error(`Failed to load role template ${templateName}: ${error.message}`);
        }
    }

    /**
     * Validate role scope parameters
     * @param {string} type - Role type
     * @param {string} workspaceId - Workspace ID
     * @private
     */
    #validateRoleScope(type, workspaceId) {
        switch (type) {
            case ROLE_TYPES.GLOBAL:
                if (workspaceId) {
                    throw new Error('Global roles cannot have workspaceId');
                }
                break;
            case ROLE_TYPES.WORKSPACE:
                if (!workspaceId) {
                    throw new Error('Workspace roles require workspaceId');
                }
                break;
            default:
                throw new Error(`Invalid role type: ${type}. Must be 'global' or 'workspace'`);
        }
    }

    /**
     * Resolve volume mounts using VolumeMapper
     * @param {Array} volumes - Template volume definitions
     * @param {Object} options - Role creation options
     * @returns {Promise<Array>} Resolved volume mount strings
     * @private
     */
    async #resolveVolumeMounts(volumes, options) {
        const context = {
            roleId: generateUUID(),
            type: options.type,
            workspaceId: options.workspaceId
        };

        return await this.#volumeMapper.resolveVolumes(volumes, context);
    }

    /**
     * Create appropriate role instance based on type
     * @param {Object} config - Role configuration
     * @returns {Role} Role instance
     * @private
     */
    #createRoleInstance(config) {
        switch (config.type) {
            case ROLE_TYPES.GLOBAL:
                return new GlobalRole({
                    config,
                    docker: this.#docker,
                    eventEmitterOptions: { wildcard: true, delimiter: '.' }
                });
            case ROLE_TYPES.WORKSPACE:
                return new WorkspaceRole({
                    config,
                    docker: this.#docker,
                    workspaceManager: this.#workspaceManager,
                    eventEmitterOptions: { wildcard: true, delimiter: '.' }
                });
            default:
                throw new Error(`Unsupported role type: ${config.type}`);
        }
    }

    /**
     * Check if user has permission to perform action on role
     * @param {Object} roleConfig - Role configuration
     * @param {string} userId - Requesting user ID
     * @returns {boolean} Permission granted
     * @private
     */
    #checkRolePermissions(roleConfig, userId) {
        // Global roles - allow for now (admin check can be added later)
        if (roleConfig.type === ROLE_TYPES.GLOBAL) {
            return true;
        }

        // Workspace roles - check ownership
        if (roleConfig.userId) {
            return roleConfig.userId === userId;
        }

        return true;
    }

    /**
     * Update role status in index
     * @param {string} roleId - Role ID
     * @param {string} status - New status
     * @private
     */
    #updateRoleStatus(roleId, status) {
        const config = this.#indexStore.get(roleId);
        if (config) {
            config.status = status;
            config.updatedAt = new Date().toISOString();
            this.#indexStore.set(roleId, config);
        }
    }

    /**
     * Scan existing roles and update their status
     * @private
     */
    async #scanExistingRoles() {
        logger.debug('Scanning existing roles...');
        const allRoles = this.#indexStore.store || {};

        for (const [roleId, roleConfig] of Object.entries(allRoles)) {
            if (!roleConfig.container?.name) continue;

            try {
                const container = this.#docker.getContainer(roleConfig.container.name);
                const containerInfo = await container.inspect();

                const isRunning = containerInfo.State.Running;
                this.#updateRoleStatus(roleId, isRunning ? ROLE_STATUS.RUNNING : ROLE_STATUS.STOPPED);

                logger.debug(`Role ${roleId} status: ${isRunning ? 'running' : 'stopped'}`);
            } catch (error) {
                // Container doesn't exist
                this.#updateRoleStatus(roleId, ROLE_STATUS.STOPPED);
                logger.debug(`Role ${roleId} container not found, marked as stopped`);
            }
        }
    }
}

export default Roles;
export { ROLE_STATUS, ROLE_TYPES };
