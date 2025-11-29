'use strict';

// Load parsed env variables
import { env } from './env.js';

// Utils
import path from 'path';
import Jim from './utils/jim/index.js';
const jim = new Jim({
    rootPath: path.join(env.server.home, 'db'),
    driver: 'conf',
    driverOptions: {
        accessPropertiesByDotNotation: false,
    }
});

// Logging
import createDebug from 'debug';
const debug = createDebug('canvas:server');

// Managers
import WorkspaceManager from './core/workspace/index.js';
import Users from './core/user/index.js';
import ContextManager from './core/context/index.js';
// DotfileManager is now part of WorkspaceManager
import Roles from './core/role/index.js';
import Agents from './core/agent/index.js';
import EventEmitter from 'eventemitter2';
import { authService } from './transports/auth/service.js';
import { startTransportServer } from './transports/index.js';

/**
 * Canvas Server
 */

class Server extends EventEmitter {

    // Runtime
    #mode;
    #initialized = false;

    // Global managers
    #users;
    #workspaceManager;
    #contextManager;
    #roles;
    #agents;

    // Global services
    #authService;
    #apiServer;

    constructor(options = {}) {
        super();

        debug('Initializing canvas-server..');
        debug('Canvas server options:', options);
        debug('Environment options:', JSON.stringify(env, null, 2));
        this.#mode = options.mode || env.server.mode;

        this.options = options;
    }

    /**
     * Getters
     */

    get mode() { return this.#mode; }
    get isInitialized() { return this.#initialized; }

    get users() {
        if (!this.#initialized) {
            throw new Error('Users service not initialized');
        }

        return this.#users;
    }

    get workspaceManager() {
        if (!this.#initialized) {
            throw new Error('WorkspaceManager not initialized');
        }

        return this.#workspaceManager;
    }

    get contextManager() {
        if (!this.#initialized) {
            throw new Error('ContextManager not initialized');
        }

        return this.#contextManager;
    }

    get roles() {
        if (!this.#initialized) {
            throw new Error('Roles service not initialized');
        }

        return this.#roles;
    }

    get agents() {
        if (!this.#initialized) {
            throw new Error('Agents service not initialized');
        }

        return this.#agents;
    }

    get authService() {
        if (!this.#initialized) {
            throw new Error('AuthService not initialized');
        }

        return this.#authService;
    }

    /**
     * Initialize Canvas Server
     */

    async initialize() {
        if (this.#initialized) return this;

        // Initialize core services
        await this.#initializeCoreServices();

        // Initialize auth service with user home path
        this.#authService = authService;
        await this.#authService.initialize({
            userHomePath: env.user.home
        });

        // Inject authService into users for token generation
        this.#users.setAuthService(this.#authService);

        // Create admin user if needed
        if (env.admin?.email) {
            await this.#createAdminUser();
        }

        // Start API server if enabled
        if (env.server.api.enabled) {
            this.#apiServer = await startTransportServer({
                port: env.server.api.port,
                host: env.server.api.host,
                users: this.#users,
                workspaceManager: this.#workspaceManager,
                contextManager: this.#contextManager,
                dotfileManager: this.#workspaceManager.dotfileService, // Access via WorkspaceManager
                roles: this.#roles,
                agents: this.#agents,
                authService: this.#authService
            });
        }

        this.#initialized = true;
        return this;
    }

    async #initializeCoreServices() {
        this.#users = new Users({
            rootPath: env.user.home,
            indexStore: jim.createIndex('users'),
        });

        this.#workspaceManager = new WorkspaceManager({
            defaultRootPath: env.user.home,
            indexStore: jim.createIndex('workspaces'),
            users: this.#users,
        });

        this.#contextManager = new ContextManager({
            indexStore: jim.createIndex('contexts'),
            workspaceManager: this.#workspaceManager
        });

        // DotfileManager initialized inside WorkspaceManager now

        this.#roles = new Roles({
            indexStore: jim.createIndex('roles'),
            users: this.#users,
            workspaceManager: this.#workspaceManager,
            serverConfig: {
                dataPath: env.server.home
            }
        });

        this.#workspaceManager.setRoles(this.#roles); // Late injection if method exists

        this.#agents = new Agents({
            defaultRootPath: path.join(env.server.home, 'agents'),
            indexStore: jim.createIndex('agents'),
            users: this.#users,
        });

        this.#users.setWorkspaceManager(this.#workspaceManager);
        this.#users.setContextManager(this.#contextManager);

        await this.#users.initialize();
        await this.#workspaceManager.initialize(); // This initializes dotfileService
        await this.#contextManager.initialize();
        await this.#roles.initialize();
        await this.#agents.initialize();

        // Note: authService will be injected after initialization in the main initialize method
    }

    async #createAdminUser() {
        try {
            const adminEmail = env.admin.email;
            const forceReset = env.admin.forceReset;

            debug(`Attempting to create admin user with email: ${adminEmail}, forceReset: ${forceReset}`);

            const adminExists = await this.#users.hasByEmail(adminEmail);
            debug(`Admin user exists: ${adminExists}`);

            // If admin exists and we're not forcing a reset, skip creation
            if (adminExists && !forceReset) {
                debug(`Admin user ${adminEmail} already exists, skipping creation.`);
                return null;
            }

            // Generate password or use configured one
            const password = env.admin.password || this.#authService.generateSecurePassword(12);
            debug(`Using ${env.admin.password ? 'configured' : 'generated'} password for admin user`);

            let user;
            if (adminExists) {
                // Get existing user for update
                user = await this.#users.getByEmail(adminEmail);
                debug(`Resetting admin user ${adminEmail} with ID: ${user.id}`);
            } else {
                // Create new admin user
                debug(`Creating new admin user ${adminEmail}`);
                user = await this.#users.create({
                    name: this.#generateUsernameFromEmail(adminEmail), // Generate proper username
                    email: adminEmail,
                    userType: 'admin',
                    status: 'active'
                });
                debug(`Created new admin user ${adminEmail} with ID: ${user.id}`);
            }

            // Set password
            debug(`Setting password for admin user ${user.id}`);
            await this.#authService.setPassword(user.id, password);

            // Create API token (remove existing one if force reset)
            debug(`Creating API token for admin user ${user.id}`);
            if (forceReset) {
                // Find and remove existing Admin API Token
                const existingTokens = await this.#authService.listTokens(user.id);
                const existingAdminToken = existingTokens.find(token => token.name === 'Admin API Token');
                if (existingAdminToken) {
                    debug(`Removing existing Admin API Token ${existingAdminToken.id}`);
                    await this.#authService.deleteToken(user.id, existingAdminToken.id);
                }
            }

            const apiToken = await this.#authService.createToken(user.id, {
                name: 'Admin API Token',
                description: 'Default admin token',
            });
            debug(`API token created with ID: ${apiToken.id}`);

            // Display credentials
            this.#displayAdminCredentials({
                email: adminEmail,
                password,
                apiToken: apiToken.value
            });

            return {
                email: adminEmail,
                password,
                apiToken: apiToken.value
            };
        } catch (error) {
            debug(`Error creating/resetting admin user: ${error.message}`);
            console.error('Failed to create admin user:', error);
            return null;
        }
    }

    /**
     * Display admin credentials in the console
     * @param {object} credentials - Admin credentials
     * @private
     */
    #displayAdminCredentials(credentials) {
        if (!credentials) return;

        console.log('\n' + '='.repeat(80));
        console.log(`Canvas Admin User${env.admin.forceReset ? ' RESET' : ''}`);
        console.log('='.repeat(80));
        console.log(`Email: ${credentials.email}`);
        console.log(`Password: ${credentials.password}`);
        console.log(`API Token: ${credentials.apiToken}`);
        console.log('='.repeat(80) + '\n');
    }

    async start() {
        if (!this.#initialized) {
            throw new Error('Server not initialized');
        }

        return this;
    }

    async stop() {
        if (!this.#initialized) {
            throw new Error('Server not initialized');
        }
        if (this.#apiServer) {
            await this.#apiServer.close();
        }
        return this;
    }

    async restart() {
        if (!this.#initialized) {
            throw new Error('Server not initialized');
        }
        await this.stop();
        await this.start();
        return this;
    }

    /**
     * Generate a GitHub-style username from an email address
     * @param {string} email - Email address
     * @returns {string} - Valid username
     * @private
     */
    #generateUsernameFromEmail(email) {
        // Extract the local part (before @)
        let username = email.split('@')[0].toLowerCase();

        // Remove special characters, keep only letters, numbers, dots, underscores, hyphens
        username = username.replace(/[^a-z0-9._-]/g, '');

        // Replace dots and underscores with hyphens for consistency
        username = username.replace(/[._]/g, '-');

        // Remove consecutive hyphens
        username = username.replace(/-+/g, '-');

        // Remove leading and trailing hyphens
        username = username.replace(/^-+|-+$/g, '');

        // Ensure maximum length
        if (username.length > 32) {
            username = username.substring(0, 32);
            // Remove trailing hyphens if we cut in the middle
            username = username.replace(/-+$/, '');
        }

        return username;
    }
}

// Create server instance
const server = new Server();

// Export Server as singleton
export default server;
export {
    jim
}
