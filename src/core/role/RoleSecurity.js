'use strict';

// Utils
import path from 'path';

// Logging
import { createDebug } from '../../utils/log/index.js';
const debug = createDebug('role-manager:security');

/**
 * Security Manager for Role System
 * Implements security measures for container isolation and access control
 */
class RoleSecurity {

    #serverConfig;
    #users;

    /**
     * Create RoleSecurity instance
     * @param {Object} options - Configuration options
     * @param {Object} options.serverConfig - Server configuration
     * @param {Object} options.users - Users service instance
     */
    constructor(options = {}) {
        if (!options.serverConfig) {
            throw new Error('Server configuration is required for RoleSecurity');
        }
        if (!options.users) {
            throw new Error('Users service is required for RoleSecurity');
        }

        this.#serverConfig = options.serverConfig;
        this.#users = options.users;

        debug('RoleSecurity initialized');
    }

    /**
     * Validate role permissions before creation
     * @param {Object} roleTemplate - Role template
     * @param {Object} context - Role context
     * @param {string} requestingUserId - User creating the role
     * @returns {Promise<Object>} Validation result
     */
    async validateRolePermissions(roleTemplate, context, requestingUserId) {
        const errors = [];
        const warnings = [];

        try {
            // Check role type permissions
            await this.#validateRoleTypePermissions(roleTemplate, context, requestingUserId, errors);

            // Check volume mount permissions
            await this.#validateVolumeMountPermissions(roleTemplate, context, requestingUserId, errors);

            // Check network permissions
            this.#validateNetworkPermissions(roleTemplate, context, errors);

            // Check resource limits
            this.#validateResourceLimits(roleTemplate, context, warnings);

            // Check security context
            this.#validateSecurityContext(roleTemplate, context, errors);

        } catch (error) {
            errors.push({
                type: 'validation_error',
                message: error.message
            });
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings
        };
    }

    /**
     * Apply security restrictions to container configuration
     * @param {Object} containerConfig - Docker container configuration
     * @param {Object} roleConfig - Role configuration
     * @param {Object} context - Role context
     * @returns {Promise<Object>} Secured container configuration
     */
    async applySecurityRestrictions(containerConfig, roleConfig, context) {
        const securedConfig = { ...containerConfig };

        // Apply base security settings
        this.#applyBaseSecuritySettings(securedConfig, context);

        // Apply network restrictions
        this.#applyNetworkRestrictions(securedConfig, roleConfig, context);

        // Apply resource limits
        this.#applyResourceLimits(securedConfig, roleConfig, context);

        // Apply capability restrictions
        this.#applyCapabilityRestrictions(securedConfig, roleConfig, context);

        // Apply user restrictions
        await this.#applyUserRestrictions(securedConfig, roleConfig, context);

        debug(`Applied security restrictions for role ${roleConfig.id} (${context.type})`);
        return securedConfig;
    }

    /**
     * Create security labels for container
     * @param {Object} roleConfig - Role configuration
     * @param {Object} context - Role context
     * @returns {Object} Security labels
     */
    createSecurityLabels(roleConfig, context) {
        return {
            'canvas.security.isolation': context.type,
            'canvas.security.user': context.userId || '',
            'canvas.security.workspace': context.workspaceId || '',
            'canvas.security.created': new Date().toISOString(),
            'canvas.security.restrictions': this.#getSecurityLevel(context.type)
        };
    }

    /**
     * Validate container access to host resources
     * @param {string} containerName - Container name
     * @param {string} hostPath - Host path being accessed
     * @param {Object} context - Role context
     * @returns {Promise<boolean>} Access allowed
     */
    async validateHostAccess(containerName, hostPath, context) {
        const allowedPaths = await this.#getAllowedPaths(context);
        const resolvedPath = path.resolve(hostPath);

        for (const allowedPath of allowedPaths) {
            if (resolvedPath.startsWith(allowedPath)) {
                debug(`Host access allowed: ${resolvedPath} (matched: ${allowedPath})`);
                return true;
            }
        }

        debug(`Host access denied: ${resolvedPath} for role type ${context.type}`);
        return false;
    }

    /**
     * Create network isolation policies
     * @param {Object} roleConfig - Role configuration
     * @param {Object} context - Role context
     * @returns {Array} Network policies
     */
    createNetworkPolicies(roleConfig, context) {
        const policies = [];

        switch (context.type) {
            case 'global':
                policies.push({
                    type: 'allow',
                    direction: 'egress',
                    ports: ['80', '443'],
                    protocols: ['tcp']
                });
                break;

            case 'user':
                policies.push({
                    type: 'deny',
                    direction: 'ingress',
                    except: ['127.0.0.1', '::1']
                });
                policies.push({
                    type: 'allow',
                    direction: 'egress',
                    ports: ['80', '443'],
                    protocols: ['tcp']
                });
                break;

            case 'workspace':
                policies.push({
                    type: 'deny',
                    direction: 'ingress',
                    except: ['127.0.0.1', '::1']
                });
                policies.push({
                    type: 'allow',
                    direction: 'egress',
                    ports: ['80', '443'],
                    protocols: ['tcp'],
                    restricted: true
                });
                break;
        }

        return policies;
    }

    /**
     * Private Methods
     */

    /**
     * Validate role type permissions
     * @param {Object} roleTemplate - Role template
     * @param {Object} context - Role context
     * @param {string} requestingUserId - Requesting user ID
     * @param {Array} errors - Error array
     * @private
     */
    async #validateRoleTypePermissions(roleTemplate, context, requestingUserId, errors) {
        switch (context.type) {
            case 'global':
                // Only admins can create global roles
                const isAdmin = await this.#checkAdminPermissions(requestingUserId);
                if (!isAdmin) {
                    errors.push({
                        type: 'permission_denied',
                        message: 'Only administrators can create global roles'
                    });
                }
                break;

            case 'user':
                // Can only create user roles for self
                if (context.userId !== requestingUserId) {
                    errors.push({
                        type: 'permission_denied',
                        message: 'Can only create user roles for yourself'
                    });
                }
                break;

            case 'workspace':
                // Must own the workspace
                if (context.userId !== requestingUserId) {
                    errors.push({
                        type: 'permission_denied',
                        message: 'Can only create workspace roles for your own workspaces'
                    });
                }
                break;
        }
    }

    /**
     * Validate volume mount permissions
     * @param {Object} roleTemplate - Role template
     * @param {Object} context - Role context
     * @param {string} requestingUserId - Requesting user ID
     * @param {Array} errors - Error array
     * @private
     */
    async #validateVolumeMountPermissions(roleTemplate, context, requestingUserId, errors) {
        const allowedPaths = await this.#getAllowedPaths(context);
        const volumes = roleTemplate.volumes || [];

        for (const volume of volumes) {
            const hostPath = typeof volume === 'string'
                ? volume.split(':')[0]
                : volume.host;

            // Skip special volume prefixes (will be resolved later)
            if (hostPath.includes(':')) continue;

            // Check if absolute path is allowed
            if (path.isAbsolute(hostPath)) {
                const isAllowed = allowedPaths.some(allowed =>
                    hostPath.startsWith(allowed)
                );

                if (!isAllowed) {
                    errors.push({
                        type: 'volume_access_denied',
                        message: `Volume mount not allowed: ${hostPath}`,
                        path: hostPath
                    });
                }
            }
        }
    }

    /**
     * Validate network permissions
     * @param {Object} roleTemplate - Role template
     * @param {Object} context - Role context
     * @param {Array} errors - Error array
     * @private
     */
    #validateNetworkPermissions(roleTemplate, context, errors) {
        const allowedNetworks = this.#getAllowedNetworks(context);
        const roleNetworks = roleTemplate.networks || [];

        for (const network of roleNetworks) {
            if (!allowedNetworks.includes(network)) {
                errors.push({
                    type: 'network_access_denied',
                    message: `Network access not allowed: ${network}`,
                    network
                });
            }
        }
    }

    /**
     * Validate resource limits
     * @param {Object} roleTemplate - Role template
     * @param {Object} context - Role context
     * @param {Array} warnings - Warning array
     * @private
     */
    #validateResourceLimits(roleTemplate, context, warnings) {
        const limits = this.#getResourceLimits(context);
        const resources = roleTemplate.resources || {};

        // Check CPU limits
        if (resources.cpu && this.#parseCPU(resources.cpu) > this.#parseCPU(limits.cpu)) {
            warnings.push({
                type: 'resource_limit_exceeded',
                message: `CPU limit ${resources.cpu} exceeds allowed ${limits.cpu}`,
                resource: 'cpu'
            });
        }

        // Check memory limits
        if (resources.memory && this.#parseMemory(resources.memory) > this.#parseMemory(limits.memory)) {
            warnings.push({
                type: 'resource_limit_exceeded',
                message: `Memory limit ${resources.memory} exceeds allowed ${limits.memory}`,
                resource: 'memory'
            });
        }
    }

    /**
     * Validate security context
     * @param {Object} roleTemplate - Role template
     * @param {Object} context - Role context
     * @param {Array} errors - Error array
     * @private
     */
    #validateSecurityContext(roleTemplate, context, errors) {
        // Check for privileged mode
        if (roleTemplate.container?.privileged === true && context.type !== 'global') {
            errors.push({
                type: 'security_violation',
                message: 'Privileged mode only allowed for global roles'
            });
        }

        // Check for host network mode
        if (roleTemplate.networks?.includes('host') && context.type !== 'global') {
            errors.push({
                type: 'security_violation',
                message: 'Host network mode only allowed for global roles'
            });
        }
    }

    /**
     * Apply base security settings to container configuration
     * @param {Object} config - Container configuration
     * @param {Object} context - Role context
     * @private
     */
    #applyBaseSecuritySettings(config, context) {
        config.HostConfig = config.HostConfig || {};

        // Disable privileged mode for non-global roles
        if (context.type !== 'global') {
            config.HostConfig.Privileged = false;
        }

        // Set security options
        config.HostConfig.SecurityOpt = [
            'no-new-privileges:true',
            'apparmor:docker-default'
        ];

        // Set read-only root filesystem for enhanced security
        if (context.type === 'workspace') {
            config.HostConfig.ReadonlyRootfs = true;
        }
    }

    /**
     * Apply network restrictions
     * @param {Object} config - Container configuration
     * @param {Object} roleConfig - Role configuration
     * @param {Object} context - Role context
     * @private
     */
    #applyNetworkRestrictions(config, roleConfig, context) {
        // Set network mode based on role type
        const allowedNetworks = this.#getAllowedNetworks(context);

        if (config.HostConfig.NetworkMode && !allowedNetworks.includes(config.HostConfig.NetworkMode)) {
            config.HostConfig.NetworkMode = allowedNetworks[0] || 'bridge';
        }

        // Add DNS restrictions for non-global roles
        if (context.type !== 'global') {
            config.HostConfig.Dns = ['1.1.1.1', '8.8.8.8']; // Restrict DNS servers
        }
    }

    /**
     * Apply resource limits
     * @param {Object} config - Container configuration
     * @param {Object} roleConfig - Role configuration
     * @param {Object} context - Role context
     * @private
     */
    #applyResourceLimits(config, roleConfig, context) {
        const limits = this.#getResourceLimits(context);

        config.HostConfig.Memory = this.#parseMemory(limits.memory);
        config.HostConfig.CpuQuota = Math.floor(this.#parseCPU(limits.cpu) * 100000);
        config.HostConfig.CpuPeriod = 100000;

        // Set I/O limits
        config.HostConfig.BlkioWeight = 500; // Medium I/O priority
    }

    /**
     * Apply capability restrictions
     * @param {Object} config - Container configuration
     * @param {Object} roleConfig - Role configuration
     * @param {Object} context - Role context
     * @private
     */
    #applyCapabilityRestrictions(config, roleConfig, context) {
        const allowedCaps = this.#getAllowedCapabilities(context);

        config.HostConfig.CapDrop = ['ALL'];
        config.HostConfig.CapAdd = allowedCaps;
    }

    /**
     * Apply user restrictions
     * @param {Object} config - Container configuration
     * @param {Object} roleConfig - Role configuration
     * @param {Object} context - Role context
     * @private
     */
    async #applyUserRestrictions(config, roleConfig, context) {
        // Run as non-root user for non-global roles
        if (context.type !== 'global') {
            config.User = '1000:1000'; // Default non-root user
        }
    }

    /**
     * Get allowed paths for role type
     * @param {Object} context - Role context
     * @returns {Promise<Array>} Array of allowed paths
     * @private
     */
    async #getAllowedPaths(context) {
        const paths = [];

        switch (context.type) {
            case 'global':
                paths.push(
                    this.#serverConfig.dataPath || process.cwd(),
                    '/tmp',
                    '/var/lib/canvas'
                );
                break;

            case 'user':
            case 'workspace':
                if (context.userId) {
                    const user = await this.#users.get(context.userId);
                    if (user && user.homePath) {
                        paths.push(user.homePath);
                    }
                }
                paths.push('/tmp');
                break;
        }

        return paths.map(p => path.resolve(p));
    }

    /**
     * Get allowed networks for role type
     * @param {Object} context - Role context
     * @returns {Array} Array of allowed network names
     * @private
     */
    #getAllowedNetworks(context) {
        switch (context.type) {
            case 'global':
                return ['bridge', 'canvas-global', 'host'];
            case 'user':
                return ['bridge', 'canvas-user'];
            case 'workspace':
                return ['bridge', 'canvas-workspace'];
            default:
                return ['bridge'];
        }
    }

    /**
     * Get resource limits for role type
     * @param {Object} context - Role context
     * @returns {Object} Resource limits
     * @private
     */
    #getResourceLimits(context) {
        switch (context.type) {
            case 'global':
                return { cpu: '2.0', memory: '4Gi' };
            case 'user':
                return { cpu: '1.0', memory: '2Gi' };
            case 'workspace':
                return { cpu: '0.5', memory: '1Gi' };
            default:
                return { cpu: '0.25', memory: '512Mi' };
        }
    }

    /**
     * Get allowed capabilities for role type
     * @param {Object} context - Role context
     * @returns {Array} Array of allowed capabilities
     * @private
     */
    #getAllowedCapabilities(context) {
        switch (context.type) {
            case 'global':
                return ['CHOWN', 'DAC_OVERRIDE', 'SETGID', 'SETUID'];
            case 'user':
            case 'workspace':
                return ['CHOWN', 'SETGID', 'SETUID'];
            default:
                return [];
        }
    }

    /**
     * Get security level for role type
     * @param {string} type - Role type
     * @returns {string} Security level
     * @private
     */
    #getSecurityLevel(type) {
        switch (type) {
            case 'global': return 'medium';
            case 'user': return 'high';
            case 'workspace': return 'high';
            default: return 'maximum';
        }
    }

    /**
     * Check admin permissions
     * @param {string} userId - User ID
     * @returns {Promise<boolean>} Is admin
     * @private
     */
    async #checkAdminPermissions(userId) {
        // Simplified admin check - in production, this would check user roles
        const user = await this.#users.get(userId);
        return user && user.role === 'admin';
    }

    /**
     * Parse CPU value to numeric
     * @param {string} cpu - CPU string (e.g., "1.0", "500m")
     * @returns {number} CPU value
     * @private
     */
    #parseCPU(cpu) {
        if (!cpu) return 0;
        if (cpu.endsWith('m')) {
            return parseInt(cpu) / 1000;
        }
        return parseFloat(cpu);
    }

    /**
     * Parse memory value to bytes
     * @param {string} memory - Memory string (e.g., "1Gi", "512Mi")
     * @returns {number} Memory in bytes
     * @private
     */
    #parseMemory(memory) {
        if (!memory) return 0;
        const units = { 'Ki': 1024, 'Mi': 1024**2, 'Gi': 1024**3 };
        for (const [unit, multiplier] of Object.entries(units)) {
            if (memory.endsWith(unit)) {
                return parseInt(memory) * multiplier;
            }
        }
        return parseInt(memory);
    }
}

export default RoleSecurity;
