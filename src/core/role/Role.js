'use strict';

// Utils
import EventEmitter from 'eventemitter2';

// Logging
import logger, { createDebug } from '../../utils/log/index.js';
const debug = createDebug('role-manager:role');

// Constants
import { ROLE_STATUS } from './index.js';

/**
 * Base Role Class
 * Represents a Docker-based role instance
 */
class Role extends EventEmitter {

    #config;
    #docker;
    #container = null;
    #status = ROLE_STATUS.CREATED;

    /**
     * Create a Role instance
     * @param {Object} options - Role options
     * @param {Object} options.config - Role configuration
     * @param {Docker} options.docker - Docker client instance
     * @param {Object} [options.eventEmitterOptions] - EventEmitter2 options
     */
    constructor(options = {}) {
        super(options.eventEmitterOptions || {});

        if (!options.config) {
            throw new Error('Role configuration is required');
        }
        if (!options.docker) {
            throw new Error('Docker client is required');
        }

        this.#config = options.config;
        this.#docker = options.docker;
        this.#status = options.config.status || ROLE_STATUS.CREATED;

        debug(`Role instance created: ${this.id} (${this.name})`);
    }

    /**
     * Getters
     */
    get id() { return this.#config.id; }
    get name() { return this.#config.name; }
    get type() { return this.#config.type; }
    get template() { return this.#config.template; }
    get status() { return this.#status; }
    get config() { return { ...this.#config }; }
    get userId() { return this.#config.userId; }
    get workspaceId() { return this.#config.workspaceId; }
    get container() { return this.#container; }
    get isRunning() { return this.#status === ROLE_STATUS.RUNNING; }
    get isStopped() { return this.#status === ROLE_STATUS.STOPPED; }

    /**
     * Start the role
     * @returns {Promise<void>}
     */
    async start() {
        if (this.#status === ROLE_STATUS.RUNNING) {
            debug(`Role ${this.id} is already running`);
            return;
        }

        debug(`Starting role: ${this.id} (${this.name})`);
        this.#setStatus(ROLE_STATUS.STARTING);

        try {
            // Check if container exists
            await this.#ensureContainer();

            // Start container
            await this.#container.start();

            // Wait for container to be running
            await this.#waitForRunning();

            this.#setStatus(ROLE_STATUS.RUNNING);
            this.emit('started', { roleId: this.id });

            debug(`Role ${this.id} started successfully`);
        } catch (error) {
            this.#setStatus(ROLE_STATUS.ERROR);
            this.emit('startFailed', { roleId: this.id, error: error.message });
            throw error;
        }
    }

    /**
     * Stop the role
     * @returns {Promise<void>}
     */
    async stop() {
        if (this.#status === ROLE_STATUS.STOPPED || this.#status === ROLE_STATUS.CREATED) {
            debug(`Role ${this.id} is already stopped`);
            return;
        }

        debug(`Stopping role: ${this.id} (${this.name})`);
        this.#setStatus(ROLE_STATUS.STOPPING);

        try {
            if (this.#container) {
                await this.#container.stop({ t: 10 }); // 10 second timeout
                this.#setStatus(ROLE_STATUS.STOPPED);
                this.emit('stopped', { roleId: this.id });
                debug(`Role ${this.id} stopped successfully`);
            }
        } catch (error) {
            this.#setStatus(ROLE_STATUS.ERROR);
            this.emit('stopFailed', { roleId: this.id, error: error.message });
            throw error;
        }
    }

    /**
     * Restart the role
     * @returns {Promise<void>}
     */
    async restart() {
        debug(`Restarting role: ${this.id} (${this.name})`);
        await this.stop();
        await this.start();
    }

    /**
     * Get role logs
     * @param {Object} options - Log options
     * @param {number} [options.tail=100] - Number of lines to tail
     * @param {boolean} [options.follow=false] - Follow log output
     * @returns {Promise<NodeJS.ReadableStream>} Log stream
     */
    async getLogs(options = {}) {
        if (!this.#container) {
            throw new Error(`Container not found for role ${this.id}`);
        }

        return this.#container.logs({
            stdout: true,
            stderr: true,
            tail: options.tail || 100,
            follow: options.follow || false,
            timestamps: true
        });
    }

    /**
     * Get container stats
     * @returns {Promise<Object>} Container statistics
     */
    async getStats() {
        if (!this.#container) {
            throw new Error(`Container not found for role ${this.id}`);
        }

        const stats = await this.#container.stats({ stream: false });
        return stats;
    }

    /**
     * Execute command in container
     * @param {Array<string>} cmd - Command to execute
     * @param {Object} [options] - Execution options
     * @returns {Promise<Object>} Execution result
     */
    async exec(cmd, options = {}) {
        if (!this.#container) {
            throw new Error(`Container not found for role ${this.id}`);
        }

        const exec = await this.#container.exec({
            Cmd: cmd,
            AttachStdout: true,
            AttachStderr: true,
            ...options
        });

        const stream = await exec.start();
        return { stream, exec };
    }

    /**
     * Update role configuration
     * @param {Object} updates - Configuration updates
     * @returns {Promise<void>}
     */
    async updateConfig(updates) {
        this.#config = { ...this.#config, ...updates, updatedAt: new Date().toISOString() };
        this.emit('configUpdated', { roleId: this.id, config: this.#config });
        debug(`Role ${this.id} configuration updated`);
    }

    /**
     * Convert role to JSON representation
     * @returns {Object} JSON representation
     */
    toJSON() {
        return {
            id: this.id,
            name: this.name,
            type: this.type,
            template: this.template,
            status: this.status,
            userId: this.userId,
            workspaceId: this.workspaceId,
            createdAt: this.#config.createdAt,
            updatedAt: this.#config.updatedAt,
            container: {
                name: this.#config.container?.name,
                image: this.#config.container?.image,
                status: this.#container ? 'exists' : 'not_found'
            }
        };
    }

    /**
     * Protected Methods (for subclasses)
     */

    /**
     * Get Docker client
     * @returns {Docker} Docker client
     * @protected
     */
    _getDocker() {
        return this.#docker;
    }

    /**
     * Get role configuration
     * @returns {Object} Role configuration
     * @protected
     */
    _getConfig() {
        return this.#config;
    }

    /**
     * Set role status
     * @param {string} status - New status
     * @protected
     */
    _setStatus(status) {
        this.#setStatus(status);
    }

    /**
     * Hook for subclasses to modify container configuration
     * @param {Object} containerConfig - Base container configuration
     * @returns {Promise<Object>} Modified container configuration
     * @protected
     */
    async _prepareContainerConfig(containerConfig) {
        return containerConfig;
    }

    /**
     * Private Methods
     */

    /**
     * Set status and emit event
     * @param {string} status - New status
     * @private
     */
    #setStatus(status) {
        if (this.#status !== status) {
            const oldStatus = this.#status;
            this.#status = status;
            this.emit('statusChanged', { roleId: this.id, oldStatus, newStatus: status });
            debug(`Role ${this.id} status: ${oldStatus} -> ${status}`);
        }
    }

    /**
     * Ensure container exists, create if not
     * @private
     */
    async #ensureContainer() {
        const containerName = this.#config.container.name;

        try {
            // Try to get existing container
            this.#container = this.#docker.getContainer(containerName);
            await this.#container.inspect();
            debug(`Found existing container: ${containerName}`);
        } catch (error) {
            // Container doesn't exist, create it
            debug(`Creating new container: ${containerName}`);
            await this.#createContainer();
        }
    }

    /**
     * Create a new container
     * @private
     */
    async #createContainer() {
        const containerConfig = {
            name: this.#config.container.name,
            Image: this.#config.container.image,
            Env: this.#formatEnvironmentVariables(),
            HostConfig: {
                Binds: this.#config.volumes || [],
                PortBindings: this.#formatPortBindings(),
                RestartPolicy: { Name: 'unless-stopped' },
                NetworkMode: this.#config.networks?.[0] || 'bridge'
            },
            NetworkingConfig: {
                EndpointsConfig: this.#formatNetworksConfig()
            },
            ExposedPorts: this.#formatExposedPorts(),
            ...this.#config.container.dockerOptions
        };

        // Allow subclasses to modify container config
        const finalConfig = await this._prepareContainerConfig(containerConfig);

        this.#container = await this.#docker.createContainer(finalConfig);
        debug(`Container created: ${this.#config.container.name}`);
    }

    /**
     * Wait for container to be running
     * @private
     */
    async #waitForRunning(timeout = 30000) {
        const startTime = Date.now();

        while (Date.now() - startTime < timeout) {
            try {
                const info = await this.#container.inspect();
                if (info.State.Running) {
                    return;
                }
                if (info.State.Status === 'exited') {
                    throw new Error(`Container exited with code ${info.State.ExitCode}`);
                }
            } catch (error) {
                throw new Error(`Failed to check container status: ${error.message}`);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        throw new Error(`Container failed to start within ${timeout}ms`);
    }

    /**
     * Format environment variables for Docker
     * @returns {Array<string>} Environment variables array
     * @private
     */
    #formatEnvironmentVariables() {
        const env = [];
        for (const [key, value] of Object.entries(this.#config.environment || {})) {
            env.push(`${key}=${value}`);
        }
        return env;
    }

    /**
     * Format port bindings for Docker
     * @returns {Object} Port bindings object
     * @private
     */
    #formatPortBindings() {
        const bindings = {};
        for (const [hostPort, containerPort] of Object.entries(this.#config.container.ports || {})) {
            bindings[`${containerPort}/tcp`] = [{ HostPort: hostPort }];
        }
        return bindings;
    }

    /**
     * Format exposed ports for Docker
     * @returns {Object} Exposed ports object
     * @private
     */
    #formatExposedPorts() {
        const exposed = {};
        for (const containerPort of Object.values(this.#config.container.ports || {})) {
            exposed[`${containerPort}/tcp`] = {};
        }
        return exposed;
    }

    /**
     * Format networks configuration for Docker
     * @returns {Object} Networks configuration
     * @private
     */
    #formatNetworksConfig() {
        const networks = {};
        for (const network of this.#config.networks || []) {
            networks[network] = {};
        }
        return networks;
    }
}

export default Role;
