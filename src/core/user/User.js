'use strict';

// Utils
import path from 'path';
import EventEmitter from 'eventemitter2';

// Logging
import { createLogger } from '../../utils/log.js';
const logger = createLogger('user-manager:user');

// Constants
import { USER_STATUS_CODES } from './index.js';

/**
 * User Class
 */

class User extends EventEmitter {

    #id;
    #name;
    #email;
    #userType;
    #authMethod;
    #authMetadata;
    #homePath;
    #avatar;

    // Runtime state
    #status = 'inactive'; // inactive, active, disabled, deleted
    #startTime = Date.now(); // User container start time

    /**
     * Create a new User instance
     * @param {Object} options - User options
     * @param {string} [options.id] - User ID (if not provided, generates 8-char lowercase nanoid)
     * @param {string} options.name - User nickname/display name (required)
     * @param {string} options.email - User email (required)
     * @param {string} options.authMethod - User auth method (local, imap, ldap, oauth2, etc.)
     * @param {Object} [options.authMetadata] - Additional auth metadata (server, domain, provider, etc.)
     * @param {string} options.homePath - User home path (Universe workspace)
     * @param {string} [options.userType='user'] - User type ('user' or 'admin')
     * @param {string} [options.status='inactive'] - User status
     */
    constructor(options = {}) {
        super(options.eventEmitterOptions || {});

        // Validate required options
        if (!options.id) { throw new Error('ID is required'); }
        if (!options.name) { throw new Error('Name is required'); }
        if (!options.email) { throw new Error('Email is required'); }
        if (!options.homePath) { throw new Error('Home path is required'); }
        if (!options.avatar) { options.avatar = '/images/avatars/default.png'; }

        /**
         * User properties
         */

        this.#id = options.id;
        this.#name = options.name;
        this.#email = options.email;
        this.#authMethod = options.authMethod || 'local';
        this.#authMetadata = options.authMetadata || {};
        this.#avatar = options.avatar;
        this.#homePath = path.resolve(options.homePath); // Ensure absolute path
        this.#userType = options.userType || 'user';
        this.#status = options.status || 'inactive';
        logger.debug(`User instance created: ${this.#id} (${this.#name} - ${this.#email}) via ${this.#authMethod} with home path: ${this.#homePath}`);
    }

    /**
     * Getters
     */

    get id() { return this.#id; }
    get name() { return this.#name; }
    get email() { return this.#email; }
    get userType() { return this.#userType; }
    get authMethod() { return this.#authMethod; }
    get authMetadata() { return this.#authMetadata; }
    get homePath() { return this.#homePath; }
    get avatar() { return this.#avatar; }
    get status() { return this.#status; }
    get uptime() { return Date.now() - this.#startTime; }

    /**
     * Setters
     */

    set status(status) {
        if (!USER_STATUS_CODES.includes(status)) {
            throw new Error(`Invalid status: ${status}`);
        }
        this.#status = status;
        this.emit('update', {
            id: this.#id,
            name: this.#name,
            email: this.#email,
            status: this.#status
        });
    }

    /**
     * Utility methods
     */

    isAdmin() {
        return this.#userType === 'admin';
    }

    isActive() {
        return this.#status === 'active';
    }

    isLocal() {
        return this.#authMethod === 'local';
    }

    isExternal() {
        return ['imap', 'ldap', 'oauth2'].includes(this.#authMethod);
    }

    /**
     * Get authentication display info
     * @returns {string} Human-readable auth method description
     */
    getAuthDisplay() {
        const method = this.#authMethod.toUpperCase();
        if (this.#authMetadata?.server || this.#authMetadata?.domain) {
            const server = this.#authMetadata.server || this.#authMetadata.domain;
            return `${method} (${server})`;
        }
        if (this.#authMetadata?.provider) {
            return `${method} (${this.#authMetadata.provider})`;
        }
        return method;
    }

    /**
     * Convert user to JSON
     * @returns {Object} User JSON representation
     */
    toJSON() {
        return {
            id: this.#id,
            name: this.#name,
            email: this.#email,
            userType: this.#userType,
            authMethod: this.#authMethod,
            authMetadata: this.#authMetadata,
            homePath: this.#homePath,
            avatar: this.#avatar,
            status: this.#status
        };
    }

}

export default User;
