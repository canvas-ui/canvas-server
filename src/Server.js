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
import DeviceRegistry from './core/device/Registry.js';
import UserConfigStore from './core/user/ConfigStore.js';
import Roles from './core/role/index.js';
import Agents from './core/agent/index.js';
import Embedd from './services/embedd/src/index.js';
import Voice from './services/voice/src/index.js';
import Messaging from './services/messaging/src/index.js';
import ChatRouter from './services/messaging/src/router.js';
import ConsoleAdapter from './services/messaging/src/adapters/console.js';
import CanvasAdapter from './services/messaging/src/adapters/canvas.js';
import WebhookAdapter from './services/messaging/src/adapters/webhook.js';
import SlackAdapter from './services/messaging/src/adapters/slack.js';
import WhatsAppAdapter from './services/messaging/src/adapters/whatsapp.js';

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
    #embedd;    // shared embedding service (server-managed singleton; optional)
    #messaging; // user notification/chat channels (server-managed singleton; optional)
    #chatRouter; // inbound chat → agent routing (requires #messaging)
    #voice;     // STT/TTS service (server-managed singleton; optional)

    // Global services
    #authService;
    #deviceRegistry;
    #userConfig;
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

    get deviceRegistry() {
        if (!this.#initialized) {
            throw new Error('DeviceRegistry not initialized');
        }

        return this.#deviceRegistry;
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

        this.#deviceRegistry = new DeviceRegistry({
            userHomePath: env.user.home,
            usersIndex: this.#users.indexStore,
            logger: createLogger('device-registry'),
        });

        this.#userConfig = new UserConfigStore({
            userHomePath: env.user.home,
            usersIndex: this.#users.indexStore,
            logger: createLogger('user-config'),
        });

        // Create admin user if needed
        if (env.admin?.email) {
            await this.#createAdminUser();
        }

        // Start API server if enabled
        if (env.server.api.enabled) {
            this.#apiServer = await startTransportServer({
                port: env.server.api.port,
                host: env.server.api.host,
                logger: createLogger('http'),
                users: this.#users,
                workspaceManager: this.#workspaceManager,
                contextManager: this.#contextManager,
                dotfileManager: this.#workspaceManager.dotfileService, // Access via WorkspaceManager
                roles: this.#roles,
                agents: this.#agents,
                authService: this.#authService,
                deviceRegistry: this.#deviceRegistry,
                userConfig: this.#userConfig,
                messaging: this.#messaging,
                chatRouter: this.#chatRouter,
                voice: this.#voice,
            });
        }

        // Connect inbound chat channels (Slack Socket Mode; WhatsApp arrives
        // via webhook). After the API server is up so agent prompts can use
        // loopback canvas tools from the very first message.
        if (this.#messaging && this.#chatRouter) {
            await this.#messaging.start((message) => this.#chatRouter.handle(message));
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

        // Shared embedding service — model runtimes are shared across workspaces
        // (avoids the per-workspace model footprint) while each workspace owns its
        // own queue. Optional: when disabled, workspaces run store-only and dense
        // search degrades to FTS.
        //
        // The embedd config file is the SERVER DEFAULT layer — how an operator
        // points the whole box at a GPU host. Users override it per modality from
        // their settings (`resolveUserConfig` below); a workspace embeds with its
        // owner's models. A malformed server file throws here on purpose: a
        // typo'd provider id would otherwise degrade dense search silently, which
        // is far worse than a loud boot failure. A malformed USER config does not
        // throw — it falls back to these defaults and reports why.
        if (env.embedd.enabled) {
            this.#embedd = new Embedd({
                onnxCacheDir: env.embedd.cacheDir,
                ollamaHost: env.embedd.ollamaHost,
                concurrency: env.embedd.concurrency,
                providers: env.embedd.providers,
                spaces: env.embedd.spaces,
                rules: env.embedd.rules,
                resolveUserConfig: (userId) => this.#userConfig.read(userId, 'embedd'),
            });
        }

        this.#workspaceManager = new WorkspaceManager({
            defaultRootPath: env.user.home,
            indexFactory: jim, // per-user index files under db/users/<id>/
            users: this.#users,
            embedd: this.#embedd,
            logger: createLogger('workspace-manager'),
        });

        this.#contextManager = new ContextManager({
            indexFactory: jim, // per-user index files under db/users/<id>/
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
            defaultRootPath: path.join(env.server.home, 'users'),
            indexStore: jim.createIndex('agents'),
            users: this.#users,
        });

        this.#users.setWorkspaceManager(this.#workspaceManager);
        this.#users.setContextManager(this.#contextManager);
        this.#workspaceManager.setContextManager(this.#contextManager);

        // Agent bindings resolve against workspaces/contexts; agent canvas
        // tools call our own REST API over loopback with the agent's token
        // (canvas-edge later flips this URL to the server's public address).
        this.#agents.setWorkspaceManager(this.#workspaceManager);
        this.#agents.setContextManager(this.#contextManager);
        this.#agents.setApiBaseUrl(`http://127.0.0.1:${env.server.api.port}/rest/v2`);

        await this.#users.initialize();
        await this.#workspaceManager.initialize(); // This initializes dotfileService
        await this.#contextManager.initialize();
        await this.#roles.initialize();
        await this.#agents.initialize();

        // Let workspace hooks call the agent() helper.
        this.#workspaceManager.hookService?.setAgents(this.#agents);

        // Voice (STT/TTS via OpenAI-compatible local servers) — enabled per
        // side by configured base URLs; status endpoint reports availability.
        if (env.voice.stt.baseUrl || env.voice.tts.baseUrl) {
            this.#voice = new Voice({
                stt: env.voice.stt.baseUrl ? env.voice.stt : null,
                tts: env.voice.tts.baseUrl ? env.voice.tts : null,
                logger: createLogger('voice'),
            });
        }

        // Messaging (Slack/WhatsApp/console) — env→config translation happens
        // here; the service itself is pure DI (embedd pattern). Real adapters
        // activate only when their tokens are configured.
        if (env.messaging.enabled) {
            const messagingLogger = createLogger('messaging');
            const bindingsStore = jim.createIndex('messaging');
            // canvas = in-app (websocket -> UI notifications area); the transport
            // layer late-binds its broadcast function once websockets are up.
            const adapters = [
                new ConsoleAdapter({ logger: messagingLogger }),
                new CanvasAdapter({ logger: messagingLogger }),
                // Outbound webhook (Slack/Teams incoming-webhook compatible);
                // credential-free — the bound recipient IS the target URL.
                new WebhookAdapter({ logger: messagingLogger }),
            ];
            if (env.messaging.slack.botToken) {
                adapters.push(new SlackAdapter({
                    botToken: env.messaging.slack.botToken,
                    appToken: env.messaging.slack.appToken,
                    logger: messagingLogger,
                }));
            }
            if (env.messaging.whatsapp.accessToken && env.messaging.whatsapp.phoneNumberId) {
                adapters.push(new WhatsAppAdapter({
                    accessToken: env.messaging.whatsapp.accessToken,
                    phoneNumberId: env.messaging.whatsapp.phoneNumberId,
                    logger: messagingLogger,
                }));
            }
            this.#messaging = new Messaging({
                adapters,
                bindingsStore,
                logger: messagingLogger,
            });
            this.#workspaceManager.hookService?.setMessaging(this.#messaging);

            // Inbound chat: channel peer -> bound agent -> reply.
            this.#chatRouter = new ChatRouter({
                store: bindingsStore,
                messaging: this.#messaging,
                promptAgent: (userId, agentId, text, options) =>
                    this.#agents.prompt(userId, agentId, text, options),
                logger: messagingLogger,
            });
        }

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
            await this.#closeRealtimeConnections();
            await this.#apiServer.close();
            this.#apiServer = null;
        }
        if (this.#embedd) {
            try { await this.#embedd.stop(); } catch (err) { logger.warn({ err }, 'embedd stop failed'); }
        }
        if (this.#messaging) {
            try { await this.#messaging.stop(); } catch (err) { logger.warn({ err }, 'messaging stop failed'); }
        }
        return this;
    }

    get embedd() { return this.#embedd; }
    get messaging() { return this.#messaging; }
    get voice() { return this.#voice; }

    async #closeRealtimeConnections() {
        const io = this.#apiServer?.io;
        if (!io) return;

        logger.info('Closing realtime connections');
        try {
            io.disconnectSockets(true);
        } catch (error) {
            logger.warn({ err: error }, 'Failed to disconnect realtime sockets');
        }

        await Promise.race([
            new Promise((resolve, reject) => {
                try {
                    io.close((error) => error ? reject(error) : resolve());
                } catch (error) {
                    reject(error);
                }
            }),
            new Promise((resolve) => setTimeout(resolve, 3000)),
        ]).catch((error) => {
            logger.warn({ err: error }, 'Realtime server close failed');
        });
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
