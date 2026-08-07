'use strict';

// Utils
import path from 'path';
import { existsSync } from 'fs';
import fsPromises from 'fs/promises';
import EventEmitter from 'eventemitter2';
import validator from 'validator';
import { generateNanoid } from '../../utils/id.js';

// Logging
import { createLogger } from '../../utils/log.js';
const logger = createLogger('user-manager');

// Includes
import User from './User.js';
import { resolveUserPaths, applyPathOverrides, USER_MODULES } from './lib/paths.js';

/**
 * Constants
 */

const USER_TYPES = ['user', 'admin'];
const USER_STATUS_CODES = ['active', 'inactive', 'pending', 'deleted'];

/**
 * Users Service
 */

class Users extends EventEmitter {

    #rootPath;      // User $home directory
    #indexStore;    // User index store
    #pathDefaults;  // Server-wide per-module root defaults (env.user.paths)

    // Runtime
    #users = new Map();     // Initialized User Instances, keeps this implementation as slim as possible
    #workspaceManager;      // Workspace manager
    #contextManager;        // Context manager
    #authService;           // Auth service (for token generation)
    #initialized = false;   // Manager initialized flag

    /**
     * Create a new Users service
     * @param {Object} options - Manager options
     * @param {string} options.rootPath - Root path for user homes
     * @param {Object} [options.pathDefaults] - Server-wide module-root defaults
     *   ({workspaces, roles, agents}); a user's own `paths` override wins over these
     * @param {Object} [options.workspaceManager] - Workspace manager (can be set later)
     * @param {Object} [options.authManager] - Auth manager (can be set later)
     */
    constructor(options = {}) {
        super(options.eventEmitterOptions || {});

        if (!options.rootPath) {
            throw new Error('User home root path is required');
        }
        if (!options.indexStore) {
            throw new Error('Index store is required for Users service');
        }

        this.#rootPath = options.rootPath;
        this.#indexStore = options.indexStore;
        this.#pathDefaults = options.pathDefaults || {};
        this.#workspaceManager = options.workspaceManager; // Can be initially undefined
        this.#contextManager = options.contextManager; // Can be initially undefined

        logger.debug(`Initializing Users service with user home directory rootPath: ${this.#rootPath}`);
    }

    /**
     * Initialize service
     * @override
     */
    async initialize() {
        if (this.#initialized) { return true; }

        // Materialize each user's module dirs. Cheap (mkdir -p x3 per user) and
        // it is what makes a repointed server — CANVAS_USER_WORKSPACES=~/Workspaces
        // on a personal instance — show up as real folders for users that
        // already existed, instead of only for the next one created.
        for (const userId of Object.keys(this.#indexStore.store || {})) {
            try {
                await this.ensureUserDirectories(userId);
            } catch (error) {
                logger.warn(`Could not create module directories for user ${userId}: ${error.message}`);
            }
        }

        logger.debug(`Users service initialized with ${this.#indexStore.size} user(s) in index`);
        this.#initialized = true;
        return this;
    }

    /**
     * Getters
     */

    get rootPath() { return this.#rootPath; }
    get pathDefaults() { return { ...this.#pathDefaults }; }
    get users() { return Array.from(this.#users.values()); }
    get indexStore() { return this.#indexStore; }
    get workspaceManager() { return this.#workspaceManager; }

    /**
     * Internal helper for SSH key management
     * @returns {Object} Index store
     * @private
     */
    _getIndexStore() {
        return this.#indexStore;
    }

    /**
     * Setters for late dependency injection to solve circular dependencies.
     */
    setWorkspaceManager(manager) {
        if (!this.#workspaceManager) {
            this.#workspaceManager = manager;
        }
    }

    setContextManager(manager) {
        if (!this.#contextManager) {
            this.#contextManager = manager;
        }
    }

    setAuthService(authService) {
        if (!this.#authService) {
            this.#authService = authService;
        }
    }

    /**
     * User Manager API
     */

    /**
     * Resolve a user identifier (ID, email, or name) to a user ID.
     * @param {string} identifier - The user ID, email, or name.
     * @returns {Promise<string|null>} The user ID if found, otherwise null.
     */
    async resolveId(identifier) {
        if (!this.#initialized) throw new Error('Users service not initialized');
        if (!identifier) return null;

        // Check if it's an ID
        if (await this.has(identifier)) {
            return identifier;
        }

        // Check if it's an email
        if (validator.isEmail(identifier)) {
            const userIdByEmail = this.#findUserIdByEmail(identifier);
            if (userIdByEmail) return userIdByEmail;
        }

        // Check if it's a name
        const userIdByName = this.#findUserIdByName(identifier);
        if (userIdByName) return userIdByName;

        return null;
    }

    /**
     * Create a new user with a Universe workspace
     * @param {Object} userData - User data
     * @param {string} userData.name - User nickname/display name (required)
     * @param {string} userData.email - User email (required)
     * @param {string} [userData.id] - User ID (if not provided, generates 8-char lowercase nanoid)
     * @param {string} [userData.userType='user'] - User type: 'user' or 'admin'
     * @param {string} [userData.status='active'] - User status
     * @returns {Promise<User>} Created user
     */
    async create(userData = {}) {
        if (!this.#initialized) throw new Error('Users service not initialized');

        const id = userData.id || generateNanoid(8);

        try {
            this.#validateUserSettings(userData);

            const email = userData.email.toLowerCase();
            const name = userData.name;
            const userHomePath = this.#homePathFor(email);

            if (await this.has(id)) throw new Error(`User already exists with ID: ${id}`);
            if (await this.hasByEmail(email)) throw new Error(`User already exists with email: ${email} (ID: ${id})`);

            // Pre-register user in index so workspace creation can resolve the ID
            const preliminaryUserData = {
                id,
                name,
                email,
                // Optional per-module root overrides ({workspaces, roles, agents});
                // absent means "follow the server defaults".
                paths: applyPathOverrides({}, userData.paths || {}, userHomePath),
                userType: userData.userType || 'user',
                status: 'pending',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            this.#indexStore.set(id, preliminaryUserData);

            await this.#createHomeDirectory(userHomePath, id, email);

            const user = await this.#initializeUser({
                id,
                name,
                email,
                userType: userData.userType || 'user',
                status: userData.status || 'active',
            });

            // Create an initial context for the user — an ordinary context
            // (deletable like any other), provisioned purely for UX. A failure
            // here must not roll back the user.
            try {
                await this.#contextManager.createContext(user.id, '/', {
                    id: 'default',
                });
            } catch (contextError) {
                logger.warn(`Failed to create initial context for user ${user.id}: ${contextError.message}`);
            }

            // Auto-generate global API token for the user
            if (this.#authService) {
                try {
                    const globalToken = await this.#authService.createToken(user.id, {
                        type: 'api',
                        name: 'Default API Token',
                        description: 'Auto-generated global API token for user access'
                    });
                } catch (tokenError) {
                    console.warn(`Failed to generate global API token for user ${user.id}: ${tokenError.message}`);
                }
            }

            this.emit('user.created', { id, name, email });
            return user;
        } catch (error) {
            // Rollback pre-registration if creation fails
            if (this.#indexStore.has(id)) {
                const storedData = this.#indexStore.get(id);
                if (storedData?.status === 'pending') {
                    this.#indexStore.delete(id);
                }
            }
            throw error;
        }
    }

    /**
     * Get a user by ID
     * @param {string} id - User ID
     * @returns {Promise<User>} User instance
     */
    async get(id) {
        if (!this.#initialized) throw new Error('Users service not initialized');

        if (this.#users.has(id)) {
            return this.#users.get(id);
        }

        const userDataFromIndex = this.#indexStore.get(id);
        if (!userDataFromIndex) {
            throw new Error(`User not found: ${id}`);
        }

        return await this.#initializeUser(userDataFromIndex);
    }

    /**
     * Get a user by email
     * @param {string} email - User email
     * @returns {Promise<User>} User instance
     */
    async getByEmail(email) {
        if (!this.#initialized) {
            throw new Error('Users service not initialized');
        }
        const id = this.#findUserIdByEmail(email);
        if (!id) {
            throw new Error(`User not found by email: ${email}`);
        }
        return this.get(id);
    }

    /**
     * Get a user by name
     * @param {string} name - User name
     * @returns {Promise<User>} User instance
     */
    async getByName(name) {
        if (!this.#initialized) {
            throw new Error('Users service not initialized');
        }
        const id = this.#findUserIdByName(name);
        if (!id) {
            throw new Error(`User not found by name: ${name}`);
        }
        return this.get(id);
    }

    /**
     * Check if user exists by ID
     * @param {string} id - User ID
     * @returns {Promise<boolean>} True if user exists (in memory or index)
     */
    async has(id) {
        if (!this.#initialized) throw new Error('Users service not initialized');
        return this.#users.has(id) || this.#indexStore.has(id);
    }

    /**
     * Check if user exists by email and verify home directory
     * @param {string} email - User email
     * @returns {Promise<boolean>} True if user exists with valid home directory
     */
    async hasByEmail(email) {
        return !!this.#findUserIdByEmail(email);
    }

    /**
     * List all users
     * @param {Object} options - Filtering options
     * @param {string} [options.status] - Filter by status
     * @param {string} [options.userType] - Filter by user type
     * @returns {Promise<Array<Object>>} Array of user objects (JSON representation from index)
     */
    async list(options = {}) {
        if (!this.#initialized) throw new Error('Users service not initialized');
        const allUsersInStore = this.#indexStore.store;
        let usersArray = Object.values(allUsersInStore);

        if (options.status && USER_STATUS_CODES.includes(options.status)) {
            usersArray = usersArray.filter((user) => user.status === options.status);
        }
        if (options.userType && USER_TYPES.includes(options.userType)) {
            usersArray = usersArray.filter((user) => user.userType === options.userType);
        }
        return usersArray;
    }

    /**
     * Update user properties
     * @param {string} id - User ID
     * @param {Object} userData - User data to update
     * @returns {Promise<User>} Updated user instance
     */
    async update(id, userData = {}) {
        if (!this.#initialized) {
            throw new Error('Users service not initialized');
        }
        if (!id) throw new Error('User ID is required');

        const currentUserDataFromIndex = this.#indexStore.get(id);
        if (!currentUserDataFromIndex) {
            throw new Error(`User not found in index: ${id}`);
        }

        if (userData.email && userData.email.toLowerCase() !== currentUserDataFromIndex.email.toLowerCase()) {
            const lowerCaseNewEmail = userData.email.toLowerCase();
            const allUsersInStore = this.#indexStore.store;
            for (const userIdInIdx in allUsersInStore) {
                if (allUsersInStore[userIdInIdx].email.toLowerCase() === lowerCaseNewEmail && userIdInIdx !== id) {
                    throw new Error(`Email already in use: ${userData.email}`);
                }
            }
        }

        const updateDataForValidation = {
            ...userData,
            homePath: this.#homePathFor(currentUserDataFromIndex.email),
            originalName: currentUserDataFromIndex.name,
        };
        try {
            this.#validateUserSettings(updateDataForValidation, true);
        } catch (error) {
            throw new Error(`Invalid user data: ${error.message}`);
        }

        const updatedUserDataToStore = {
            ...currentUserDataFromIndex,
            ...userData,
            updatedAt: new Date().toISOString(),
        };
        this.#indexStore.set(id, updatedUserDataToStore);

        const updatedUserInstance = await this.#initializeUser({
            ...updatedUserDataToStore,
            workspaceManager: this.#workspaceManager,
        });
        this.emit('user.updated', { id, updates: userData });
        return updatedUserInstance;
    }

    /**
     * Delete a user
     * @param {string} id - User ID
     * @returns {Promise<boolean>} True if user was deleted
     */
    async delete(id) {
        if (!this.#initialized) throw new Error('Users service not initialized');
        if (!id) throw new Error('User ID is required');

        if (!this.#indexStore.has(id)) {
            throw new Error(`User not found: ${id}`);
        }

        const userToDeleteData = this.#indexStore.get(id);
        this.#indexStore.delete(id);

        if (this.#users.has(id)) {
            this.#users.delete(id);
        }

        console.log(`User ${id} deleted. Home directory left in place: ${this.#homePathFor(userToDeleteData.email)}`);
        this.emit('user.deleted', { id });
        return true;
    }

    /**
     * Utils
     */

    /**
     * @deprecated The universe workspace is an ordinary (deletable) workspace
     * now — nothing is repaired or auto-started on login anymore; workspaces
     * start on demand (ContextManager.getContext / workspace routes). Kept as
     * a cheap no-op because auth strategies still call it on every login;
     * call sites will be removed in a follow-up.
     */
    async ensureUserUniverseWorkspaceIsRunning(userId) {
        if (!this.#initialized) {
            throw new Error('Users service not initialized');
        }
        return this.has(userId);
    }

    /**
     * @deprecated The default context is an ordinary (deletable) context now —
     * a user with zero contexts is a valid state and nothing is recreated on
     * login. No-op for the same reason as above.
     */
    async ensureDefaultUserContextExists(userId) {
        if (!this.#initialized) {
            throw new Error('Users service not initialized');
        }
        return this.has(userId);
    }

    /**
     * Absolute roots of this user's three modules — {workspaces, roles, agents}.
     * The single authority for "where does this user's stuff live": workspace
     * discovery, agent creation and the frontend all go through here instead of
     * joining directory names onto a home path.
     *
     * Reads straight from the index, so it works for users that were never
     * instantiated (boot-time scans) and stays correct when a server default
     * changes — nothing is cached.
     * @param {string} userId
     * @returns {{workspaces: string, roles: string, agents: string}}
     */
    getUserPaths(userId) {
        const entry = this.#indexStore.get(userId);
        if (!entry?.email) { throw new Error(`Cannot resolve paths: user not found: ${userId}`); }
        return resolveUserPaths({
            homePath: this.#homePathFor(entry.email),
            overrides: entry.paths,
            defaults: this.#pathDefaults,
        });
    }

    /**
     * Point one or more of a user's modules at a different directory.
     * `null` clears an override (back to the server default / <home>/<Module>).
     *
     * Relocating is non-destructive and NOT a move: existing workspaces and
     * agents are indexed by absolute path and keep working where they are —
     * only discovery and newly created entries follow the new root. The new
     * directories are created if missing.
     * @param {string} userId
     * @param {{workspaces?: string|null, roles?: string|null, agents?: string|null}} patch
     * @returns {Promise<{workspaces: string, roles: string, agents: string}>} resolved paths
     */
    async setUserPaths(userId, patch = {}) {
        if (!this.#initialized) throw new Error('Users service not initialized');
        const entry = this.#indexStore.get(userId);
        if (!entry?.email) { throw new Error(`User not found: ${userId}`); }

        const overrides = applyPathOverrides(entry.paths || {}, patch, this.#homePathFor(entry.email));
        if (JSON.stringify(overrides) === JSON.stringify(entry.paths || {})) { return this.getUserPaths(userId); }
        // Write through update() so the in-memory instance is refreshed too.
        await this.update(userId, { paths: overrides });
        const resolved = this.getUserPaths(userId);
        await this.ensureUserDirectories(userId);
        this.emit('user.paths.updated', { id: userId, paths: resolved });
        return resolved;
    }

    /** Create any missing module directories for a user. Idempotent. */
    async ensureUserDirectories(userId) {
        const paths = this.getUserPaths(userId);
        for (const module of USER_MODULES) {
            await fsPromises.mkdir(paths[module], { recursive: true });
        }
        return paths;
    }

    /**
     * Private methods
     */

    /**
     * A user's home is always <userHome>/<email> — derived, never stored.
     * Persisting it would pin every record to the absolute path that happened
     * to be current at creation, so moving the users root (or changing the
     * container's layout) would leave every user pointing at a directory that
     * no longer exists and cannot be created.
     */
    #homePathFor(email) {
        return path.join(this.#rootPath, String(email).toLowerCase());
    }

    async #createHomeDirectory(homePath, userId, userEmail) {
        if (!this.#workspaceManager) {
            throw new Error('WorkspaceManager required');
        }

        // An existing home directory is normal, not a conflict: the container
        // pre-creates <userHome>/<email>/{Workspaces,Roles,Agents} on the host
        // (docker would otherwise create those bind mountpoints as root), and a
        // reinstall against a kept users tree lands here too. Nothing below
        // overwrites anything — the module dirs are mkdir -p and the universe
        // workspace refuses a directory that already is one.
        const userHomePath = path.resolve(homePath);
        await fsPromises.mkdir(userHomePath, { recursive: true });

        // The three per-user modules get their directories up front, wherever
        // they were configured to live (see lib/paths.js) — a user's home is
        // not assumed to contain them.
        const paths = await this.ensureUserDirectories(userId);

        // Canonical location is <workspacesRoot>/universe (the dir the discovery
        // scan watches); the legacy lowercase <home>/workspaces/ is still
        // scanned for existing users.
        const universeWorkspacePath = path.join(paths.workspaces, 'universe');
        try {
            await this.#workspaceManager.createUniverseWorkspace(userId, userEmail, universeWorkspacePath);
        } catch (error) {
            // Reinstalling over a kept users tree: universe is already a
            // workspace on disk. Adopt what is there rather than failing the
            // account creation over it.
            logger.warn(`Universe workspace for ${userEmail} not created (${error.message}); scanning for existing workspaces`);
            await this.#workspaceManager.scanUserWorkspaces(userId);
        }

        return userHomePath;
    }

    async #initializeUser(userData) {
        if (!userData.id) throw new Error('User ID is required');
        if (!userData.name) throw new Error('Name is required');
        if (!userData.email) throw new Error('Email is required');

        const userOptions = {
            ...userData, // This has id, name, email, userType, status
            // Derived, so a record written under a different users root (an
            // older container layout, a relocated home) still resolves here.
            homePath: this.#homePathFor(userData.email),
            // Module roots resolve per read: the record carries only overrides,
            // these are the server-wide fallbacks behind them.
            pathDefaults: this.#pathDefaults,
            eventEmitterOptions: this.eventEmitterOptions
        };

        // Create and initialize the User instance
        const user = new User(userOptions);

        // Setup event listeners
        this.#setupUserEventListeners(user);

        // Store the user instance
        this.#saveEntry(user.id, user);

        // Workspaces start on demand — no auto-start of any workspace here.
        return user;
    }

    /**
     * Validate user settings for creation or updates
     * @param {Object} userSettings - User settings to validate
     * @param {boolean} [isUpdate=false] - If true, treat as an update validation (fewer required fields)
     * @throws {Error} If validation fails
     * @private
     */
     #validateUserSettings(userSettings, isUpdate = false) {
        if (!userSettings) {
            throw new Error('User settings are required');
        }

        // Name and email are required for new users, and must be valid if provided
        if (!isUpdate && !userSettings.name) {
            throw new Error('User name is required');
        }

        if (!isUpdate && !userSettings.email) {
            throw new Error('User email is required');
        }

        if (userSettings.name) {
            if (typeof userSettings.name !== 'string') {
                throw new Error('User name must be a string');
            }

            if (userSettings.name.trim().length === 0) {
                throw new Error('User name cannot be empty');
            }

            // GitHub-style username validation
            const username = userSettings.name.toLowerCase().trim();
            const usernameRegex = /^[a-z0-9_-]+$/;

            if (!usernameRegex.test(username)) {
                throw new Error('User name can only contain lowercase letters, numbers, underscores, and hyphens');
            }

            if (username.length < 3) {
                throw new Error('User name must be at least 3 characters long');
            }

            if (username.length > 39) {
                throw new Error('User name cannot be longer than 39 characters');
            }

            // Check for reserved names (GitHub-style)
            const reservedNames = [
                'admin', 'administrator', 'root', 'system', 'support', 'help',
                'api', 'www', 'mail', 'ftp', 'localhost', 'test', 'demo',
                'canvas', 'universe', 'workspace', 'context', 'user', 'users',
                // `me` addresses the authenticated caller in the REST API
                // (/rest/v2/users/me/...); a user of that name would be
                // unaddressable the day a /users/:id route lands.
                'me'
            ];

            if (reservedNames.includes(username)) {
                // Allow 'admin' username only for admin user type
                if (username === 'admin' && userSettings.userType === 'admin') {
                    // Allow admin username for admin user type
                } else {
                    throw new Error(`User name '${username}' is reserved and cannot be used`);
                }
            }

            // Check for uniqueness (only for new users or name changes)
            if (!isUpdate || (isUpdate && userSettings.name !== userSettings.originalName)) {
                this.#validateUsernameUniqueness(username, userSettings.id);
            }

            // Update the name to the validated format
            userSettings.name = username;
        }

        if (userSettings.email && !validator.isEmail(userSettings.email)) {
            throw new Error('Invalid user email');
        }

        // Validate user type if provided
        if (userSettings.userType && !USER_TYPES.includes(userSettings.userType)) {
            throw new Error(`Invalid user type: ${userSettings.userType}`);
        }

        // Validate status if provided
        if (userSettings.status && !USER_STATUS_CODES.includes(userSettings.status)) {
            throw new Error(`Invalid user status: ${userSettings.status}`);
        }
    }

    /**
     * Validate that a username is unique across all users
     * @param {string} username - Username to validate
     * @param {string} [excludeUserId] - User ID to exclude from uniqueness check (for updates)
     * @throws {Error} If username is not unique
     * @private
     */
    #validateUsernameUniqueness(username, excludeUserId = null) {
        // Check in-memory users first
        for (const user of this.#users.values()) {
            if (excludeUserId && user.id === excludeUserId) {
                continue; // Skip the user being updated
            }
            if (user.name === username) {
                throw new Error(`User name '${username}' is already taken`);
            }
        }

        // Check in the index store
        for (const [id, userData] of Object.entries(this.#indexStore.store || {})) {
            if (excludeUserId && id === excludeUserId) {
                continue; // Skip the user being updated
            }
            if (userData?.name === username) {
                throw new Error(`User name '${username}' is already taken`);
            }
        }
    }

    /**
     * Find a user ID by email in memory or store
     * @param {string} email - User email
     * @returns {string|null} User ID if found, otherwise null
     * @private
     */
    #findUserIdByEmail(email) {
        const lower = email.toLowerCase();
        for (const user of this.#users.values()) {
            if (user.email.toLowerCase() === lower) return user.id;
        }
        for (const [id, data] of Object.entries(this.#indexStore.store || {})) {
            if (data?.email?.toLowerCase() === lower) return id;
        }
        return null;
    }

    /**
     * Find a user ID by name in memory or store
     * @param {string} name - User name
     * @returns {string|null} User ID if found, otherwise null
     * @private
     */
    #findUserIdByName(name) {
        const lower = name.toLowerCase();
        for (const user of this.#users.values()) {
            if (user.name.toLowerCase() === lower) return user.id;
        }
        for (const [id, data] of Object.entries(this.#indexStore.store || {})) {
            if (data?.name?.toLowerCase() === lower) return id;
        }
        return null;
    }

    #setupUserEventListeners(user) {
        user.on('update', (data) => {
            const updatedUser = this.#users.get(data.id);
            if (updatedUser) {
                this.#saveEntry(data.id, updatedUser.toJSON());
            }
        });
    }

    #saveEntry(id, data) {
        this.#users.set(id, data);
        // The index holds plain records, never live User instances: a User's
        // `paths` getter exposes RESOLVED module roots, and persisting those
        // would turn every default into an explicit override — the user would
        // silently stop following the server default they never opted out of.
        this.#indexStore.set(id, typeof data?.toJSON === 'function' ? data.toJSON() : data);
    }
}

export default Users;
export {
    USER_TYPES,
    USER_STATUS_CODES
};
