'use strict';

// Load parsed env variables
import { env } from './env.js';

// Utils
import path from 'path';
import EventEmitter from 'eventemitter2';
import Jim from './utils/jim/index.js';
const jim = new Jim({
    rootPath: path.join(env.server.home, 'db'),
    driver: 'conf',
    driverOptions: {
        accessPropertiesByDotNotation: false,
    }
});

// Logging
import { createLogger } from './utils/log.js';
const logger = createLogger('server');

// Managers
import WorkspaceManager from './core/workspace/index.js';
import Users from './core/user/index.js';
import ContextManager from './core/context/index.js';
import Roles from './core/role/index.js';
import Agents from './core/agent/index.js';

// Services
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

        logger.debug('Initializing canvas-server..');
        logger.debug({ options }, 'Canvas server options');
        logger.debug({ env }, 'Environment options');
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
            logger: createLogger('users'),
        });

        this.#workspaceManager = new WorkspaceManager({
            defaultRootPath: env.user.home,
            indexStore: jim.createIndex('workspaces'),
            users: this.#users,
            logger: createLogger('workspace-manager'),
        });

        this.#contextManager = new ContextManager({
            indexStore: jim.createIndex('contexts'),
            workspaceManager: this.#workspaceManager,
            logger: createLogger('context-manager'),
        });

        // DotfileManager initialized inside WorkspaceManager now

        this.#roles = new Roles({
            indexStore: jim.createIndex('roles'),
            users: this.#users,
            workspaceManager: this.#workspaceManager,
            serverConfig: {
                dataPath: env.server.home
            },
            logger: createLogger('roles'),
        });

        this.#workspaceManager.setRoles(this.#roles); // Late injection if method exists

        this.#agents = new Agents({
            defaultRootPath: path.join(env.server.home, 'agents'),
            indexStore: jim.createIndex('agents'),
            users: this.#users,
            logger: createLogger('agents'),
        });

        this.#users.setWorkspaceManager(this.#workspaceManager);
        this.#users.setContextManager(this.#contextManager);
        this.#workspaceManager.setContextManager(this.#contextManager);

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

            logger.debug({ adminEmail, forceReset }, 'Attempting to create admin user');

            const adminExists = await this.#users.hasByEmail(adminEmail);
            logger.debug({ adminExists }, 'Admin user check');

            // If admin exists and we're not forcing a reset, skip creation
            if (adminExists && !forceReset) {
                logger.debug({ adminEmail }, 'Admin user already exists, skipping creation');
                return null;
            }

            // Generate password or use configured one
            const password = env.admin.password || this.#authService.generateSecurePassword(12);
            logger.debug('Using %s password for admin user', env.admin.password ? 'configured' : 'generated');

            let user;
            if (adminExists) {
                // Get existing user for update
                user = await this.#users.getByEmail(adminEmail);
                logger.debug({ adminEmail, userId: user.id }, 'Resetting admin user');
            } else {
                // Create new admin user
                logger.debug({ adminEmail }, 'Creating new admin user');
                user = await this.#users.create({
                    name: this.#generateUsernameFromEmail(adminEmail), // Generate proper username
                    email: adminEmail,
                    userType: 'admin',
                    status: 'active'
                });
                logger.debug({ adminEmail, userId: user.id }, 'Created new admin user');
            }

            // Set password
            logger.debug({ userId: user.id }, 'Setting password for admin user');
            await this.#authService.setPassword(user.id, password);

            // Create API token (remove existing one if force reset)
            logger.debug({ userId: user.id }, 'Creating API token for admin user');
            if (forceReset) {
                // Find and remove existing Admin API Token
                const existingTokens = await this.#authService.listTokens(user.id);
                const existingAdminToken = existingTokens.find(token => token.name === 'Admin API Token');
                if (existingAdminToken) {
                    logger.debug({ tokenId: existingAdminToken.id }, 'Removing existing Admin API Token');
                    await this.#authService.deleteToken(user.id, existingAdminToken.id);
                }
            }

            const apiToken = await this.#authService.createToken(user.id, {
                name: 'Admin API Token',
                description: 'Default admin token',
            });
            logger.debug({ tokenId: apiToken.id }, 'API token created');

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
            logger.error({ err: error }, 'Failed to create admin user');
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
