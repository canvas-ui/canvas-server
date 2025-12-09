'use strict';

// Utils
import path from 'path';
import EventEmitter from 'eventemitter2';
import { spawn } from 'child_process';

// MCP SDK
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';

// Logging
import { createLogger } from '../../utils/log.js';
const logger = createLogger('agent-manager:agent');

// Includes
import Db from '../../services/synapsd/src/index.js';

// LLM Connectors
import { AnthropicConnector, OpenAIConnector, OllamaConnector } from './lib/connectors/index.js';

// Constants
import {
    AGENT_STATUS_CODES,
    AGENT_DIRECTORIES,
} from './index.js';

/**
 * Canvas Agent
 *
 * An agent that can interact with LLMs through various connectors and expose
 * its memory and capabilities through MCP (Model Context Protocol).
 *
 * Features:
 * - LLM connectors for Anthropic, OpenAI, Ollama
 * - SynapsD database for memory storage
 * - MCP server for exposing memory and tools
 * - MCP client for connecting to external servers
 */
class Agent extends EventEmitter {

    // Core configuration
    #rootPath;
    #configStore;

    // Runtime state
    #status = AGENT_STATUS_CODES.INACTIVE;
    #db = null;
    #mcpServer = null;
    #mcpClients = new Map(); // Map of MCP client connections
    #llmConnector = null;
    #eventForwardHandlers = null;

    /**
     * Create a new Agent instance.
     * @param {Object} options - Initialization options
     * @param {string} options.rootPath - Absolute path to the agent root directory
     * @param {Conf} options.configStore - Initialized Conf instance for this agent
     * @param {object} [options.eventEmitterOptions] - Options for EventEmitter2
     */
    constructor(options = {}) {
        super(options.eventEmitterOptions);

        if (!options.rootPath) throw new Error('Agent rootPath is required');
        if (!options.configStore) throw new Error('Config store (Conf instance) is required');

        this.#rootPath = options.rootPath;
        this.#configStore = options.configStore;

        // Initialize status from config if available and valid
        const persistedStatus = this.#configStore?.get('status');
        if (persistedStatus && Object.values(AGENT_STATUS_CODES).includes(persistedStatus)) {
            if ([AGENT_STATUS_CODES.ACTIVE, AGENT_STATUS_CODES.INACTIVE, AGENT_STATUS_CODES.ERROR].includes(persistedStatus)) {
                 this.#status = persistedStatus;
            }
        }

        logger.debug(`Agent instance created for ID: ${this.id}, rootPath: ${this.rootPath}, Initial Status: ${this.#status}`);
    }

    /**
     * Getters & Setters
     */

    // Core Configuration & Path Getters
    get config() { return this.#configStore?.store || {}; }
    get path() { return this.#rootPath; }
    get rootPath() { return this.#rootPath; }
    get configPath() { return this.#configStore?.path; }

    // Persisted Configuration Getters
    get id() { return this.#configStore?.get('id'); }
    get name() { return this.#configStore?.get('name'); }
    get label() { return this.#configStore?.get('label', this.name || this.id); }
    get description() { return this.#configStore?.get('description', `Canvas Agent for ${this.name || this.id}`); }
    get color() { return this.#configStore?.get('color'); }
    get type() { return this.#configStore?.get('type', 'agent'); }
    get owner() { return this.#configStore?.get('owner'); }
    get llmProvider() { return this.#configStore?.get('llmProvider', 'anthropic'); }
    get model() { return this.#configStore?.get('model', 'claude-3-5-sonnet-20241022'); }
    get createdAt() { return this.#configStore?.get('createdAt'); }
    get updatedAt() { return this.#configStore?.get('updatedAt'); }
    get metadata() { return this.#configStore?.get('metadata', {}); }
    get agentConfig() { return this.#configStore?.get('config', {}); }

    // LLM Configuration Getters
    get systemPrompt() { return this.agentConfig?.prompts?.system || ''; }
    get llmConfig() {
        const provider = this.llmProvider;
        return this.agentConfig?.connectors?.[provider] || {};
    }

    // Runtime Status Getters & Setters
    get status() { return this.#status; }
    get isConfigLoaded() { return !!this.#configStore; }
    get isActive() { return this.#status === AGENT_STATUS_CODES.ACTIVE; }

    setStatus(status) {
        if (!Object.values(AGENT_STATUS_CODES).includes(status)) {
            logger.debug(`Invalid status value provided to setStatus: ${status} for agent ${this.id}`);
            return false;
        }
        if (this.#status !== status) {
            this.#status = status;
            logger.debug(`Agent ${this.id} status changed to: ${status}`);
            this.emit('status.changed', { id: this.id, status: this.#status });
        }
        return true;
    }

    // Internal Resource Getters
    get db() {
        if (!this.#db) {
            throw new Error(`Database not initialized for agent ${this.id}`);
        }
        return this.#db;
    }

    get mcpServer() {
        if (!this.#mcpServer) {
            throw new Error(`MCP Server not initialized for agent ${this.id}`);
        }
        return this.#mcpServer;
    }

    get llmConnector() {
        if (!this.#llmConnector) {
            throw new Error(`LLM Connector not initialized for agent ${this.id}`);
        }
        return this.#llmConnector;
    }

    /**
     * Agent Lifecycle Controls
     */

    /**
     * Start the agent: Initialize DB, MCP server, LLM connector, and MCP clients.
     * @returns {Promise<Agent>} The started agent instance
     */
    async start() {
        if (this.isActive) {
            logger.debug(`Agent "${this.id}" is already active.`);
            return this;
        }
        if (this.#status === AGENT_STATUS_CODES.ERROR) {
            console.warn(`Agent "${this.id}" is in an error state. Cannot start.`);
            throw new Error(`Agent "${this.id}" is in an error state and cannot be started.`);
        }

        logger.debug(`Starting agent "${this.id}"...`);
        try {
            await this.#initializeDatabase();
            await this.#initializeLLMConnector();
            await this.#initializeMCPServer();
            await this.#initializeMCPClients();

            this.setStatus(AGENT_STATUS_CODES.ACTIVE);
            this.emit('afterStart', { id: this.id });
            logger.debug(`Agent "${this.id}" started successfully.`);
            return this;
        } catch (err) {
            console.error(`Failed to start agent "${this.id}": ${err.message}`);
            await this.#shutdownResources();
            this.setStatus(AGENT_STATUS_CODES.ERROR);
            this.emit('startFailed', { id: this.id, error: err.message });
            throw err;
        }
    }

    /**
     * Stop the agent: Shutdown all resources.
     * @returns {Promise<boolean>} True if stopped successfully
     */
    async stop() {
        if (this.#status === AGENT_STATUS_CODES.INACTIVE) {
            logger.debug(`Agent "${this.id}" is already inactive.`);
            return true;
        }

        logger.debug(`Stopping agent "${this.id}"...`);
        try {
            await this.#shutdownResources();
            const previousStatus = this.#status;
            this.setStatus(AGENT_STATUS_CODES.INACTIVE);
            this.emit('afterStop', { id: this.id, previousStatus });
            logger.debug(`Agent "${this.id}" stopped successfully.`);
            return true;
        } catch (err) {
            console.error(`Error stopping agent "${this.id}": ${err.message}`);
            this.setStatus(AGENT_STATUS_CODES.INACTIVE);
            this.emit('stopFailed', { id: this.id, error: err.message });
            return false;
        }
    }

    /**
     * Chat Methods
     */

    /**
     * Send a message to the agent and get a response
     * @param {string} message - The message to send
     * @param {Object} options - Chat options
     * @param {Array} [options.context] - Additional context messages
     * @param {Object} [options.mcpContext] - MCP context to include
     * @returns {Promise<Object>} The agent's response
     */
    async chat(message, options = {}) {
        if (!this.isActive) {
            throw new Error('Agent is not active');
        }

        try {
            // Prepare context messages (memory disabled for now)
            let contextMessages = options.context || [];
            /*
            if (options.mcpContext) {
                try {
                    // Query agent memory for relevant context (DISABLED TEMPORARILY)
                    const memoryResults = await this.queryMemory(message);
                    if (Array.isArray(memoryResults) && memoryResults.length > 0) {
                        contextMessages.unshift({
                            role: 'system',
                            content: `Relevant memory: ${JSON.stringify(memoryResults)}`
                        });
                    }
                } catch (memErr) {
                    logger.debug(`Memory query error (ignored): ${memErr.message}`);
                }
            }
            */

            // Build the full conversation with system prompt
            const messages = [];

            // Add system prompt if available
            if (this.systemPrompt) {
                messages.push({
                    role: 'system',
                    content: this.systemPrompt
                });
            }

            // Add context messages
            messages.push(...contextMessages);

            // Add user message
            messages.push({
                role: 'user',
                content: message
            });

            // Prepare LLM options with agent configuration
            const llmOptions = {
                model: this.model,
                maxTokens: options.maxTokens || this.llmConfig.maxTokens || 4096,
                temperature: options.temperature || this.llmConfig.temperature || 0.7,
                topP: options.topP || this.llmConfig.topP || 1.0,
                frequencyPenalty: options.frequencyPenalty || this.llmConfig.frequencyPenalty || 0.0,
                presencePenalty: options.presencePenalty || this.llmConfig.presencePenalty || 0.0
            };

            // Add Ollama-specific options
            if (this.llmProvider === 'ollama') {
                llmOptions.numCtx = options.numCtx || this.llmConfig.numCtx || 4096;
            }

            // Send to LLM
            const response = await this.#llmConnector.chat(messages, llmOptions);

            // Check if we got a valid response
            if (!response || typeof response !== 'object') {
                throw new Error(`Invalid response from LLM connector (${this.llmProvider}): ${response}`);
            }

            if (!response.content) {
                throw new Error(`LLM connector (${this.llmProvider}) returned response without content: ${JSON.stringify(response)}`);
            }

            // Try to store the conversation in memory
            try {
                await this.storeMemory({
                    type: 'conversation',
                    user_message: message,
                    agent_response: response?.content || '',
                    timestamp: new Date().toISOString(),
                    metadata: {
                        model: this.model,
                        provider: this.llmProvider
                    }
                });
            } catch (storeErr) {
                logger.debug(`storeMemory failed (ignored): ${storeErr.message}`);
            }

            this.emit('chat.message', {
                agentId: this.id,
                message,
                response: response?.content || '',
                timestamp: new Date().toISOString()
            });

            return {
                content: response?.content || '',
                metadata: {
                    model: this.model,
                    provider: this.llmProvider,
                    timestamp: new Date().toISOString(),
                    response: response || null
                }
            };
        } catch (err) {
            console.error(`Chat error for agent ${this.id}: ${err.message}`);
            throw new Error(`Chat failed: ${err.message}`);
        }
    }

    /**
     * Chat with streaming support
     * @param {string} message - User message
     * @param {Object} options - Chat options
     * @param {Array} [options.context] - Additional context messages
     * @param {Object} [options.mcpContext] - MCP context to include
     * @param {Function} [options.onChunk] - Callback for streaming chunks
     * @returns {Promise<Object>} The agent's response
     */
    async chatStream(message, options = {}) {
        if (!this.isActive) {
            throw new Error('Agent is not active');
        }

        try {
            const { onChunk } = options;

            // Prepare context messages (memory disabled for now)
            let contextMessages = options.context || [];
            /*
            if (options.mcpContext) {
                try {
                    // Query agent memory for relevant context (DISABLED TEMPORARILY)
                    const memoryResults = await this.queryMemory(message);
                    if (Array.isArray(memoryResults) && memoryResults.length > 0) {
                        contextMessages.unshift({
                            role: 'system',
                            content: `Relevant memory: ${JSON.stringify(memoryResults)}`
                        });
                    }
                } catch (memErr) {
                    logger.debug(`Memory query error (ignored): ${memErr.message}`);
                }
            }
            */

            // Build the full conversation with system prompt
            const messages = [];

            // Add system prompt if available
            if (this.systemPrompt) {
                messages.push({
                    role: 'system',
                    content: this.systemPrompt
                });
            }

            // Add context messages
            messages.push(...contextMessages);

            // Add user message
            messages.push({
                role: 'user',
                content: message
            });

            // Prepare LLM options with agent configuration
            const llmOptions = {
                model: this.model,
                maxTokens: options.maxTokens || this.llmConfig.maxTokens || 4096,
                temperature: options.temperature || this.llmConfig.temperature || 0.7,
                topP: options.topP || this.llmConfig.topP || 1.0,
                frequencyPenalty: options.frequencyPenalty || this.llmConfig.frequencyPenalty || 0.0,
                presencePenalty: options.presencePenalty || this.llmConfig.presencePenalty || 0.0
            };

            // Add Ollama-specific options
            if (this.llmProvider === 'ollama') {
                llmOptions.numCtx = options.numCtx || this.llmConfig.numCtx || 4096;
            }

            // Send to LLM with streaming
            const response = await this.#llmConnector.chatStream(messages, llmOptions, onChunk);

            // Check if we got a valid response
            if (!response || typeof response !== 'object') {
                throw new Error(`Invalid response from LLM connector (${this.llmProvider}): ${response}`);
            }

            if (!response.content) {
                throw new Error(`LLM connector (${this.llmProvider}) returned response without content: ${JSON.stringify(response)}`);
            }

            // Try to store the conversation in memory
            try {
                await this.storeMemory({
                    type: 'conversation',
                    user_message: message,
                    agent_response: response?.content || '',
                    timestamp: new Date().toISOString(),
                    metadata: {
                        model: this.model,
                        provider: this.llmProvider
                    }
                });
            } catch (storeErr) {
                logger.debug(`storeMemory failed (ignored): ${storeErr.message}`);
            }

            this.emit('chat.message', {
                agentId: this.id,
                message,
                response: response?.content || '',
                timestamp: new Date().toISOString()
            });

            return {
                content: response?.content || '',
                metadata: {
                    model: this.model,
                    provider: this.llmProvider,
                    timestamp: new Date().toISOString(),
                    response: response || null
                }
            };
        } catch (err) {
            console.error(`Chat stream error for agent ${this.id}: ${err.message}`);
            throw new Error(`Chat stream failed: ${err.message}`);
        }
    }

    /**
     * Memory Methods
     */

    /**
     * Store data in agent memory
     * @param {Object} data - Data to store
     * @param {string} [contextSpec='/'] - Context specification
     * @returns {Promise<Object>} Storage result
     */
    async storeMemory(data, contextSpec = '/') {
        if (!this.isActive) {
            throw new Error('Agent is not active');
        }

        // Wrap the data in the proper SynapsD document format
        const document = {
            schema: 'data/abstraction/document',
            schemaVersion: '2.1',
            data: {
                ...data,
                id: data.id || `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                stored_at: new Date().toISOString(),
                agent_id: this.id
            },
            metadata: {
                contentType: 'application/json',
                agent: {
                    id: this.id,
                    name: this.name,
                    label: this.label
                }
            }
        };

        return await this.db.insertDocument(document, contextSpec, [], true);
    }

    /**
     * Query agent memory
     * @param {string} query - Search query
     * @param {string} [contextSpec='/'] - Context specification
     * @param {Object} [options={}] - Query options
     * @returns {Promise<Array>} Query results
     */
    async queryMemory(query, contextSpec = '/', options = {}) {
        if (!this.isActive) {
            throw new Error('Agent is not active');
        }

        try {
            // Use full-text search if available
            const results = await this.db.ftsQuery(query, [], [], [], false);
            // Extract data from wrapped documents, handle null/undefined results
            if (!results || !Array.isArray(results)) {
                return [];
            }
            return results.map(doc => doc.data || doc);
        } catch (err) {
            logger.debug(`Memory query failed, falling back to document search: ${err.message}`);
            // Fallback to document search
            const docs = await this.db.findDocuments(contextSpec, [], [], { parse: true });
            // Extract data from wrapped documents, handle null/undefined results
            if (!docs || !Array.isArray(docs)) {
                return [];
            }
            return docs.map(doc => doc.data || doc);
        }
    }

    /**
     * Clear agent memory
     * @returns {Promise<boolean>} Success status
     */
    async clearMemory() {
        if (!this.isActive) {
            throw new Error('Agent is not active');
        }

        return await this.db.clearAsync();
    }

    /**
     * MCP Methods
     */

    /**
     * Get available MCP tools
     * @returns {Promise<Array>} Available tools
     */
    async getMCPTools() {
        if (!this.isActive) {
            throw new Error('Agent is not active');
        }

        const tools = [];

        // Add tools from connected MCP clients
        for (const [name, client] of this.#mcpClients) {
            try {
                const clientTools = await client.listTools();
                tools.push(...clientTools.tools.map(tool => ({
                    ...tool,
                    source: name
                })));
            } catch (err) {
                logger.debug(`Failed to list tools from MCP client ${name}: ${err.message}`);
            }
        }

        return tools;
    }

    /**
     * Call an MCP tool
     * @param {string} toolName - Name of the tool to call
     * @param {Object} arguments_ - Arguments for the tool
     * @param {string} [source] - Specific MCP client source
     * @returns {Promise<Object>} Tool result
     */
    async callMCPTool(toolName, arguments_, source = null) {
        if (!this.isActive) {
            throw new Error('Agent is not active');
        }

        // If source is specified, use that client
        if (source && this.#mcpClients.has(source)) {
            const client = this.#mcpClients.get(source);
            return await client.callTool({ name: toolName, arguments: arguments_ });
        }

        // Otherwise, try all clients until one works
        for (const [name, client] of this.#mcpClients) {
            try {
                const tools = await client.listTools();
                const tool = tools.tools.find(t => t.name === toolName);
                if (tool) {
                    return await client.callTool({ name: toolName, arguments: arguments_ });
                }
            } catch (err) {
                logger.debug(`Tool ${toolName} not found in MCP client ${name}: ${err.message}`);
                continue;
            }
        }

        throw new Error(`Tool ${toolName} not found in any connected MCP client`);
    }

    /**
     * Configuration Methods
     */

    /**
     * Update agent configuration
     * @param {string} key - Configuration key
     * @param {*} value - Configuration value
     * @returns {Promise<boolean>} Success status
     */
    async setConfigKey(key, value) {
        const allowedKeys = [
            'label',
            'description',
            'color',
            'llmProvider',
            'model',
            'metadata',
            'config'
        ];

        if (!allowedKeys.includes(key)) {
            console.warn(`Attempted to set disallowed config key: "${key}" for agent ${this.id}.`);
            return false;
        }

        return this.#updateConfig(key, value);
    }

    /**
     * Output Methods
     */

    /**
     * Convert the agent's current state to a plain JSON object.
     * @returns {Object} JSON object representing agent
     */
    toJSON() {
        return {
            ...this.config,
            id: this.id,
            label: this.label,
            description: this.description,
            color: this.color,
            type: this.type,
            owner: this.owner,
            llmProvider: this.llmProvider,
            model: this.model,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            metadata: this.metadata,
            rootPath: this.rootPath,
            configPath: this.configPath,
            status: this.status,
            isActive: this.isActive,
            name: this.name,
        };
    }

    /**
     * Private Methods
     */

    /**
     * Initialize the SynapsD database
     * @private
     */
    async #initializeDatabase() {
        if (this.#db) {
            logger.debug(`Database already initialized for agent "${this.id}"`);
            if (this.#db.status !== 'running' && this.#db.status !== 'starting') {
                logger.debug(`DB for agent "${this.id}" exists but not running. Attempting to start.`);
                await this.#db.start();
            }
            return;
        }

        try {
            const dbDirName = AGENT_DIRECTORIES.db || 'db';
            const dbPath = path.join(this.rootPath, dbDirName);
            logger.debug(`Initializing database for agent "${this.id}" at ${dbPath}`);

            this.#db = new Db({
                path: dbPath,
            });

            await this.#db.start();
            logger.debug(`Database started for agent "${this.id}".`);

            // Set up event forwarding from database
            this.#setupDatabaseEventForwarding();

        } catch (err) {
            logger.debug(`Error during database initialization for agent "${this.id}": ${err.message}`);
            this.#db = null;
            throw err;
        }
    }

    /**
     * Initialize the LLM connector
     * @private
     */
    async #initializeLLMConnector() {
        try {
            const provider = this.llmProvider;
            const connectorConfig = this.agentConfig.connectors?.[provider] || {};

            logger.debug(`Initializing LLM connector for agent "${this.id}" with provider: ${provider}`);

            switch (provider) {
                case 'anthropic':
                    this.#llmConnector = new AnthropicConnector({
                        apiKey: connectorConfig.apiKey || process.env.ANTHROPIC_API_KEY,
                        model: this.model,
                        maxTokens: connectorConfig.maxTokens || 4096
                    });
                    break;

                case 'openai':
                    this.#llmConnector = new OpenAIConnector({
                        apiKey: connectorConfig.apiKey || process.env.OPENAI_API_KEY,
                        model: this.model,
                        maxTokens: connectorConfig.maxTokens || 4096
                    });
                    break;

                case 'ollama':
                    this.#llmConnector = new OllamaConnector({
                        host: connectorConfig.host || 'http://localhost:11434',
                        model: this.model
                    });
                    break;

                default:
                    throw new Error(`Unsupported LLM provider: ${provider}`);
            }

            // Test the connection
            const isAvailable = await this.#llmConnector.isAvailable();
            if (!isAvailable) {
                throw new Error(`LLM connector ${provider} is not available`);
            }

            logger.debug(`LLM connector initialized for agent "${this.id}"`);
        } catch (err) {
            logger.debug(`Error initializing LLM connector for agent "${this.id}": ${err.message}`);
            throw err;
        }
    }

    /**
     * Initialize the MCP server
     * @private
     */
    async #initializeMCPServer() {
        try {
            logger.debug(`Initializing MCP server for agent "${this.id}"`);

            this.#mcpServer = new McpServer({
                name: `canvas-agent-${this.id}`,
                version: '1.0.0'
            });

            // Register memory tools
            this.#registerMemoryTools();

            // Register agent info tools
            this.#registerAgentTools();

            logger.debug(`MCP server initialized for agent "${this.id}"`);
        } catch (err) {
            logger.debug(`Error initializing MCP server for agent "${this.id}": ${err.message}`);
            throw err;
        }
    }

    /**
     * Initialize MCP clients for external servers
     * @private
     */
    async #initializeMCPClients() {
        try {
            const mcpConfig = this.agentConfig.mcp || { servers: [] };
            logger.debug(`Initializing ${mcpConfig.servers.length} MCP clients for agent "${this.id}"`);

            for (const serverConfig of mcpConfig.servers) {
                await this.#connectMCPClient(serverConfig);
            }

            // Always connect to the built-in weather MCP server
            await this.#connectWeatherMCPServer();

            logger.debug(`MCP clients initialized for agent "${this.id}"`);
        } catch (err) {
            logger.debug(`Error initializing MCP clients for agent "${this.id}": ${err.message}`);
            throw err;
        }
    }

    /**
     * Connect to an MCP client
     * @param {Object} serverConfig - Server configuration
     * @private
     */
    async #connectMCPClient(serverConfig) {
        try {
            const client = new Client({
                name: `canvas-agent-${this.id}-client`,
                version: '1.0.0'
            });

            const transport = new StdioClientTransport({
                command: serverConfig.command,
                args: serverConfig.args || []
            });

            await client.connect(transport);
            this.#mcpClients.set(serverConfig.name, client);

            logger.debug(`Connected to MCP server: ${serverConfig.name}`);
        } catch (err) {
            console.error(`Failed to connect to MCP server ${serverConfig.name}: ${err.message}`);
        }
    }

    /**
     * Connect to the built-in weather MCP server
     * @private
     */
    async #connectWeatherMCPServer() {
        try {
            // We'll create this weather server in a separate file
            const weatherServerPath = path.join(process.cwd(), 'src', 'managers', 'agent', 'mcp-servers', 'weather.js');

            const client = new Client({
                name: `canvas-agent-${this.id}-weather-client`,
                version: '1.0.0'
            });

            const transport = new StdioClientTransport({
                command: 'node',
                args: [weatherServerPath]
            });

            await client.connect(transport);
            this.#mcpClients.set('weather', client);

            logger.debug(`Connected to weather MCP server`);
        } catch (err) {
            console.error(`Failed to connect to weather MCP server: ${err.message}`);
        }
    }

    /**
     * Register memory-related MCP tools
     * @private
     */
    #registerMemoryTools() {
        // Store memory tool
        this.#mcpServer.registerTool(
            'store_memory',
            {
                title: 'Store Memory',
                description: 'Store information in agent memory',
                inputSchema: {
                    data: z.object({}).passthrough(),
                    context: z.string().optional().default('/')
                }
            },
            async ({ data, context }) => {
                const result = await this.storeMemory(data, context);
                return {
                    content: [{
                        type: 'text',
                        text: `Stored memory with ID: ${result.id}`
                    }]
                };
            }
        );

        // Query memory tool
        this.#mcpServer.registerTool(
            'query_memory',
            {
                title: 'Query Memory',
                description: 'Search agent memory',
                inputSchema: {
                    query: z.string(),
                    context: z.string().optional().default('/'),
                    limit: z.number().optional().default(10)
                }
            },
            async ({ query, context, limit }) => {
                const results = await this.queryMemory(query, context);
                const limitedResults = results.slice(0, limit);
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(limitedResults, null, 2)
                    }]
                };
            }
        );

        // Clear memory tool
        this.#mcpServer.registerTool(
            'clear_memory',
            {
                title: 'Clear Memory',
                description: 'Clear all agent memory',
                inputSchema: {}
            },
            async () => {
                const success = await this.clearMemory();
                return {
                    content: [{
                        type: 'text',
                        text: success ? 'Memory cleared successfully' : 'Failed to clear memory'
                    }]
                };
            }
        );
    }

    /**
     * Register agent information tools
     * @private
     */
    #registerAgentTools() {

        // Get agent info tool
        this.#mcpServer.registerTool(
            'get_agent_info',
            {
                title: 'Get Agent Info',
                description: 'Get information about this agent',
                inputSchema: {}
            },
            async () => {
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(this.toJSON(), null, 2)
                    }]
                };
            }
        );

        // List MCP tools
        this.#mcpServer.registerTool(
            'list_mcp_tools',
            {
                title: 'List MCP Tools',
                description: 'List all available MCP tools',
                inputSchema: {}
            },
            async () => {
                const tools = await this.getMCPTools();
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify(tools, null, 2)
                    }]
                };
            }
        );
    }

    /**
     * Setup event forwarding from database
     * @private
     */
    #setupDatabaseEventForwarding() {
        if (!this.#db) return;

        logger.debug(`Setting up database event forwarding for agent "${this.id}"`);

        const forward = (eventName, payload) => {
            const dotEvent = eventName.replace(/:/g, '.');
            this.emit(dotEvent, {
                agentId: this.id,
                agentName: this.label,
                ...payload
            });
        };

        const dbHandler = (eventName, payload) => forward(eventName, payload);
        this.#db.onAny(dbHandler);

        this.#eventForwardHandlers = { dbHandler };
        logger.debug(`Database event forwarding setup completed for agent "${this.id}"`);
    }

    /**
     * Clean up event listeners
     * @private
     */
    #cleanupEventForwarding() {
        if (!this.#db || !this.#eventForwardHandlers) return;

        logger.debug(`Cleaning up event forwarding for agent "${this.id}"`);

        this.#db.offAny(this.#eventForwardHandlers.dbHandler);
        this.#eventForwardHandlers = null;

        logger.debug(`Event forwarding cleanup completed for agent "${this.id}"`);
    }

    /**
     * Shutdown all agent resources
     * @private
     */
    async #shutdownResources() {
        logger.debug(`Shutting down resources for agent "${this.id}"...`);

        // Clean up event forwarding
        this.#cleanupEventForwarding();

        // Shutdown MCP clients
        for (const [name, client] of this.#mcpClients) {
            try {
                await client.close();
                logger.debug(`MCP client ${name} closed for agent "${this.id}"`);
            } catch (err) {
                console.error(`Error closing MCP client ${name} for agent "${this.id}": ${err.message}`);
            }
        }
        this.#mcpClients.clear();

        // Shutdown MCP server
        if (this.#mcpServer) {
            try {
                await this.#mcpServer.close();
                logger.debug(`MCP server closed for agent "${this.id}"`);
            } catch (err) {
                console.error(`Error closing MCP server for agent "${this.id}": ${err.message}`);
            } finally {
                this.#mcpServer = null;
            }
        }

        // Shutdown database
        if (this.#db) {
            try {
                await this.#db.shutdown();
                logger.debug(`Database shutdown complete for agent "${this.id}"`);
            } catch (dbErr) {
                console.error(`Error shutting down database for agent "${this.id}": ${dbErr.message}`);
            } finally {
                this.#db = null;
            }
        }

        // Clear LLM connector
        this.#llmConnector = null;

        logger.debug(`Agent "${this.id}" resources shut down attempt complete.`);
    }

    /**
     * Updates a key in the agent's configStore
     * @param {string} key - The configuration key to update
     * @param {*} value - The new value for the key
     * @returns {Promise<boolean>} True if successful, false otherwise
     * @private
     */
    async #updateConfig(key, value) {
        if (!this.#configStore) {
            console.error(`Cannot update config for agent "${this.id}". Config store not available.`);
            return false;
        }
        try {
            const oldValue = this.#configStore.get(key);
            if (oldValue === value) {
                return true;
            }
            this.#configStore.set(key, value);
            this.#configStore.set('updatedAt', new Date().toISOString());
            this.emit(`${key}.changed`, { id: this.id, [key]: value });
            logger.debug(`Agent "${this.id}" config updated: { ${key}: ${value} }. Old value: ${oldValue}`);
            return true;
        } catch (err) {
            console.error(`Failed to update config key "${key}" for agent "${this.id}": ${err.message}`);
            return false;
        }
    }
}

export default Agent;
