'use strict';

// Utils
import path from 'path';
import EventEmitter from 'eventemitter2';

// Logging
import { createLogger } from '../../utils/log.js';
const logger = createLogger('user-manager:user');

// Constants
import { USER_STATUS_CODES } from './index.js';
import { resolveUserPaths, USER_MODULES } from './lib/paths.js';

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
    // Per-user module roots: explicit overrides + the server-wide defaults they
    // fall back to. Resolved on read (see `paths`), never frozen at construction.
    #pathOverrides;
    #pathDefaults;

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
     * @param {Object} [options.paths] - Per-module root overrides ({workspaces, roles, agents})
     * @param {Object} [options.pathDefaults] - Server-wide module-root defaults (env.user.paths)
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
        this.#pathOverrides = options.paths && typeof options.paths === 'object' ? options.paths : {};
        this.#pathDefaults = options.pathDefaults && typeof options.pathDefaults === 'object' ? options.pathDefaults : {};
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
    /**
     * Absolute roots of the three per-user modules — {workspaces, roles, agents}.
     * This is the single authority: discovery, creation and the frontend all
     * read it rather than joining 'Workspaces' onto a home path themselves.
     */
    get paths() {
        return resolveUserPaths({
            homePath: this.#homePath,
            overrides: this.#pathOverrides,
            defaults: this.#pathDefaults,
        });
    }
    /** The user's own overrides only (what is persisted; unset modules absent). */
    get pathOverrides() {
        const out = {};
        for (const module of USER_MODULES) {
            if (this.#pathOverrides?.[module]) { out[module] = this.#pathOverrides[module]; }
        }
        return out;
    }
    get workspacesPath() { return this.paths.workspaces; }
    get rolesPath() { return this.paths.roles; }
    get agentsPath() { return this.paths.agents; }
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
            // OVERRIDES only — toJSON is what gets persisted to the user index,
            // and writing the resolved paths back would freeze them as explicit
            // overrides, so a later change of the server default would no longer
            // apply. Resolved values come from `paths` / users.getUserPaths().
            paths: this.pathOverrides,
            avatar: this.#avatar,
            status: this.#status
        };
    }

}

export default User;
