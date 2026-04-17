'use strict';

// Utils
import randomcolor from 'randomcolor';
import path from 'path';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';
import EventEmitter from 'eventemitter2';
import Conf from 'conf';
import { generateUUID } from '../../utils/id.js';

// Logging
import { createLogger } from '../../utils/log.js';
const logger = createLogger('agent-manager');

// Includes
import Agent from './Agent.js';

/**
 * Constants
 */

// Default host for local agents
const DEFAULT_HOST = 'canvas.local';

// Agent reference format: [user_identifier]@[host]:[agent_slug][/optional_path...]
const AGENT_CONFIG_FILENAME = 'agent.json';

// Agent directory structure
const AGENT_DIRECTORIES = {
    db: 'db',
    config: 'config',
    data: 'data',
    tmp: 'tmp',
};

const AGENT_STATUS_CODES = {
    AVAILABLE: 'available',   // Agent dir exists, config readable
    NOT_FOUND: 'not_found',   // Agent dir/config not found
    ERROR: 'error',           // Config invalid, FS issues, etc.
    ACTIVE: 'active',         // Agent is loaded and started
    INACTIVE: 'inactive',     // Agent is loaded but not started
    REMOVED: 'removed',       // Marked for removal
    DESTROYED: 'destroyed',   // Agent dir deleted
};

// Default configuration template for a new agent's agent.json
const DEFAULT_AGENT_CONFIG = {
    id: null,                 // Set to 12-char nanoid
    name: null,               // User-defined slug-like name
    owner: null,              // User ID (email)
    type: 'agent',            // "agent"
    label: 'Agent',
    color: null,
    description: '',
    llmProvider: 'anthropic', // Default LLM provider
    model: 'claude-3-5-sonnet-20241022', // Default model
    created: null,
    updated: null,
    config: {
        connectors: {},       // LLM connector configurations
        prompts: {},          // Prompt templates
        tools: {},            // Tool configurations
        mcp: {
            servers: []       // MCP servers to connect to
        }
    }
};

/**
 * Agent Reference Utilities
 */

/**
 * Parse agent reference in format [user_identifier]@[host]:[agent_slug][/optional_path...]
 * @param {string} agentRef - Agent reference string
 * @returns {Object|null} Parsed reference or null if invalid
 */
function parseAgentReference(agentRef) {
    if (!agentRef || typeof agentRef !== 'string') {
        return null;
    }

    const colonIndex = agentRef.indexOf(':');
    if (colonIndex === -1 || colonIndex === agentRef.length - 1) {
        return null;
    }

    const userHostPart = agentRef.substring(0, colonIndex);
    const resourcePart = agentRef.substring(colonIndex + 1);

    const atIndex = userHostPart.lastIndexOf('@');
    if (atIndex === -1 || atIndex === 0 || atIndex === userHostPart.length - 1) {
        return null;
    }

    const userIdentifier = userHostPart.substring(0, atIndex).trim();
    const host = userHostPart.substring(atIndex + 1).trim();

    if (!userIdentifier || !host) {
        return null;
    }

    const [agentSlug, ...optionalPathParts] = resourcePart.split('/');
    const optionalPath = optionalPathParts.length > 0 ? '/' + optionalPathParts.join('/') : '';

    return {
        userIdentifier,
        host,
        agentSlug: agentSlug.trim(),
        path: optionalPath || '',
        full: agentRef,
        isLocal: host === DEFAULT_HOST,
        isRemote: host !== DEFAULT_HOST
    };
}

/**
 * Construct agent reference string
 * @param {string} userIdentifier - User ID, name, or email
 * @param {string} agentSlug - Agent slug/name
 * @param {string} [host=DEFAULT_HOST] - Host (defaults to canvas.local)
 * @param {string} [path=''] - Optional path within agent
 * @returns {string} Agent reference string
 */
function constructAgentReference(userIdentifier, agentSlug, host = DEFAULT_HOST, path = '') {
    if (!userIdentifier || !agentSlug) {
        throw new Error('userIdentifier and agentSlug are required to construct an agent reference.');
    }
    return `${userIdentifier}@${host}:${agentSlug}${path}`;
}

/**
 * Construct agent index key from user ID and agent ID
 * @param {string} userId - User ID
 * @param {string} agentId - Agent ID (12-char nanoid)
 * @returns {string} Index key for internal storage
 */
function constructAgentIndexKey(userId, agentId) {
    return `${userId}/${agentId}`;
}

/**
 * Parse agent index key to extract user ID and agent ID
 * @param {string} indexKey - Index key from storage
 * @returns {Object|null} Parsed {userId, agentId} or null if invalid
 */
function parseAgentIndexKey(indexKey) {
    if (!indexKey || typeof indexKey !== 'string') {
        return null;
    }

    const parts = indexKey.split('/');
    if (parts.length !== 2) {
        return null;
    }

    return {
        userId: parts[0],
        agentId: parts[1]
    };
}

/**
 * Agents Service
 */
class Agents extends EventEmitter {

    #defaultRootPath;   // Default Root path for all user agents managed by this instance
    #indexStore;        // Persistent index of all agents (key: userId/agent.id -> agent data)
    #nameIndex;         // Secondary index for name lookups (key: userId@host:agentName -> agent.id)
    #referenceIndex;    // Tertiary index for full reference lookups
    #users;       // Users service instance for resolving user identifiers

    // Runtime
    #agents = new Map(); // Cache for loaded Agent instances (key: agent.id -> Agent)
    #initialized = false;

    /**
     * Constructor
     * @param {Object} options - Configuration options
     * @param {string} options.defaultRootPath - Root path where user agent directories are stored
     * @param {Object} options.indexStore - Initialized Conf instance for the agent index
     * @param {Object} options.users - Initialized Users service instance
     * @param {Object} [options.eventEmitterOptions] - Options for EventEmitter2
     */
    constructor(options = {}) {
        super(options.eventEmitterOptions || {});

        if (!options.defaultRootPath) {
            throw new Error('Agents defaultRootPath is required for Agents service');
        }

        if (!options.indexStore) {
            throw new Error('Index store is required for Agents service');
        }

        if (!options.users) {
            throw new Error('Users service is required for Agents service');
        }

        this.#defaultRootPath = path.resolve(options.defaultRootPath);
        this.#indexStore = options.indexStore;
        this.#users = options.users;
        this.#nameIndex = new Map();
        this.#referenceIndex = new Map();

        logger.debug(`Initializing Agents service with default rootPath: ${this.#defaultRootPath}`);
    }

    /**
     * Getters
     */
    get users() { return this.#users; }

    /**
     * Private helper to construct agent index key
     */
    #constructAgentIndexKey(userId, agentId) {
        return constructAgentIndexKey(userId, agentId);
    }

    /**
     * Private helper to parse agent index key
     */
    #parseAgentIndexKey(indexKey) {
        return parseAgentIndexKey(indexKey);
    }

    /**
     * Parse agent reference string
     */
    parseAgentReference(agentRef) {
        return parseAgentReference(agentRef);
    }

    /**
     * Construct agent reference string
     */
    constructAgentReference(userIdentifier, agentSlug, host = DEFAULT_HOST, path = '') {
        return constructAgentReference(userIdentifier, agentSlug, host, path);
    }

    /**
     * Initialization
     */
    async initialize() {
        if (this.#initialized) { return true; }

        // Rebuild name and reference indexes from existing agents
        await this.#rebuildIndexes();

        // Scan the index for all agents
        await this.#scanIndexedAgents();

        this.#initialized = true;
        logger.debug(`Agents service initialized with ${this.#indexStore.size} agent(s) in index`);

        return this;
    }

    /**
     * Public API - Agent Lifecycle & Management
     */

    /**
     * Validate agent creation data
     * @param {Object} data - Agent data to validate
     * @throws {Error} If validation fails
     */
    #validateAgentData(data) {
        if (!data) {
            throw new Error('Agent data is required');
        }

        // Name validation
        if (!data.name || typeof data.name !== 'string') {
            throw new Error('Agent name is required and must be a string');
        }

        if (data.name.length < 3 || data.name.length > 39) {
            throw new Error('Agent name must be 3-39 characters long');
        }

        if (!/^[A-Za-z0-9_-]+$/.test(data.name)) {
            throw new Error('Agent name can only contain letters, numbers, underscores, and hyphens');
        }

        // Color validation (if provided)
        if (data.color && !/^#[0-9A-Fa-f]{3,6}$/.test(data.color)) {
            throw new Error('Color must be a valid hex color (e.g., #ff0000)');
        }

        // LLM Provider validation (if provided)
        if (data.llmProvider && !['anthropic', 'openai', 'ollama'].includes(data.llmProvider)) {
            throw new Error('LLM provider must be one of: anthropic, openai, ollama');
        }

        // Type validation for objects (if provided)
        if (data.connectors && typeof data.connectors !== 'object') {
            throw new Error('Connectors must be an object');
        }

        if (data.prompts && typeof data.prompts !== 'object') {
            throw new Error('Prompts must be an object');
        }

        if (data.tools && typeof data.tools !== 'object') {
            throw new Error('Tools must be an object');
        }

        if (data.mcp && typeof data.mcp !== 'object') {
            throw new Error('MCP configuration must be an object');
        }

        if (data.metadata && typeof data.metadata !== 'object') {
            throw new Error('Metadata must be an object');
        }
    }

    /**
     * Creates a new agent directory, config file, and adds it to the index.
     * @param {string} userId - The user ID for key prefix
     * @param {string} agentName - The desired agent name (slug-like identifier)
     * @param {Object} options - Additional options for agent config
     * @returns {Promise<Object>} The index entry of the newly created agent
     */
    async create(userId, agentName, options = {}) {
        if (!this.#initialized) throw new Error('Agents service not initialized');
        if (!userId) throw new Error('userId required to create an agent.');
        if (!agentName) throw new Error('Agent name required to create an agent.');

        // Validate the agent data
        const agentData = { name: agentName, ...options };
        this.#validateAgentData(agentData);

        // Resolve userId
        const ownerId = await this.#users.resolveId(userId);
        if (!ownerId) {
            throw new Error(`Could not resolve user identifier: "${userId}"`);
        }

        // Sanitize the agent name (display slug); on-disk dir is always lowercase
        agentName = this.#sanitizeAgentName(agentName);
        const dirSlug = agentName.toLowerCase();
        const host = options.host || DEFAULT_HOST;

        // Generate unique agent ID
        const agentId = options.id || generateUUID();

        // Check if agent name already exists for this user on this host
        const referenceKey = this.constructAgentReference(userId, dirSlug, host);
        if (this.#referenceIndex.has(referenceKey)) {
            throw new Error(`Agent with name "${agentName}" already exists for user ${userId} on host ${host}.`);
        }

        // Determine agent directory path
        const agentDir = options.agentPath ||
                        (options.rootPath ? path.join(options.rootPath, dirSlug) :
                        path.join(this.#defaultRootPath, ownerId, dirSlug));
        logger.debug(`Using agent path: ${agentDir} for agent ${agentId}`);

        // Validate and create agent
        if (existsSync(agentDir)) {
            console.warn(`Agent directory "${agentDir}" already exists.`);
        }

        try {
            await fsPromises.mkdir(agentDir, { recursive: true });
            await this.#createAgentSubdirectories(agentDir);
            logger.debug(`Created agent directory and subdirectories: ${agentDir}`);
        } catch (err) {
            throw new Error(`Failed to create agent directory: ${err.message}`);
        }

        // Create agent configuration
        const agentConfigPath = path.join(agentDir, AGENT_CONFIG_FILENAME);
        const configData = {
            ...DEFAULT_AGENT_CONFIG,
            id: agentId,
            name: agentName,
            label: options.label || agentName,
            description: options.description || '',
            owner: ownerId,
            color: options.color || this.getRandomColor(),
            llmProvider: options.llmProvider || 'anthropic',
            model: options.model || 'claude-3-5-sonnet-20241022',
            host: host,
            rootPath: agentDir,
            configPath: agentConfigPath,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            metadata: options.metadata || {},
            config: {
                connectors: options.connectors || {},
                prompts: options.prompts || {},
                tools: options.tools || {},
                mcp: options.mcp || { servers: [] }
            }
        };

        new Conf({
            configName: path.basename(agentConfigPath, '.json'),
            cwd: agentDir,
            accessPropertiesByDotNotation: false
        }).store = configData;

        logger.debug(`Created agent config file: ${agentConfigPath}`);

        // Create index entry
        const indexEntry = {
            ...configData,
            status: AGENT_STATUS_CODES.AVAILABLE,
            lastAccessed: null
        };
        const indexKey = this.#constructAgentIndexKey(ownerId, agentId);

        this.#indexStore.set(indexKey, indexEntry);

        // Add to reference index for lookups
        this.#referenceIndex.set(referenceKey, agentId);

        // Add to name index (slug normalized to match lookups and on-disk dir)
        const nameKey = `${ownerId}@${host}:${dirSlug}`;
        this.#nameIndex.set(nameKey, agentId);

        // Add reference field to the index entry
        indexEntry.reference = referenceKey;

        this.emit('agent.created', { userId: ownerId, agentId, agentName, agent: indexEntry });
        logger.debug(`Agent created: ${agentId} (name: ${agentName}) for user ${ownerId} on host ${host}`);
        return indexEntry;
    }

    /**
     * Opens an agent, loading it into memory if not already loaded.
     * @param {string} userId - The owner identifier
     * @param {string} agentIdentifier - The agent ID or name
     * @param {string} requestingUserId - The ULID of the user making the request
     * @returns {Promise<Agent|null>} The loaded Agent instance
     */
    async open(userId, agentIdentifier, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');
        if (!userId || !agentIdentifier) throw new Error('userId and agentIdentifier required');

        const ownerId = await this.#users.resolveId(userId);
        if (!ownerId) return null;

        requestingUserId = requestingUserId || ownerId;

        // Try to parse as agent reference first
        const parsedRef = this.parseAgentReference(agentIdentifier);
        let agentId;

        if (parsedRef) {
            const refKey = constructAgentReference(
                parsedRef.userIdentifier,
                parsedRef.agentSlug.toLowerCase(),
                parsedRef.host
            );
            agentId = this.#referenceIndex.get(refKey.split('/')[0]);
            if (!agentId) return null;
        } else {
            agentId = await this.#resolveAgentIdFromIdentifier(ownerId, agentIdentifier);
            if (!agentId) return null;
        }

        // Return from cache if available
        if (this.#agents.has(agentId)) {
            const cachedAgent = this.#agents.get(agentId);
            if (cachedAgent.owner !== requestingUserId) {
                return null;
            }
            return cachedAgent;
        }

        // Load from index
        const indexKey = this.#constructAgentIndexKey(ownerId, agentId);
        const entry = this.#indexStore.get(indexKey);

        if (!this.#validateAgentEntryForOpen(entry, agentId, requestingUserId)) {
            return null;
        }

        try {
            const conf = new Conf({
                configName: path.basename(entry.configPath, '.json'),
                cwd: path.dirname(entry.configPath)
            });

            const agent = new Agent({
                rootPath: entry.rootPath,
                configStore: conf,
                eventEmitterOptions: {
                    wildcard: true,
                    delimiter: '.',
                    newListener: false,
                    maxListeners: 50
                }
            });

            this.#agents.set(agentId, agent);
            this.#updateAgentIndexEntry(indexKey, { lastAccessed: new Date().toISOString() });
            return agent;
        } catch (err) {
            console.error(`Failed to load agent ${agentId}: ${err.message}`);
            return null;
        }
    }

    /**
     * Starts an opened agent.
     * @param {string} userId - The owner identifier
     * @param {string} agentIdentifier - The agent ID or name
     * @param {string} requestingUserId - The ULID of the user making the request
     * @returns {Promise<Agent|null>} The started Agent instance or null on failure
     */
    async start(userId, agentIdentifier, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const ownerId = await this.#users.resolveId(userId);
        if (!ownerId) return null;

        requestingUserId = requestingUserId === userId ? ownerId : (requestingUserId || ownerId);

        const agentId = await this.#resolveAgentIdFromIdentifier(ownerId, agentIdentifier);
        if (!agentId) return null;

        let agent = this.#agents.get(agentId);
        if (!agent) {
            agent = await this.open(userId, agentIdentifier, requestingUserId);
            if (!agent) return null;
        }

        if (agent.status === AGENT_STATUS_CODES.ACTIVE) {
            return agent;
        }

        try {
            await agent.start();
            const indexKey = this.#constructAgentIndexKey(ownerId, agentId);
            this.#updateAgentIndexEntry(indexKey, {
                status: AGENT_STATUS_CODES.ACTIVE,
                lastAccessed: new Date().toISOString()
            });
            this.emit('agent.started', { agentId, agent: agent.toJSON() });
            return agent;
        } catch (err) {
            const indexKey = this.#constructAgentIndexKey(ownerId, agentId);
            this.#updateAgentIndexEntry(indexKey, { status: AGENT_STATUS_CODES.ERROR });
            this.emit('agent.startFailed', { agentId, error: err.message });
            return null;
        }
    }

    /**
     * Stops a loaded and active agent.
     * @param {string} userId - The owner identifier
     * @param {string} agentIdentifier - The agent ID or name
     * @param {string} requestingUserId - The ULID of the user making the request
     * @returns {Promise<boolean>} True if stopped or already inactive/not loaded, false on failure
     */
    async stop(userId, agentIdentifier, requestingUserId) {
        if (!this.#initialized) throw Error('Agents service not initialized');

        const ownerId = await this.#users.resolveId(userId);
        if (!ownerId) return false;

        requestingUserId = requestingUserId === userId ? ownerId : (requestingUserId || ownerId);

        const agentId = await this.#resolveAgentIdFromIdentifier(ownerId, agentIdentifier);
        if (!agentId) return false;

        const agent = this.#agents.get(agentId);
        const indexKey = this.#constructAgentIndexKey(ownerId, agentId);

        if (!agent) {
            const entry = this.#indexStore.get(indexKey);
            if (entry && entry.owner === requestingUserId && entry.status === AGENT_STATUS_CODES.ACTIVE) {
                this.#updateAgentIndexEntry(indexKey, { status: AGENT_STATUS_CODES.INACTIVE });
            }
            return true;
        }

        if (agent.owner !== requestingUserId) {
            return false;
        }

        if ([AGENT_STATUS_CODES.INACTIVE, AGENT_STATUS_CODES.AVAILABLE].includes(agent.status)) {
            return true;
        }

        try {
            await agent.stop();
            this.#updateAgentIndexEntry(indexKey, { status: AGENT_STATUS_CODES.INACTIVE }, requestingUserId);
            this.emit('agent.stopped', { agentId });
            return true;
        } catch (err) {
            this.#updateAgentIndexEntry(indexKey, { status: AGENT_STATUS_CODES.ERROR }, requestingUserId);
            this.emit('agent.stopFailed', { agentId, error: err.message });
            return false;
        }
    }

    /**
     * Permanently deletes an agent and all its data.
     * @param {string} userId - The owner identifier
     * @param {string} agentIdentifier - The agent ID or name
     * @param {string} [requestingUserId] - The ULID of the user making the request
     * @param {boolean} [removeFiles=true] - Whether to remove agent files from filesystem
     * @returns {Promise<boolean>} True if deleted successfully, false on failure
     */
    async delete(userId, agentIdentifier, requestingUserId, removeFiles = true) {
        if (!this.#initialized) throw Error('Agents service not initialized');

        const ownerId = await this.#users.resolveId(userId);
        if (!ownerId) return false;

        requestingUserId = requestingUserId === userId ? ownerId : (requestingUserId || ownerId);

        const agentId = await this.#resolveAgentIdFromIdentifier(ownerId, agentIdentifier);
        if (!agentId) return false;

        const indexKey = this.#constructAgentIndexKey(ownerId, agentId);
        const entry = this.#indexStore.get(indexKey);

        this.#validateOwnership(entry, requestingUserId, agentId);

        try {
            const agent = this.#agents.get(agentId);
            if (agent && agent.isActive) {
                await agent.stop();
            }

            this.#agents.delete(agentId);
            this.#indexStore.delete(indexKey);

            const host = entry.host || DEFAULT_HOST;
            const nameIndexKey = `${ownerId}@${host}:${entry.name.toLowerCase()}`;
            this.#nameIndex.delete(nameIndexKey);

            const referenceKey = this.constructAgentReference(ownerId, entry.name.toLowerCase(), host);
            this.#referenceIndex.delete(referenceKey);

            if (removeFiles && entry.rootPath) {
                try {
                    const { existsSync } = await import('fs');
                    const fsPromises = (await import('fs/promises'));
                    if (existsSync(entry.rootPath)) {
                        await fsPromises.rm(entry.rootPath, { recursive: true, force: true });
                    }
                } catch (fsErr) {
                    console.warn(`Failed to remove agent directory ${entry.rootPath}: ${fsErr.message}`);
                }
            }

            this.emit('agent.deleted', {
                agentId,
                userId: ownerId,
                agentName: entry.name,
                requestingUserId
            });

            return true;
        } catch (err) {
            this.emit('agent.deleteFailed', {
                agentId,
                userId: ownerId,
                error: err.message,
                requestingUserId
            });
            return false;
        }
    }

    /**
     * Lists all agents for a given userId
     * @param {string} userId - The user ID
     * @param {string} [host=DEFAULT_HOST] - Host to filter by
     * @returns {Promise<Array<Object>>} An array of agent index entry objects
     */
    async listByUser(userId, host = DEFAULT_HOST) {
        if (!this.#initialized) throw new Error('Agents service not initialized');
        if (!userId) return [];

        const ownerId = await this.#users.resolveId(userId);
        if (!ownerId) return [];

        const prefix = `${ownerId}/`;
        logger.debug(`Listing agents for userId ${ownerId} on host ${host}`);

        const allAgents = this.#indexStore.store;
        const userAgentEntries = [];

        for (const key in allAgents) {
            if (key.startsWith(prefix)) {
                const agentEntry = allAgents[key];
                if (agentEntry && typeof agentEntry === 'object' && agentEntry.id) {
                    const agentHost = agentEntry.host || DEFAULT_HOST;
                    if (!host || agentHost === host) {
                        try {
                            const ownerUser = await this.#users.get(agentEntry.owner);
                            const agentWithOwnerEmail = {
                                ...agentEntry,
                                ownerEmail: ownerUser.email
                            };
                            userAgentEntries.push(agentWithOwnerEmail);
                        } catch (error) {
                            logger.debug(`Failed to resolve owner email for agent ${agentEntry.id}: ${error.message}`);
                            userAgentEntries.push(agentEntry);
                        }
                    }
                }
            }
        }
        logger.debug(`Found ${userAgentEntries.length} agents for userId ${ownerId} on host ${host}`);
        return userAgentEntries;
    }

    /**
     * Resolves an agent ID from a agent name and user identifier
     * @param {string} userIdentifier - The user ID, name, or email
     * @param {string} agentName - The agent name
     * @param {string} [host=DEFAULT_HOST] - Host
     * @returns {string|null} The agent ID if found, null otherwise
     */
    async resolveAgentId(userIdentifier, agentName, host = DEFAULT_HOST) {
        const slug = typeof agentName === 'string' ? agentName.toLowerCase() : agentName;
        // First try direct lookup with the provided userIdentifier
        let nameKey = `${userIdentifier}@${host}:${slug}`;
        let agentId = this.#nameIndex.get(nameKey);

        if (agentId) {
            return agentId;
        }

        // If not found, resolve the userIdentifier to the actual user ID and try again
        try {
            const resolvedUserId = await this.#users.resolveId(userIdentifier);
            if (resolvedUserId && resolvedUserId !== userIdentifier) {
                nameKey = `${resolvedUserId}@${host}:${slug}`;
                agentId = this.#nameIndex.get(nameKey);
                if (agentId) {
                    return agentId;
                }
            }
        } catch (err) {
            logger.debug(`Error resolving user identifier ${userIdentifier}: ${err.message}`);
        }

        return null;
    }

    /**
     * Gets an agent by ID directly
     * @param {string} agentId - The agent ID
     * @param {string} requestingUserId - The ULID of the user making the request
     * @returns {Promise<Agent|null>} The loaded Agent instance
     */
    async getById(agentId, requestingUserId) {
        if (!this.#initialized) {
            throw new Error('Agents service not initialized. Cannot get agent by ID.');
        }
        if (!agentId) {
            throw new Error('agentId is required to get agent by ID');
        }

        // Search for agent in index by agentId across all users
        const allEntries = this.#indexStore.store;
        let entry = null;
        let foundIndexKey = null;

        for (const [indexKey, agentEntry] of Object.entries(allEntries)) {
            const parsed = this.#parseAgentIndexKey(indexKey);
            if (parsed && parsed.agentId === agentId) {
                entry = agentEntry;
                foundIndexKey = indexKey;
                break;
            }
        }

        if (!entry) {
            logger.debug(`getAgentById: Agent ${agentId} not found in index`);
            return null;
        }

        // Check ownership if requesting user is provided
        if (requestingUserId && entry.owner !== requestingUserId) {
            logger.debug(`getAgentById: User ${requestingUserId} is not the owner of agent ${agentId}`);
            return null;
        }

        // Return from cache if available
        if (this.#agents.has(agentId)) {
            logger.debug(`Returning cached Agent instance for ${agentId}`);
            return this.#agents.get(agentId);
        }

        // Load agent
        try {
            const conf = new Conf({
                configName: path.basename(entry.configPath, '.json'),
                cwd: path.dirname(entry.configPath)
            });

            const agent = new Agent({
                rootPath: entry.rootPath,
                configStore: conf,
                eventEmitterOptions: {
                    wildcard: true,
                    delimiter: '.',
                    newListener: false,
                    maxListeners: 50
                }
            });

            this.#agents.set(agentId, agent);
            logger.debug(`Loaded and cached Agent instance for ${agentId}`);
            this.#updateAgentIndexEntry(foundIndexKey, { lastAccessed: new Date().toISOString() });
            return agent;
        } catch (err) {
            console.error(`getAgentById failed: Could not load config or instantiate Agent for ${agentId}: ${err.message}`);
            return null;
        }
    }

    /**
     * Updates an agent's configuration
     * @param {string} userId - The owner identifier
     * @param {string} agentIdentifier - The agent ID or name
     * @param {Object} updateData - Data to update
     * @param {string} [requestingUserId] - The ULID of the user making the request
     * @returns {Promise<Agent|null>} Updated agent instance or null if failed
     */
    async update(userId, agentIdentifier, updateData, requestingUserId) {
        if (!this.#initialized) throw Error('Agents service not initialized');

        const ownerId = await this.#users.resolveId(userId);
        if (!ownerId) return null;

        requestingUserId = requestingUserId === userId ? ownerId : (requestingUserId || ownerId);

        const agentId = await this.#resolveAgentIdFromIdentifier(ownerId, agentIdentifier);
        if (!agentId) return null;

        const indexKey = this.#constructAgentIndexKey(ownerId, agentId);
        const entry = this.#indexStore.get(indexKey);

        this.#validateOwnership(entry, requestingUserId, agentId);

        try {
            let agent = this.#agents.get(agentId);
            if (!agent) {
                agent = await this.open(userId, agentIdentifier, requestingUserId);
                if (!agent) return null;
            }

            const allowedKeys = ['label', 'description', 'color', 'llmProvider', 'model', 'metadata', 'config'];
            const updates = {};

            for (const [key, value] of Object.entries(updateData)) {
                if (allowedKeys.includes(key) && value !== undefined) {
                    updates[key] = value;
                    await agent.setConfigKey(key, value);
                }
            }

            this.#updateAgentIndexEntry(indexKey, {
                ...updates,
                updatedAt: new Date().toISOString()
            }, requestingUserId);

            this.emit('agent.updated', {
                agentId,
                userId: ownerId,
                updates,
                requestingUserId
            });

            return agent;
        } catch (err) {
            this.emit('agent.updateFailed', {
                agentId,
                userId: ownerId,
                error: err.message,
                requestingUserId
            });
            return null;
        }
    }

    /**
     * Get a random color for agent
     * @returns {string} Random color
     */
    getRandomColor() {
        return randomcolor({
            luminosity: 'light',
            format: 'hex',
        });
    }

    /**
     * Private Methods
     */

    /**
     * Resolve agent identifier to agent ID
     * @param {string} userId - Owner user ID
     * @param {string} identifier - Agent ID or name
     * @returns {Promise<string|null>} Agent ID if found, null otherwise
     * @private
     */
    async #resolveAgentIdFromIdentifier(userId, identifier) {
        if (!identifier) return null;

        // Check if it's already an agent ID (12-char nanoid or 36-char UUID)
        const isNewAgentId = identifier.length === 12 && /^[a-zA-Z0-9]+$/.test(identifier);
        const isLegacyAgentId = identifier.length === 36 && /^[a-f0-9-]+$/.test(identifier);

        if (isNewAgentId || isLegacyAgentId) {
            return identifier;
        }

        // Try to resolve as agent name
        return await this.resolveAgentId(userId, identifier);
    }

    /**
     * Validate ownership and entry status for agent operations
     * @param {Object} entry - Agent index entry
     * @param {string} requestingUserId - User making the request
     * @param {string} agentId - Agent ID for error messages
     * @returns {boolean} True if valid, throws error otherwise
     * @private
     */
    #validateOwnership(entry, requestingUserId, agentId) {
        if (!entry) {
            throw new Error(`Agent not found: ${agentId}`);
        }

        if (entry.owner !== requestingUserId) {
            throw new Error(`Permission denied: user ${requestingUserId} is not owner of agent ${agentId}`);
        }

        return true;
    }

    /**
     * Rebuilds the name and reference indexes from existing agents in the index store
     * @private
     */
    async #rebuildIndexes() {
        this.#nameIndex.clear();
        this.#referenceIndex.clear();
        const allAgents = this.#indexStore.store;

        for (const [indexKey, agentEntry] of Object.entries(allAgents)) {
            const parsed = this.#parseAgentIndexKey(indexKey);
            if (!agentEntry || !agentEntry.name || !parsed) continue;

            const host = agentEntry.host || DEFAULT_HOST;
            const slug = agentEntry.name.toLowerCase();
            const nameKey = `${parsed.userId}@${host}:${slug}`;
            this.#nameIndex.set(nameKey, parsed.agentId);

            const reference = constructAgentReference(parsed.userId, slug, host);
            this.#referenceIndex.set(reference, parsed.agentId);
        }
    }

    #sanitizeAgentName(agentName) {
        if (!agentName) return 'untitled';
        let sanitized = agentName.toString().trim();
        sanitized = sanitized.replace(/[^A-Za-z0-9_-]/g, '');
        return sanitized;
    }

    /**
     * Pre-creates all subdirectories defined in AGENT_DIRECTORIES.
     * @param {string} agentDir - The agent directory path
     * @returns {Promise<void>}
     * @private
     */
    async #createAgentSubdirectories(agentDir) {
        logger.debug(`Creating subdirectories for agent at ${agentDir}`);
        for (const subdirKey in AGENT_DIRECTORIES) {
            const subdirPath = path.join(agentDir, AGENT_DIRECTORIES[subdirKey]);
            try {
                await fsPromises.mkdir(subdirPath, { recursive: true });
                logger.debug(`Created subdirectory: ${subdirPath}`);
            } catch (err) {
                console.error(`Failed to create subdirectory ${subdirPath}: ${err.message}`);
            }
        }
    }

    /**
     * Performs the initial scan of agents listed in the index.
     * @private
     */
    async #scanIndexedAgents() {
        const allAgents = this.#indexStore.store;

        for (const indexKey in allAgents) {
            const agentEntry = allAgents[indexKey];
            const parsed = this.#parseAgentIndexKey(indexKey);

            if (!agentEntry || !agentEntry.id || !parsed) continue;

            const currentStatus = agentEntry.status;
            if ([AGENT_STATUS_CODES.REMOVED, AGENT_STATUS_CODES.DESTROYED].includes(currentStatus)) {
                continue;
            }

            let newStatus = currentStatus;

            if (!agentEntry.rootPath || !existsSync(agentEntry.rootPath)) {
                newStatus = AGENT_STATUS_CODES.NOT_FOUND;
            } else if (!agentEntry.configPath || !existsSync(agentEntry.configPath)) {
                newStatus = AGENT_STATUS_CODES.ERROR;
            } else if (![AGENT_STATUS_CODES.ACTIVE, AGENT_STATUS_CODES.INACTIVE, AGENT_STATUS_CODES.ERROR, AGENT_STATUS_CODES.NOT_FOUND].includes(currentStatus)) {
                newStatus = AGENT_STATUS_CODES.AVAILABLE;
            } else if (currentStatus === AGENT_STATUS_CODES.ERROR && existsSync(agentEntry.rootPath) && existsSync(agentEntry.configPath)){
                 if (![AGENT_STATUS_CODES.ACTIVE, AGENT_STATUS_CODES.INACTIVE].includes(currentStatus)) {
                    newStatus = AGENT_STATUS_CODES.AVAILABLE;
                 }
            }

            if (newStatus !== currentStatus) {
                this.#updateAgentIndexEntry(indexKey, { status: newStatus });
            }
        }
    }

    /**
     * Validates an agent index entry for opening.
     * @param {Object} entry - The agent index entry
     * @param {string} agentId - The ID of the agent
     * @param {string} requestingUserId - The ULID of the user making the request
     * @returns {boolean} True if valid, false otherwise
     * @private
     */
    #validateAgentEntryForOpen(entry, agentId, requestingUserId) {
        if (!entry) {
            logger.debug(`openAgent failed: Agent ${agentId} not found in index.`);
            return false;
        }
        if (entry.owner !== requestingUserId) {
            console.warn(`openAgent failed: User ${requestingUserId} is not the owner of agent ${agentId}. Stored owner: ${entry.owner}`);
            return false;
        }
        if (!entry.rootPath || !existsSync(entry.rootPath)) {
            console.warn(`openAgent failed: Agent ${agentId} rootPath is missing or does not exist: ${entry.rootPath}`);
            const allEntries = this.#indexStore.store;
            for (const [indexKey, agentEntry] of Object.entries(allEntries)) {
                const parsed = this.#parseAgentIndexKey(indexKey);
                if (parsed && parsed.agentId === agentId) {
                    this.#updateAgentIndexEntry(indexKey, { status: AGENT_STATUS_CODES.NOT_FOUND });
                    break;
                }
            }
            return false;
        }
        if (!entry.configPath || !existsSync(entry.configPath)) {
            console.warn(`openAgent failed: Agent ${agentId} configPath is missing or does not exist: ${entry.configPath}`);
            const allEntries = this.#indexStore.store;
            for (const [indexKey, agentEntry] of Object.entries(allEntries)) {
                const parsed = this.#parseAgentIndexKey(indexKey);
                if (parsed && parsed.agentId === agentId) {
                    this.#updateAgentIndexEntry(indexKey, { status: AGENT_STATUS_CODES.ERROR });
                    break;
                }
            }
            return false;
        }

        const validOpenStatuses = [
            AGENT_STATUS_CODES.AVAILABLE,
            AGENT_STATUS_CODES.INACTIVE,
            AGENT_STATUS_CODES.ACTIVE,
        ];
        if (!validOpenStatuses.includes(entry.status)) {
            console.warn(`openAgent failed: Agent ${agentId} status is invalid (${entry.status}). Must be one of: ${validOpenStatuses.join(', ')}.`);
            return false;
        }
        return true;
    }

    /**
     * Helper to update an agent's entry in the index store.
     * @param {string} indexKey - The index key of the agent in the index
     * @param {Object} updates - Key-value pairs to update in the index entry
     * @param {string} [requestingUserId] - Optional. If provided, validates ownership
     * @private
     */
    #updateAgentIndexEntry(indexKey, updates, requestingUserId = null) {
        const currentEntry = this.#indexStore.get(indexKey);
        if (!currentEntry) {
            logger.debug(`Cannot update index for ${indexKey}: entry not found.`);
            return;
        }

        if (requestingUserId && currentEntry.owner !== requestingUserId) {
            console.error(`Index update for ${indexKey} denied: User ${requestingUserId} is not the owner. Owner: ${currentEntry.owner}`);
            return;
        }

        const updatedEntry = { ...currentEntry, ...updates, updatedAt: new Date().toISOString() };
        this.#indexStore.set(indexKey, updatedEntry);
        logger.debug(`Updated index entry for ${indexKey} with: ${JSON.stringify(updates)}`);
    }
}

export default Agents;
export {
    AGENT_STATUS_CODES,
    AGENT_DIRECTORIES,
};
