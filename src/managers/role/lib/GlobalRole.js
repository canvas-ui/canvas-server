'use strict';

// Base class
import Role from './Role.js';

// Logging
import { createDebug } from '../../../utils/log/index.js';
const debug = createDebug('role-manager:global-role');

/**
 * Global Role Class
 * Represents server-wide roles that serve all users
 */
class GlobalRole extends Role {

    /**
     * Create a GlobalRole instance
     * @param {Object} options - Role options
     */
    constructor(options = {}) {
        super(options);
        debug(`GlobalRole instance created: ${this.id} (${this.name})`);
    }

    /**
     * Prepare container configuration for global roles
     * @param {Object} containerConfig - Base container configuration
     * @returns {Promise<Object>} Modified container configuration
     * @protected
     */
    async _prepareContainerConfig(containerConfig) {
        const config = await super._prepareContainerConfig(containerConfig);

        // Global roles get additional system-level configurations
        config.HostConfig = {
            ...config.HostConfig,
            // Add global role specific configurations
            AutoRemove: false, // Global roles should persist
            NetworkMode: 'canvas-global', // Use global network if available
        };

        // Add labels to identify as global role
        config.Labels = {
            ...(config.Labels || {}),
            'canvas.role.type': 'global',
            'canvas.role.id': this.id,
            'canvas.role.name': this.name,
            'canvas.role.template': this.template
        };

        debug(`Prepared global role container config for ${this.id}`);
        return config;
    }

    /**
     * Get health status for global role
     * @returns {Promise<Object>} Health status
     */
    async getHealthStatus() {
        if (!this.container) {
            return { status: 'unhealthy', reason: 'Container not found' };
        }

        try {
            const info = await this.container.inspect();
            const health = info.State.Health;

            if (health) {
                return {
                    status: health.Status,
                    failingStreak: health.FailingStreak,
                    log: health.Log?.slice(-5) // Last 5 health check entries
                };
            }

            return {
                status: info.State.Running ? 'healthy' : 'unhealthy',
                reason: info.State.Running ? 'Running' : `Status: ${info.State.Status}`
            };
        } catch (error) {
            return { status: 'unhealthy', reason: error.message };
        }
    }

    /**
     * Update global role with new configuration
     * @param {Object} updates - Configuration updates
     * @returns {Promise<void>}
     */
    async updateConfig(updates) {
        // Global roles have restricted configuration updates
        const allowedUpdates = {};
        const allowedKeys = ['environment', 'lifecycle', 'description'];

        for (const key of allowedKeys) {
            if (updates[key] !== undefined) {
                allowedUpdates[key] = updates[key];
            }
        }

        await super.updateConfig(allowedUpdates);
        debug(`Global role ${this.id} configuration updated with restricted keys`);
    }

    /**
     * Convert to JSON with global role specific information
     * @returns {Object} JSON representation
     */
    toJSON() {
        const base = super.toJSON();
        return {
            ...base,
            scope: 'global',
            restrictions: {
                configUpdate: 'limited',
                userAccess: 'all',
                networkAccess: 'global'
            }
        };
    }
}

export default GlobalRole;
