'use strict';

import randomcolor from 'randomcolor';
import path from 'path';
import * as fsPromises from 'fs/promises';
import { existsSync } from 'fs';
import EventEmitter from 'eventemitter2';
import { DefaultPackageManager, SettingsManager } from '@mariozechner/pi-coding-agent';
import { generateUUID } from '../../utils/id.js';
import { createLogger } from '../../utils/log.js';
import Agent, { AGENT_STATUS_CODES, LOCAL_PROVIDER_DEFAULTS, sanitizeAgentData, AGENT_SESSION_MODES } from './Agent.js';
import { loadAgentRuntimeConfig, materializeAgentRuntimeFiles, parseSkillMarkdown, sanitizeSkillName } from './files.js';
import { validateAgentProvider } from './validation.js';

const logger = createLogger('agents');

const DEFAULT_HOST = 'canvas.local';
const AGENT_CONFIG_FILENAME = 'agent.json';

const AGENT_DIRECTORIES = {
    runtime: 'runtime',
    home: 'home',
    db: 'db',
    log: 'log',
    config: 'config',
};

const DEFAULT_AGENT_CONFIG = {
    id: null,
    name: null,
    owner: null,
    type: 'agent',
    label: 'Agent',
    color: null,
    description: '',
    llmProvider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    created: null,
    updated: null,
    config: {
        prompts: {},
        tools: {},
        mcp: { servers: [] },
    },
};

function mergeNestedObjects(currentValue = {}, nextValue = {}) {
    return { ...currentValue, ...nextValue };
}

/**
 * Agent Reference Utilities
 */

function parseAgentReference(agentRef) {
    if (!agentRef || typeof agentRef !== 'string') return null;
    const colonIndex = agentRef.indexOf(':');
    if (colonIndex === -1 || colonIndex === agentRef.length - 1) return null;

    const userHostPart = agentRef.substring(0, colonIndex);
    const resourcePart = agentRef.substring(colonIndex + 1);
    const atIndex = userHostPart.lastIndexOf('@');
    if (atIndex === -1 || atIndex === 0 || atIndex === userHostPart.length - 1) return null;

    const userIdentifier = userHostPart.substring(0, atIndex).trim();
    const host = userHostPart.substring(atIndex + 1).trim();
    if (!userIdentifier || !host) return null;

    const [agentSlug, ...rest] = resourcePart.split('/');
    return {
        userIdentifier,
        host,
        agentSlug: agentSlug.trim(),
        path: rest.length ? '/' + rest.join('/') : '',
        full: agentRef,
        isLocal: host === DEFAULT_HOST,
        isRemote: host !== DEFAULT_HOST,
    };
}

function constructAgentReference(userIdentifier, agentSlug, host = DEFAULT_HOST, agentPath = '') {
    if (!userIdentifier || !agentSlug) throw new Error('userIdentifier and agentSlug are required');
    return `${userIdentifier}@${host}:${agentSlug}${agentPath}`;
}

function constructAgentIndexKey(userId, agentId) { return `${userId}/${agentId}`; }
function parseAgentIndexKey(indexKey) {
    if (!indexKey || typeof indexKey !== 'string') return null;
    const parts = indexKey.split('/');
    return parts.length === 2 ? { userId: parts[0], agentId: parts[1] } : null;
}

// Flattens pi assistant messages into plain text for non-streaming callers.
function extractAssistantText(messages = []) {
    const parts = [];
    for (const message of messages) {
        const content = message?.content;
        if (typeof content === 'string') { parts.push(content); continue; }
        if (Array.isArray(content)) {
            for (const block of content) {
                if (typeof block === 'string') parts.push(block);
                else if (block?.type === 'text' && block.text) parts.push(block.text);
            }
        }
    }
    return parts.join('\n').trim();
}

function normalizeAgentName(name) {
    return String(name || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Agents Service
 *
 * Orchestrates agent lifecycle (create/open/start/stop/restart/delete/update/list).
 * Agents live at: {server.root}/users/{user.email}/agents/{agent-slug}/
 */
class Agents extends EventEmitter {

    #defaultRootPath;
    #indexStore;
    #nameIndex = new Map();
    #referenceIndex = new Map();
    #users;
    #agents = new Map();
    #initialized = false;

    /**
     * @param {Object} options
     * @param {string} options.defaultRootPath  - Root under which user agent dirs are stored
     * @param {Object} options.indexStore       - Initialized Conf instance
     * @param {Object} options.users            - Users service
     */
    constructor(options = {}) {
        super(options.eventEmitterOptions || {});
        if (!options.defaultRootPath) throw new Error('defaultRootPath required');
        if (!options.indexStore)      throw new Error('indexStore required');
        if (!options.users)           throw new Error('users service required');

        this.#defaultRootPath = path.resolve(options.defaultRootPath);
        this.#indexStore = options.indexStore;
        this.#users = options.users;
        logger.debug(`Agents service root: ${this.#defaultRootPath}`);
    }

    /**
     * Getters
     */
    get users() { return this.#users; }

    parseAgentReference(ref) { return parseAgentReference(ref); }
    constructAgentReference(userIdentifier, agentSlug, host = DEFAULT_HOST, agentPath = '') {
        return constructAgentReference(userIdentifier, agentSlug, host, agentPath);
    }
    getRandomColor() { return randomcolor({ luminosity: 'light', format: 'hex' }); }

    /**
     * Initialization
     */
    async initialize() {
        if (this.#initialized) return this;
        await this.#rebuildIndexes();
        await this.#scanIndexedAgents();
        this.#initialized = true;
        logger.debug(`Agents initialized: ${this.#indexStore.size} agent(s)`);
        return this;
    }

    /**
     * Public API — Lifecycle
     */

    /**
     * Create a new agent.
     * @param {string} userId
     * @param {string} agentName
     * @param {Object} options
     */
    async create(userId, agentName, options = {}) {
        if (!this.#initialized) throw new Error('Agents service not initialized');
        if (!userId)    throw new Error('userId required');
        if (!agentName) throw new Error('agentName required');

        const slug = normalizeAgentName(agentName);
        this.#validateAgentData({ name: slug, ...options });

        const owner = await this.#users.resolveId(userId);
        if (!owner) throw new Error(`Cannot resolve user: ${userId}`);

        const ownerUser = await this.#users.get(owner);
        const ownerEmail = ownerUser?.email;
        if (!ownerEmail) throw new Error(`Cannot resolve email for user: ${owner}`);

        const host = options.host || DEFAULT_HOST;
        const agentId = options.id || generateUUID();

        const referenceKey = constructAgentReference(owner, slug, host);
        if (this.#referenceIndex.has(referenceKey)) {
            throw new Error(`Agent "${agentName}" already exists for user ${userId} on host ${host}`);
        }

        // Path: {defaultRootPath}/{user.email}/agents/{slug}
        const agentDir = options.agentPath || path.join(this.#defaultRootPath, ownerEmail, 'agents', slug);

        const agentConfig = this.#mergeAgentConfig(DEFAULT_AGENT_CONFIG.config, options.config || {});
        const configPath = path.join(agentDir, AGENT_DIRECTORIES.config, AGENT_CONFIG_FILENAME);
        const configData = {
            ...DEFAULT_AGENT_CONFIG,
            id: agentId,
            name: slug,
            label: options.label || agentName,
            description: options.description || '',
            owner,
            color: options.color || this.getRandomColor(),
            llmProvider: options.llmProvider || DEFAULT_AGENT_CONFIG.llmProvider,
            model: options.model || DEFAULT_AGENT_CONFIG.model,
            host,
            rootPath: agentDir,
            configPath,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            metadata: options.metadata || {},
            config: agentConfig,
        };

        await validateAgentProvider(configData);

        if (existsSync(agentDir)) {
            logger.warn(`Agent directory already exists: ${agentDir}`);
        }

        await fsPromises.mkdir(agentDir, { recursive: true });
        for (const subdir of Object.values(AGENT_DIRECTORIES)) {
            await fsPromises.mkdir(path.join(agentDir, subdir), { recursive: true });
        }

        await fsPromises.writeFile(configPath, JSON.stringify(configData, null, 2));
        await materializeAgentRuntimeFiles(agentDir, configData);
        logger.debug(`Agent config written: ${configPath}`);

        // Write models.json for local providers (ollama, lm-studio, vllm)
        await this.#writeModelsConfig(path.join(agentDir, AGENT_DIRECTORIES.runtime), {
            llmProvider: configData.llmProvider,
            model: configData.model,
            baseUrl: agentConfig.baseUrl,
            apiKey: agentConfig.apiKey,
        });

        const indexEntry = { ...configData, status: AGENT_STATUS_CODES.AVAILABLE, lastAccessed: null };
        const indexKey = constructAgentIndexKey(owner, agentId);
        this.#indexStore.set(indexKey, indexEntry);
        this.#nameIndex.set(`${owner}@${host}:${slug}`, agentId);
        this.#referenceIndex.set(referenceKey, agentId);
        indexEntry.reference = referenceKey;

        this.emit('agent.created', { userId: owner, agentId, agentName, agent: indexEntry });
        logger.debug(`Agent created: ${agentId} (${agentName}) owner=${owner}`);
        return sanitizeAgentData(indexEntry);
    }

    /**
     * Load an agent instance into memory.
     */
    async open(userId, agentIdentifier, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');
        if (!userId || !agentIdentifier) throw new Error('userId and agentIdentifier required');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return null;
        requestingUserId = requestingUserId || owner;

        const agentId = await this.#resolveAgentId(owner, agentIdentifier);
        if (!agentId) return null;

        if (this.#agents.has(agentId)) {
            const cached = this.#agents.get(agentId);
            return cached.owner === requestingUserId ? cached : null;
        }

        const indexKey = constructAgentIndexKey(owner, agentId);
        const entry = this.#indexStore.get(indexKey);
        if (!this.#validateEntryForOpen(entry, agentId, requestingUserId)) return null;

        try {
            const config = await this.#loadConfig(entry.configPath);
            const agent = new Agent({
                rootPath: entry.rootPath,
                config,
                eventEmitterOptions: { wildcard: true, delimiter: '.', newListener: false, maxListeners: 50 },
            });
            this.#agents.set(agentId, agent);
            this.#updateIndex(indexKey, { lastAccessed: new Date().toISOString() });
            return agent;
        } catch (err) {
            logger.error(`Failed to open agent ${agentId}: ${err.message}`);
            return null;
        }
    }

    /**
     * Start an agent (opens if not already in memory).
     */
    async start(userId, agentIdentifier, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return null;
        requestingUserId = requestingUserId === userId ? owner : (requestingUserId || owner);

        const agentId = await this.#resolveAgentId(owner, agentIdentifier);
        if (!agentId) return null;

        let agent = this.#agents.get(agentId) || await this.open(userId, agentIdentifier, requestingUserId);
        if (!agent) return null;
        if (agent.isActive) return agent;

        const indexKey = constructAgentIndexKey(owner, agentId);
        try {
            await validateAgentProvider({
                llmProvider: agent.llmProvider,
                model: agent.model,
                config: agent.agentConfig,
            });
            await agent.start();
            this.#updateIndex(indexKey, { status: AGENT_STATUS_CODES.ACTIVE, lastAccessed: new Date().toISOString() });
            this.emit('agent.started', { agentId, userId: owner, agent: agent.toJSON() });
            return agent;
        } catch (err) {
            logger.error({ err, agentId }, `Agent start failed: ${err.message}`);
            this.#updateIndex(indexKey, { status: AGENT_STATUS_CODES.ERROR });
            this.emit('agent.startFailed', { agentId, userId: owner, error: err.message });
            throw err;  // re-throw so the route can surface the real error
        }
    }

    /**
     * Stop an active agent.
     */
    async stop(userId, agentIdentifier, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return false;
        requestingUserId = requestingUserId === userId ? owner : (requestingUserId || owner);

        const agentId = await this.#resolveAgentId(owner, agentIdentifier);
        if (!agentId) return false;

        const agent = this.#agents.get(agentId);
        const indexKey = constructAgentIndexKey(owner, agentId);

        if (!agent) {
            const entry = this.#indexStore.get(indexKey);
            if (entry?.owner === requestingUserId && entry?.status === AGENT_STATUS_CODES.ACTIVE) {
                this.#updateIndex(indexKey, { status: AGENT_STATUS_CODES.INACTIVE });
            }
            return true;
        }

        if (agent.owner !== requestingUserId) return false;
        if ([AGENT_STATUS_CODES.INACTIVE, AGENT_STATUS_CODES.AVAILABLE].includes(agent.status)) return true;

        try {
            await agent.stop();
            this.#updateIndex(indexKey, { status: AGENT_STATUS_CODES.INACTIVE });
            this.emit('agent.stopped', { agentId, userId: owner });
            return true;
        } catch (err) {
            this.#updateIndex(indexKey, { status: AGENT_STATUS_CODES.ERROR });
            this.emit('agent.stopFailed', { agentId, userId: owner, error: err.message });
            return false;
        }
    }

    /**
     * Restart an agent (stop then start).
     */
    async restart(userId, agentIdentifier, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const stopped = await this.stop(userId, agentIdentifier, requestingUserId);
        if (!stopped) return null;
        return this.start(userId, agentIdentifier, requestingUserId);
    }

    /**
     * Prompt an agent and return its assistant text reply, starting it if
     * needed. Convenience for in-process callers (hooks); the raw message array
     * form lives on the Agent instance.
     */
    async prompt(userId, agentIdentifier, message, options = {}, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');
        const agent = await this.start(userId, agentIdentifier, requestingUserId || userId);
        if (!agent) throw new Error(`Agent not found or not startable: ${agentIdentifier}`);
        const messages = await agent.prompt(message, options);
        return extractAssistantText(messages);
    }

    async listSessions(userId, agentIdentifier, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return null;
        requestingUserId = requestingUserId === userId ? owner : (requestingUserId || owner);

        const agent = this.#agents.get(await this.#resolveAgentId(owner, agentIdentifier))
            || await this.open(userId, agentIdentifier, requestingUserId);
        if (!agent) return null;
        if (agent.owner !== requestingUserId) throw new Error(`Permission denied for agent ${agent.id}`);

        return agent.listSessions();
    }

    async createSession(userId, agentIdentifier, options = {}, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return null;
        requestingUserId = requestingUserId === userId ? owner : (requestingUserId || owner);

        const agent = this.#agents.get(await this.#resolveAgentId(owner, agentIdentifier))
            || await this.open(userId, agentIdentifier, requestingUserId);
        if (!agent) return null;
        if (agent.owner !== requestingUserId) throw new Error(`Permission denied for agent ${agent.id}`);

        const sessionConfig = await agent.createSession(options);
        await this.#persistSessionConfig(owner, agent, {
            mode: sessionConfig.mode,
            path: sessionConfig.mode !== AGENT_SESSION_MODES.INCOGNITO ? sessionConfig.path || null : null,
            experimentalPath: sessionConfig.experimentalPath || null,
        });
        if (agent.isActive) {
            await agent.restart();
        }

        return {
            current: agent.getSessionContext(),
            sessions: await agent.listSessions(),
        };
    }

    async selectSession(userId, agentIdentifier, options = {}, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return null;
        requestingUserId = requestingUserId === userId ? owner : (requestingUserId || owner);

        const agent = this.#agents.get(await this.#resolveAgentId(owner, agentIdentifier))
            || await this.open(userId, agentIdentifier, requestingUserId);
        if (!agent) return null;
        if (agent.owner !== requestingUserId) throw new Error(`Permission denied for agent ${agent.id}`);

        const sessionConfig = await agent.selectSession(options);
        await this.#persistSessionConfig(owner, agent, {
            mode: sessionConfig.mode,
            path: sessionConfig.mode !== AGENT_SESSION_MODES.INCOGNITO ? sessionConfig.path || null : null,
            experimentalPath: sessionConfig.experimentalPath || null,
        });
        if (agent.isActive) {
            await agent.restart();
        }

        return {
            current: agent.getSessionContext(),
            sessions: await agent.listSessions(),
        };
    }

    async renameSession(userId, agentIdentifier, options = {}, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return null;
        requestingUserId = requestingUserId === userId ? owner : (requestingUserId || owner);

        const agent = this.#agents.get(await this.#resolveAgentId(owner, agentIdentifier))
            || await this.open(userId, agentIdentifier, requestingUserId);
        if (!agent) return null;
        if (agent.owner !== requestingUserId) throw new Error(`Permission denied for agent ${agent.id}`);

        await agent.renameSession(options);
        return {
            current: agent.getSessionContext(),
            sessions: await agent.listSessions(),
        };
    }

    async deleteSession(userId, agentIdentifier, options = {}, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return null;
        requestingUserId = requestingUserId === userId ? owner : (requestingUserId || owner);

        let agent = this.#agents.get(await this.#resolveAgentId(owner, agentIdentifier))
            || await this.open(userId, agentIdentifier, requestingUserId);
        if (!agent) return null;
        if (agent.owner !== requestingUserId) throw new Error(`Permission denied for agent ${agent.id}`);

        const result = await agent.deleteSession(options);
        if (result.currentDeleted) {
            await this.#persistSessionConfig(owner, agent, {
                mode: result.session.mode,
                path: result.session.path,
                experimentalPath: result.session.experimentalPath,
            });
            if (result.wasActive) {
                agent = await this.start(userId, agentIdentifier, requestingUserId);
            }
        }

        return {
            current: agent.getSessionContext(),
            sessions: await agent.listSessions(),
        };
    }

    async listSkills(userId, agentIdentifier, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return null;
        requestingUserId = requestingUserId === userId ? owner : (requestingUserId || owner);

        const agent = this.#agents.get(await this.#resolveAgentId(owner, agentIdentifier))
            || await this.open(userId, agentIdentifier, requestingUserId);
        if (!agent) return null;
        if (agent.owner !== requestingUserId) throw new Error(`Permission denied for agent ${agent.id}`);

        return this.#listAgentSkills(agent);
    }

    async installSkill(userId, agentIdentifier, skill = {}, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return null;
        requestingUserId = requestingUserId === userId ? owner : (requestingUserId || owner);

        const agent = this.#agents.get(await this.#resolveAgentId(owner, agentIdentifier))
            || await this.open(userId, agentIdentifier, requestingUserId);
        if (!agent) return null;
        if (agent.owner !== requestingUserId) throw new Error(`Permission denied for agent ${agent.id}`);

        if (typeof skill.source === 'string' && skill.source.trim()) {
            await this.#installSkillPackage(agent, skill.source.trim());
            if (agent.isActive) await agent.restart();
            return this.#listAgentSkills(agent);
        }

        const normalizedSkill = this.#normalizeSkill(skill);
        const skills = (agent.agentConfig.skills || [])
            .filter((entry) => sanitizeSkillName(entry?.name) !== normalizedSkill.name);
        skills.push(normalizedSkill);

        const updated = await this.update(userId, agentIdentifier, { config: { skills } }, requestingUserId);
        return updated ? this.#listAgentSkills(updated) : skills;
    }

    async removeSkill(userId, agentIdentifier, skillName, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return null;
        requestingUserId = requestingUserId === userId ? owner : (requestingUserId || owner);

        const agent = this.#agents.get(await this.#resolveAgentId(owner, agentIdentifier))
            || await this.open(userId, agentIdentifier, requestingUserId);
        if (!agent) return null;
        if (agent.owner !== requestingUserId) throw new Error(`Permission denied for agent ${agent.id}`);

        if (this.#isPackageSource(skillName)) {
            await this.#removeSkillPackage(agent, skillName);
            if (agent.isActive) await agent.restart();
            return this.#listAgentSkills(agent);
        }

        const name = sanitizeSkillName(skillName);
        if (!name) throw new Error('Skill name is required');

        const currentSkills = agent.agentConfig.skills || [];
        const skills = currentSkills.filter((entry) => sanitizeSkillName(entry?.name) !== name);
        if (skills.length === currentSkills.length) throw new Error(`Skill not found: ${skillName}`);

        const updated = await this.update(userId, agentIdentifier, { config: { skills } }, requestingUserId);
        return updated ? this.#listAgentSkills(updated) : skills;
    }

    /**
     * Permanently delete an agent.
     * @param {boolean} [removeFiles=true]
     */
    async delete(userId, agentIdentifier, requestingUserId, removeFiles = true) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return false;
        requestingUserId = requestingUserId === userId ? owner : (requestingUserId || owner);

        const agentId = await this.#resolveAgentId(owner, agentIdentifier);
        if (!agentId) return false;

        const indexKey = constructAgentIndexKey(owner, agentId);
        const entry = this.#indexStore.get(indexKey);
        if (!entry) throw new Error(`Agent not found: ${agentId}`);
        if (entry.owner !== requestingUserId) throw new Error(`Permission denied for agent ${agentId}`);

        try {
            const agent = this.#agents.get(agentId);
            if (agent?.isActive) await agent.stop();
            this.#agents.delete(agentId);
            this.#indexStore.delete(indexKey);

            const host = entry.host || DEFAULT_HOST;
            this.#nameIndex.delete(`${owner}@${host}:${entry.name.toLowerCase()}`);
            this.#referenceIndex.delete(constructAgentReference(owner, entry.name.toLowerCase(), host));

            if (removeFiles && entry.rootPath && existsSync(entry.rootPath)) {
                await fsPromises.rm(entry.rootPath, { recursive: true, force: true });
            }

            this.emit('agent.deleted', { agentId, userId: owner, agentName: entry.name, requestingUserId });
            return true;
        } catch (err) {
            this.emit('agent.deleteFailed', { agentId, userId: owner, error: err.message, requestingUserId });
            return false;
        }
    }

    /**
     * Update agent configuration fields.
     */
    async update(userId, agentIdentifier, updateData, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');

        const owner = await this.#users.resolveId(userId);
        if (!owner) return null;
        requestingUserId = requestingUserId === userId ? owner : (requestingUserId || owner);

        const agentId = await this.#resolveAgentId(owner, agentIdentifier);
        if (!agentId) return null;

        const indexKey = constructAgentIndexKey(owner, agentId);
        const entry = this.#indexStore.get(indexKey);
        if (!entry) throw new Error(`Agent not found: ${agentId}`);
        if (entry.owner !== requestingUserId) throw new Error(`Permission denied for agent ${agentId}`);

        let agent = this.#agents.get(agentId) || await this.open(userId, agentIdentifier, requestingUserId);
        if (!agent) return null;

        const allowed = ['name', 'label', 'description', 'color', 'llmProvider', 'model', 'metadata', 'config'];
        const normalizedUpdateData = {
            ...updateData,
            ...(updateData.config ? { config: this.#mergeAgentConfig(agent.agentConfig, updateData.config) } : {}),
        };
        if (normalizedUpdateData.name !== undefined) {
            normalizedUpdateData.name = normalizeAgentName(normalizedUpdateData.name);
            this.#validateAgentData({ name: normalizedUpdateData.name });
            const host = entry.host || DEFAULT_HOST;
            const currentSlug = normalizeAgentName(entry.name);
            const nextSlug = normalizedUpdateData.name;
            const nextNameKey = `${owner}@${host}:${nextSlug}`;
            const existingAgentId = this.#nameIndex.get(nextNameKey);
            if (nextSlug !== currentSlug && existingAgentId && existingAgentId !== agentId) {
                throw new Error(`Agent "${nextSlug}" already exists for user ${userId} on host ${host}`);
            }
        }
        const updates = {};
        for (const [key, value] of Object.entries(normalizedUpdateData)) {
            if (allowed.includes(key) && value !== undefined) {
                updates[key] = value;
            }
        }

        // Persist to disk and regenerate models.json for local providers
        const config = await this.#loadConfig(entry.configPath);
        const updated = { ...config, ...updates, updatedAt: new Date().toISOString() };
        updated.config = this.#mergeAgentConfig(config.config, updates.config);

        await validateAgentProvider(updated);
        await fsPromises.writeFile(entry.configPath, JSON.stringify(updated, null, 2));
        await materializeAgentRuntimeFiles(entry.rootPath, updated);

        await this.#writeModelsConfig(path.join(entry.rootPath, AGENT_DIRECTORIES.runtime), {
            llmProvider: updated.llmProvider,
            model: updated.model,
            baseUrl: updated.config?.baseUrl,
            apiKey: updated.config?.apiKey,
        });

        for (const [key, value] of Object.entries(updates)) {
            agent.setConfigKey(key, value);
        }

        if (agent.isActive && this.#requiresRestart(updates)) {
            await agent.restart();
        }

        if (updates.name) {
            const host = entry.host || DEFAULT_HOST;
            const oldSlug = normalizeAgentName(entry.name);
            this.#nameIndex.delete(`${owner}@${host}:${oldSlug}`);
            this.#referenceIndex.delete(constructAgentReference(owner, oldSlug, host));
            this.#nameIndex.set(`${owner}@${host}:${updates.name}`, agentId);
            this.#referenceIndex.set(constructAgentReference(owner, updates.name, host), agentId);
            updates.reference = constructAgentReference(owner, updates.name, host);
        }

        this.#updateIndex(indexKey, { ...updates, updatedAt: new Date().toISOString() });
        this.emit('agent.updated', { agentId, userId: owner, updates, requestingUserId });
        return agent;
    }

    /**
     * List all agents for a user.
     */
    async listByUser(userId, host = DEFAULT_HOST) {
        if (!this.#initialized) throw new Error('Agents service not initialized');
        if (!userId) return [];

        const owner = await this.#users.resolveId(userId);
        if (!owner) return [];

        const prefix = `${owner}/`;
        const results = [];

        for (const [key, entry] of Object.entries(this.#indexStore.store)) {
            if (!key.startsWith(prefix) || !entry?.id) continue;
            const entryHost = entry.host || DEFAULT_HOST;
            if (host && entryHost !== host) continue;

            try {
                const ownerUser = await this.#users.get(entry.owner);
                results.push(sanitizeAgentData({ ...entry, ownerEmail: ownerUser?.email }));
            } catch {
                results.push(sanitizeAgentData(entry));
            }
        }

        return results;
    }

    /**
     * Resolve agent ID from name or ID string.
     */
    async resolveAgentId(userIdentifier, agentName, host = DEFAULT_HOST) {
        const slug = normalizeAgentName(agentName);
        let nameKey = `${userIdentifier}@${host}:${slug}`;
        let agentId = this.#nameIndex.get(nameKey);
        if (agentId) return agentId;

        try {
            const resolved = await this.#users.resolveId(userIdentifier);
            if (resolved && resolved !== userIdentifier) {
                agentId = this.#nameIndex.get(`${resolved}@${host}:${slug}`);
                if (agentId) return agentId;
            }
        } catch (err) {
            logger.debug(`Error resolving user ${userIdentifier}: ${err.message}`);
        }
        return null;
    }

    /**
     * Get a loaded agent instance by ID (cross-user lookup).
     */
    async getById(agentId, requestingUserId) {
        if (!this.#initialized) throw new Error('Agents service not initialized');
        if (!agentId) throw new Error('agentId required');

        let foundEntry = null, foundKey = null;
        for (const [key, entry] of Object.entries(this.#indexStore.store)) {
            const parsed = parseAgentIndexKey(key);
            if (parsed?.agentId === agentId) { foundEntry = entry; foundKey = key; break; }
        }
        if (!foundEntry) return null;
        if (requestingUserId && foundEntry.owner !== requestingUserId) return null;

        if (this.#agents.has(agentId)) return this.#agents.get(agentId);

        try {
            const config = await this.#loadConfig(foundEntry.configPath);
            const agent = new Agent({
                rootPath: foundEntry.rootPath,
                config,
                eventEmitterOptions: { wildcard: true, delimiter: '.', newListener: false, maxListeners: 50 },
            });
            this.#agents.set(agentId, agent);
            this.#updateIndex(foundKey, { lastAccessed: new Date().toISOString() });
            return agent;
        } catch (err) {
            logger.error(`getById failed for ${agentId}: ${err.message}`);
            return null;
        }
    }

    /**
     * Private helpers
     */

    async #resolveAgentId(ownerId, identifier) {
        if (!identifier) return null;
        const isUUID = identifier.length === 36 && /^[a-f0-9-]+$/.test(identifier);
        const isShort = identifier.length === 12 && /^[a-zA-Z0-9]+$/.test(identifier);
        if (isUUID || isShort) return identifier;
        return this.resolveAgentId(ownerId, identifier);
    }

    async #loadConfig(configPath) {
        const raw = await fsPromises.readFile(configPath, 'utf8');
        const config = JSON.parse(raw);
        return loadAgentRuntimeConfig(config.rootPath, config);
    }

    #mergeAgentConfig(currentConfig = {}, nextConfig = {}) {
        const merged = { ...currentConfig, ...nextConfig };

        if (currentConfig.prompts || nextConfig.prompts) {
            merged.prompts = mergeNestedObjects(currentConfig.prompts, nextConfig.prompts);
        }
        if (currentConfig.tools || nextConfig.tools) {
            merged.tools = mergeNestedObjects(currentConfig.tools, nextConfig.tools);
        }
        if (currentConfig.connectors || nextConfig.connectors) {
            merged.connectors = mergeNestedObjects(currentConfig.connectors, nextConfig.connectors);
        }
        if (currentConfig.parameters || nextConfig.parameters) {
            merged.parameters = mergeNestedObjects(currentConfig.parameters, nextConfig.parameters);
        }
        if (currentConfig.identity || nextConfig.identity) {
            merged.identity = mergeNestedObjects(currentConfig.identity, nextConfig.identity);
        }
        if (currentConfig.session || nextConfig.session) {
            merged.session = mergeNestedObjects(currentConfig.session, nextConfig.session);
            if (nextConfig.session && Object.prototype.hasOwnProperty.call(nextConfig.session, 'path')) {
                if (nextConfig.session.path) {
                    merged.session.path = nextConfig.session.path;
                } else {
                    delete merged.session.path;
                }
            }
            if (nextConfig.session && Object.prototype.hasOwnProperty.call(nextConfig.session, 'experimentalPath')) {
                if (nextConfig.session.experimentalPath) {
                    merged.session.experimentalPath = nextConfig.session.experimentalPath;
                } else {
                    delete merged.session.experimentalPath;
                }
            }
        }

        return merged;
    }

    #requiresRestart(updates = {}) {
        return updates.llmProvider !== undefined
            || updates.model !== undefined
            || updates.config !== undefined;
    }

    #settingsManager(agent) {
        return SettingsManager.create(
            path.join(agent.rootPath, AGENT_DIRECTORIES.home),
            path.join(agent.rootPath, AGENT_DIRECTORIES.runtime)
        );
    }

    #packageManager(agent, settingsManager = this.#settingsManager(agent)) {
        return new DefaultPackageManager({
            cwd: path.join(agent.rootPath, AGENT_DIRECTORIES.home),
            agentDir: path.join(agent.rootPath, AGENT_DIRECTORIES.runtime),
            settingsManager,
        });
    }

    #isPackageSource(value) {
        return typeof value === 'string' && /^(npm|git):/.test(value.trim());
    }

    async #listAgentSkills(agent) {
        const packageSkills = [];
        const settingsManager = this.#settingsManager(agent);
        const packageManager = this.#packageManager(agent, settingsManager);
        const configuredPackages = packageManager.listConfiguredPackages();
        const resolved = await packageManager.resolve();

        for (const entry of resolved.skills) {
            if (!entry.enabled || entry.metadata.origin !== 'package') continue;
            const raw = await fsPromises.readFile(entry.path, 'utf8').catch(() => null);
            if (!raw) continue;
            const parsed = parseSkillMarkdown(raw, path.basename(path.dirname(entry.path)));
            packageSkills.push({
                ...parsed,
                source: entry.metadata.source,
                package: true,
                path: entry.path,
            });
        }

        return [
            ...(agent.agentConfig.skills || []),
            ...packageSkills,
            ...configuredPackages
                .filter((pkg) => !packageSkills.some((skill) => skill.source === pkg.source))
                .map((pkg) => ({
                    name: pkg.source,
                    description: pkg.installedPath ? 'Installed package' : 'Configured package',
                    content: '',
                    source: pkg.source,
                    package: true,
                    installedPath: pkg.installedPath,
                })),
        ];
    }

    async #installSkillPackage(agent, source) {
        const settingsManager = this.#settingsManager(agent);
        const packageManager = this.#packageManager(agent, settingsManager);
        await packageManager.installAndPersist(source);
        await settingsManager.flush();
    }

    async #removeSkillPackage(agent, source) {
        const settingsManager = this.#settingsManager(agent);
        const packageManager = this.#packageManager(agent, settingsManager);
        const removed = await packageManager.removeAndPersist(source);
        await settingsManager.flush();
        if (!removed) throw new Error(`Skill package not found: ${source}`);
    }

    #normalizeSkill(skill = {}) {
        const rawContent = typeof skill.content === 'string' ? skill.content.trim() : '';
        const frontmatter = this.#parseSkillFrontmatter(rawContent);
        const name = sanitizeSkillName(skill.name || frontmatter.name);
        if (!name) throw new Error('Skill name is required');

        const content = frontmatter.content || rawContent;
        if (!content) throw new Error('Skill content is required');

        const description = typeof skill.description === 'string' && skill.description.trim()
            ? skill.description.trim()
            : frontmatter.description;
        return {
            name,
            description: description || `${name} skill`,
            content,
            ...(skill.disableModelInvocation || skill['disable-model-invocation'] || frontmatter.disableModelInvocation
                ? { disableModelInvocation: true }
                : {}),
        };
    }

    #parseSkillFrontmatter(content = '') {
        const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (!match) return {};

        const fields = {};
        for (const line of match[1].split('\n')) {
            const separatorIndex = line.indexOf(':');
            if (separatorIndex === -1) continue;
            const key = line.slice(0, separatorIndex).trim();
            fields[key] = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, '');
        }

        return {
            name: fields.name,
            description: fields.description,
            content: match[2].trim(),
            disableModelInvocation: fields['disable-model-invocation'] === 'true',
        };
    }

    async #persistSessionConfig(owner, agent, sessionConfig) {
        const indexKey = constructAgentIndexKey(owner, agent.id);
        const entry = this.#indexStore.get(indexKey);
        if (!entry) throw new Error(`Agent not found: ${agent.id}`);

        const config = await this.#loadConfig(entry.configPath);
        const updated = {
            ...config,
            config: this.#mergeAgentConfig(config.config, { session: sessionConfig }),
            updatedAt: new Date().toISOString(),
        };

        await fsPromises.writeFile(entry.configPath, JSON.stringify(updated, null, 2));
        agent.setConfigKey('config', updated.config);
        this.#updateIndex(indexKey, {
            config: updated.config,
            updatedAt: updated.updatedAt,
        });
    }

    /**
     * Write (or overwrite) models.json for a local OpenAI-compatible provider.
     * Called on agent create/update when provider-specific settings change.
     * Users can subsequently edit models.json manually for advanced config (compat, multiple models, etc.).
     */
    async #writeModelsConfig(runtimePath, { llmProvider, model, baseUrl, apiKey }) {
        const defaults = LOCAL_PROVIDER_DEFAULTS[llmProvider];
        if (!defaults || !model) return;

        const config = {
            providers: {
                [llmProvider]: {
                    baseUrl: baseUrl || defaults.baseUrl,
                    api: defaults.api,
                    apiKey: apiKey || defaults.apiKey,
                    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
                    models: [{ id: model, input: ['text', 'image'] }],
                },
            },
        };

        const filePath = path.join(runtimePath, 'models.json');
        await fsPromises.writeFile(filePath, JSON.stringify(config, null, 2));
        logger.debug(`models.json written: ${filePath}`);
    }

    #validateAgentData(data) {
        if (!data?.name || typeof data.name !== 'string') throw new Error('Agent name is required (string)');
        if (data.name.length < 3 || data.name.length > 39) throw new Error('Agent name must be 3-39 chars');
        if (!/^[A-Za-z0-9_-]+$/.test(data.name)) throw new Error('Agent name: letters, numbers, _ and - only');
        if (data.color && !/^#[0-9A-Fa-f]{3,6}$/.test(data.color)) throw new Error('Invalid hex color');
    }

    #sanitizeAgentName(name) {
        return (name || 'untitled').toString().trim().replace(/[^A-Za-z0-9_-]/g, '');
    }

    async #rebuildIndexes() {
        this.#nameIndex.clear();
        this.#referenceIndex.clear();
        for (const [key, entry] of Object.entries(this.#indexStore.store)) {
            const parsed = parseAgentIndexKey(key);
            if (!entry?.name || !parsed) continue;
            const host = entry.host || DEFAULT_HOST;
            const slug = normalizeAgentName(entry.name);
            if (!slug) continue;
            this.#nameIndex.set(`${parsed.userId}@${host}:${slug}`, parsed.agentId);
            this.#referenceIndex.set(constructAgentReference(parsed.userId, slug, host), parsed.agentId);
        }
    }

    async #scanIndexedAgents() {
        for (const [key, entry] of Object.entries(this.#indexStore.store)) {
            if (!entry?.id) continue;
            if ([AGENT_STATUS_CODES.REMOVED, AGENT_STATUS_CODES.DESTROYED].includes(entry.status)) continue;

            let newStatus = entry.status;
            if (!entry.rootPath || !existsSync(entry.rootPath)) {
                newStatus = AGENT_STATUS_CODES.NOT_FOUND;
            } else if (!entry.configPath || !existsSync(entry.configPath)) {
                newStatus = AGENT_STATUS_CODES.ERROR;
            } else if (![
                AGENT_STATUS_CODES.ACTIVE, AGENT_STATUS_CODES.INACTIVE,
                AGENT_STATUS_CODES.ERROR, AGENT_STATUS_CODES.NOT_FOUND,
            ].includes(entry.status)) {
                newStatus = AGENT_STATUS_CODES.AVAILABLE;
            }

            if (newStatus !== entry.status) this.#updateIndex(key, { status: newStatus });
        }
    }

    #validateEntryForOpen(entry, agentId, requestingUserId) {
        if (!entry) { logger.debug(`Agent ${agentId} not in index`); return false; }
        if (entry.owner !== requestingUserId) { logger.warn(`User ${requestingUserId} is not owner of ${agentId}`); return false; }
        if (!entry.rootPath || !existsSync(entry.rootPath)) { logger.warn(`rootPath missing for ${agentId}`); return false; }
        if (!entry.configPath || !existsSync(entry.configPath)) { logger.warn(`configPath missing for ${agentId}`); return false; }
        const validStatuses = [AGENT_STATUS_CODES.AVAILABLE, AGENT_STATUS_CODES.INACTIVE, AGENT_STATUS_CODES.ACTIVE, AGENT_STATUS_CODES.ERROR];
        if (!validStatuses.includes(entry.status)) { logger.warn(`Invalid status ${entry.status} for ${agentId}`); return false; }
        return true;
    }

    #updateIndex(indexKey, updates) {
        const current = this.#indexStore.get(indexKey);
        if (!current) return;
        this.#indexStore.set(indexKey, { ...current, ...updates, updatedAt: new Date().toISOString() });
    }
}

export default Agents;
export { AGENT_STATUS_CODES, AGENT_DIRECTORIES };
