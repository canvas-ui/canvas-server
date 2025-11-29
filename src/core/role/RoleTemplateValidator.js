'use strict';

/**
 * Role Template Validator
 * Validates role template configurations against schema
 */

// Logging
import { createDebug } from '../../../utils/log/index.js';
const debug = createDebug('role-manager:validator');

/**
 * Role template schema definition
 */
const ROLE_SCHEMA = {
    type: 'object',
    required: ['id', 'name', 'type', 'container'],
    properties: {
        id: { type: 'string', pattern: '^[a-z0-9-]+$' },
        name: { type: 'string', minLength: 1 },
        description: { type: 'string' },
        version: { type: 'string' },
        type: {
            type: 'string',
            enum: ['global', 'user', 'workspace']
        },
        category: { type: 'string' },
        tags: {
            type: 'array',
            items: { type: 'string' }
        },
        container: {
            type: 'object',
            required: ['image'],
            properties: {
                image: { type: 'string', minLength: 1 },
                command: {
                    type: 'array',
                    items: { type: 'string' }
                },
                ports: {
                    type: 'object',
                    patternProperties: {
                        '^[0-9]+$': { type: 'string', pattern: '^[0-9]+$' }
                    }
                },
                healthcheck: {
                    type: 'object',
                    properties: {
                        test: {
                            type: 'array',
                            items: { type: 'string' }
                        },
                        interval: { type: 'string' },
                        timeout: { type: 'string' },
                        retries: { type: 'integer' },
                        start_period: { type: 'string' }
                    }
                },
                restart: { type: 'string' }
            }
        },
        volumes: {
            type: 'array',
            items: {
                oneOf: [
                    { type: 'string' },
                    {
                        type: 'object',
                        required: ['host', 'container'],
                        properties: {
                            host: { type: 'string' },
                            container: { type: 'string' },
                            mode: {
                                type: 'string',
                                enum: ['ro', 'rw']
                            }
                        }
                    }
                ]
            }
        },
        environment: {
            type: 'object',
            patternProperties: {
                '^[A-Z_][A-Z0-9_]*$': { type: 'string' }
            }
        },
        networks: {
            type: 'array',
            items: { type: 'string' }
        },
        lifecycle: {
            type: 'object',
            properties: {
                autoStart: { type: 'boolean' },
                dependencies: {
                    type: 'array',
                    items: { type: 'string' }
                },
                hooks: {
                    type: 'object',
                    properties: {
                        preStart: { $ref: '#/definitions/hook' },
                        postStart: { $ref: '#/definitions/hook' },
                        preStop: { $ref: '#/definitions/hook' },
                        postStop: { $ref: '#/definitions/hook' }
                    }
                }
            }
        },
        configuration: {
            type: 'object',
            properties: {
                schema: { type: 'object' }
            }
        },
        permissions: {
            type: 'object',
            properties: {
                workspace: {
                    type: 'object',
                    properties: {
                        read: { type: 'boolean' },
                        write: { type: 'boolean' },
                        execute: { type: 'boolean' }
                    }
                },
                network: {
                    type: 'object',
                    properties: {
                        outbound: { type: 'boolean' },
                        inbound: { type: 'boolean' }
                    }
                }
            }
        },
        resources: {
            type: 'object',
            properties: {
                cpu: { type: 'string' },
                memory: { type: 'string' },
                storage: { type: 'string' },
                gpu: { type: 'string' }
            }
        },
        documentation: {
            type: 'object',
            properties: {
                readme: { type: 'string' },
                urls: {
                    type: 'object',
                    patternProperties: {
                        '^[a-z]+$': { type: 'string', format: 'uri' }
                    }
                }
            }
        }
    },
    definitions: {
        hook: {
            oneOf: [
                { type: 'null' },
                {
                    type: 'object',
                    required: ['command'],
                    properties: {
                        command: {
                            type: 'array',
                            items: { type: 'string' }
                        },
                        timeout: { type: 'string' }
                    }
                }
            ]
        }
    }
};

/**
 * Role Template Validator Class
 */
class RoleTemplateValidator {

    /**
     * Validate a role template against the schema
     * @param {Object} template - Role template to validate
     * @returns {Object} Validation result with errors array
     */
    static validate(template) {
        const errors = [];

        try {
            this.#validateObject(template, ROLE_SCHEMA, '', errors);
        } catch (error) {
            errors.push({
                path: '',
                message: `Validation error: ${error.message}`
            });
        }

        const isValid = errors.length === 0;

        if (!isValid) {
            debug(`Role template validation failed with ${errors.length} errors`);
            errors.forEach(error => debug(`  ${error.path}: ${error.message}`));
        }

        return {
            valid: isValid,
            errors
        };
    }

    /**
     * Validate role template for specific type constraints
     * @param {Object} template - Role template to validate
     * @returns {Object} Type-specific validation result
     */
    static validateTypeConstraints(template) {
        const errors = [];

        switch (template.type) {
            case 'global':
                this.#validateGlobalRoleConstraints(template, errors);
                break;
            case 'user':
                this.#validateUserRoleConstraints(template, errors);
                break;
            case 'workspace':
                this.#validateWorkspaceRoleConstraints(template, errors);
                break;
        }

        return {
            valid: errors.length === 0,
            errors
        };
    }

    /**
     * Get role template requirements based on type
     * @param {string} type - Role type
     * @returns {Object} Requirements object
     */
    static getTypeRequirements(type) {
        const requirements = {
            global: {
                userId: false,
                workspaceId: false,
                networks: ['canvas-global'],
                autoStart: true,
                permissions: {
                    workspace: false,
                    systemAccess: true
                }
            },
            user: {
                userId: true,
                workspaceId: false,
                networks: ['canvas-user'],
                autoStart: false,
                permissions: {
                    workspace: true,
                    userAccess: true
                }
            },
            workspace: {
                userId: true,
                workspaceId: true,
                networks: ['canvas-workspace'],
                autoStart: false,
                permissions: {
                    workspace: true,
                    projectAccess: true
                }
            }
        };

        return requirements[type] || {};
    }

    /**
     * Private validation methods
     */

    /**
     * Validate object against schema
     * @param {*} obj - Object to validate
     * @param {Object} schema - Schema to validate against
     * @param {string} path - Current path for error reporting
     * @param {Array} errors - Array to collect errors
     * @private
     */
    static #validateObject(obj, schema, path, errors) {
        if (schema.type === 'object') {
            if (typeof obj !== 'object' || obj === null) {
                errors.push({
                    path,
                    message: `Expected object, got ${typeof obj}`
                });
                return;
            }

            // Check required properties
            if (schema.required) {
                for (const required of schema.required) {
                    if (!(required in obj)) {
                        errors.push({
                            path: path ? `${path}.${required}` : required,
                            message: `Required property missing`
                        });
                    }
                }
            }

            // Validate properties
            if (schema.properties) {
                for (const [key, value] of Object.entries(obj)) {
                    const propSchema = schema.properties[key];
                    if (propSchema) {
                        const propPath = path ? `${path}.${key}` : key;
                        this.#validateObject(value, propSchema, propPath, errors);
                    }
                }
            }

            // Validate pattern properties
            if (schema.patternProperties) {
                for (const [key, value] of Object.entries(obj)) {
                    for (const [pattern, patternSchema] of Object.entries(schema.patternProperties)) {
                        if (new RegExp(pattern).test(key)) {
                            const propPath = path ? `${path}.${key}` : key;
                            this.#validateObject(value, patternSchema, propPath, errors);
                        }
                    }
                }
            }
        }
        else if (schema.type === 'array') {
            if (!Array.isArray(obj)) {
                errors.push({
                    path,
                    message: `Expected array, got ${typeof obj}`
                });
                return;
            }

            if (schema.items) {
                obj.forEach((item, index) => {
                    const itemPath = `${path}[${index}]`;
                    this.#validateObject(item, schema.items, itemPath, errors);
                });
            }
        }
        else if (schema.type === 'string') {
            if (typeof obj !== 'string') {
                errors.push({
                    path,
                    message: `Expected string, got ${typeof obj}`
                });
                return;
            }

            if (schema.minLength && obj.length < schema.minLength) {
                errors.push({
                    path,
                    message: `String too short (minimum ${schema.minLength})`
                });
            }

            if (schema.pattern && !new RegExp(schema.pattern).test(obj)) {
                errors.push({
                    path,
                    message: `String does not match pattern ${schema.pattern}`
                });
            }

            if (schema.enum && !schema.enum.includes(obj)) {
                errors.push({
                    path,
                    message: `Value must be one of: ${schema.enum.join(', ')}`
                });
            }
        }
        else if (schema.type === 'integer') {
            if (!Number.isInteger(obj)) {
                errors.push({
                    path,
                    message: `Expected integer, got ${typeof obj}`
                });
            }
        }
        else if (schema.type === 'boolean') {
            if (typeof obj !== 'boolean') {
                errors.push({
                    path,
                    message: `Expected boolean, got ${typeof obj}`
                });
            }
        }
    }

    /**
     * Validate global role constraints
     * @param {Object} template - Role template
     * @param {Array} errors - Error array
     * @private
     */
    static #validateGlobalRoleConstraints(template, errors) {
        // Global roles should auto-start
        if (template.lifecycle && template.lifecycle.autoStart === false) {
            errors.push({
                path: 'lifecycle.autoStart',
                message: 'Global roles should auto-start'
            });
        }

        // Global roles should not have workspace-specific volumes
        if (template.volumes) {
            template.volumes.forEach((volume, index) => {
                const volumeStr = typeof volume === 'string' ? volume : volume.host;
                if (volumeStr && (volumeStr.startsWith('workspace:') || volumeStr.startsWith('user:'))) {
                    errors.push({
                        path: `volumes[${index}]`,
                        message: 'Global roles should not use workspace or user volumes'
                    });
                }
            });
        }
    }

    /**
     * Validate user role constraints
     * @param {Object} template - Role template
     * @param {Array} errors - Error array
     * @private
     */
    static #validateUserRoleConstraints(template, errors) {
        // User roles should have user context in volumes
        if (!template.volumes || !template.volumes.some(v => {
            const volumeStr = typeof v === 'string' ? v : v.host;
            return volumeStr && volumeStr.startsWith('user:');
        })) {
            errors.push({
                path: 'volumes',
                message: 'User roles should have at least one user volume mount'
            });
        }
    }

    /**
     * Validate workspace role constraints
     * @param {Object} template - Role template
     * @param {Array} errors - Error array
     * @private
     */
    static #validateWorkspaceRoleConstraints(template, errors) {
        // Workspace roles must have workspace volumes
        if (!template.volumes || !template.volumes.some(v => {
            const volumeStr = typeof v === 'string' ? v : v.host;
            return volumeStr && volumeStr.startsWith('workspace:');
        })) {
            errors.push({
                path: 'volumes',
                message: 'Workspace roles must have at least one workspace volume mount'
            });
        }

        // Workspace roles should not auto-start
        if (template.lifecycle && template.lifecycle.autoStart === true) {
            errors.push({
                path: 'lifecycle.autoStart',
                message: 'Workspace roles should not auto-start'
            });
        }
    }
}

export default RoleTemplateValidator;
