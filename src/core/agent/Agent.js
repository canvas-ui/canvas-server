'use strict';

import path from 'path';
import { writeFile, access } from 'fs/promises';
import EventEmitter from 'eventemitter2';
import {
    createAgentSession,
    AuthStorage,
    ModelRegistry,
    SessionManager,
    createCodingTools,
} from '@mariozechner/pi-coding-agent';
import { getModel } from '@mariozechner/pi-ai';

import { createLogger } from '../../utils/log.js';

export const AGENT_STATUS_CODES = {
    AVAILABLE: 'available',
    NOT_FOUND: 'not_found',
    ERROR: 'error',
    ACTIVE: 'active',
    INACTIVE: 'inactive',
    REMOVED: 'removed',
    DESTROYED: 'destroyed',
};

const logger = createLogger('agent');

// Env vars → provider names as pi-ai expects them
export const PROVIDER_ENV_KEYS = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GEMINI_API_KEY',
};

// Local OpenAI-compatible providers: defaults for auto-generating models.json
export const LOCAL_PROVIDER_DEFAULTS = {
    ollama:      { api: 'openai-completions', baseUrl: 'http://localhost:11434/v1', apiKey: 'ollama' },
    'lm-studio': { api: 'openai-completions', baseUrl: 'http://localhost:1234/v1',  apiKey: 'lm-studio' },
    vllm:        { api: 'openai-completions', baseUrl: 'http://localhost:8000/v1',  apiKey: 'vllm' },
};

class Agent extends EventEmitter {

    #rootPath;
    #config;        // plain object from agent.json
    #session = null;
    #status = AGENT_STATUS_CODES.INACTIVE;

    /**
     * @param {Object} options
     * @param {string} options.rootPath   - Absolute path to agent root directory
     * @param {Object} options.config     - Plain config object (from agent.json)
     * @param {Object} [options.eventEmitterOptions]
     */
    constructor(options = {}) {
        super(options.eventEmitterOptions);
        if (!options.rootPath) throw new Error('Agent rootPath is required');
        if (!options.config)   throw new Error('Agent config is required');

        this.#rootPath = options.rootPath;
        this.#config   = options.config;
        logger.debug(`Agent created: ${this.id} at ${this.#rootPath}`);
    }

    /**
     * Getters
     */
    get id()          { return this.#config.id; }
    get name()        { return this.#config.name; }
    get label()       { return this.#config.label || this.#config.name; }
    get description() { return this.#config.description || ''; }
    get color()       { return this.#config.color; }
    get owner()       { return this.#config.owner; }
    get llmProvider() { return this.#config.llmProvider || 'anthropic'; }
    get model()       { return this.#config.model; }
    get createdAt()   { return this.#config.createdAt; }
    get updatedAt()   { return this.#config.updatedAt; }
    get metadata()    { return this.#config.metadata || {}; }
    get agentConfig() { return this.#config.config || {}; }
    get systemPrompt(){ return this.agentConfig?.prompts?.system || ''; }
    get rootPath()    { return this.#rootPath; }
    get status()      { return this.#status; }
    get isActive()    { return this.#status === AGENT_STATUS_CODES.ACTIVE; }
    get session()     { return this.#session; }

    #homePath()    { return path.join(this.#rootPath, 'home'); }
    #runtimePath() { return path.join(this.#rootPath, 'runtime'); }

    /**
     * Lifecycle
     */
    async start() {
        if (this.isActive) return this;

        try {
            const runtimePath = this.#runtimePath();
            const authStorage = AuthStorage.create(path.join(runtimePath, 'auth.json'));

            // Inject env API keys at runtime (not persisted in auth.json)
            for (const [provider, envVar] of Object.entries(PROVIDER_ENV_KEYS)) {
                if (process.env[envVar]) {
                    authStorage.setRuntimeApiKey(provider, process.env[envVar]);
                }
            }

            // Per-agent API key from agent.json config overrides env (for built-in providers)
            const storedApiKey = this.agentConfig?.apiKey;
            if (storedApiKey) {
                authStorage.setRuntimeApiKey(this.llmProvider, storedApiKey);
            }

            // For local providers, ensure models.json exists (first-time auto-generation).
            // models.json is the SDK's native format for custom/local providers.
            // If it already exists (user may have customized it), leave it alone.
            const modelsJsonPath = path.join(runtimePath, 'models.json');
            const localDefaults = LOCAL_PROVIDER_DEFAULTS[this.llmProvider];
            if (localDefaults) {
                const exists = await access(modelsJsonPath).then(() => true).catch(() => false);
                if (!exists) {
                    await this.#writeModelsConfig(modelsJsonPath, localDefaults);
                }
            }

            // ModelRegistry reads models.json — handles local providers, compat, per-provider apiKeys.
            const modelRegistry = ModelRegistry.create(authStorage, modelsJsonPath);
            if (modelRegistry.getError()) {
                logger.warn(`models.json parse error for agent ${this.id}: ${modelRegistry.getError()}`);
            }

            // Resolve model from registry (local/custom) or built-in pi-ai catalogue.
            const modelObj = modelRegistry.find(this.llmProvider, this.model)
                || getModel(this.llmProvider, this.model);
            if (!modelObj) {
                throw new Error(
                    `Unknown model: ${this.llmProvider}/${this.model}. ` +
                    `For local providers, add a models.json to ${runtimePath}.`
                );
            }

            const sessionOptions = {
                cwd: this.#homePath(),
                agentDir: runtimePath,
                model: modelObj,
                authStorage,
                modelRegistry,
                sessionManager: SessionManager.create(this.#homePath()),
                tools: createCodingTools(this.#homePath()),
            };

            const { session } = await createAgentSession(sessionOptions);
            this.#session = session;
            this.#status = AGENT_STATUS_CODES.ACTIVE;
            this.emit('status.changed', { id: this.id, status: this.#status });
            logger.debug(`Agent started: ${this.id}`);
            return this;
        } catch (err) {
            this.#status = AGENT_STATUS_CODES.ERROR;
            this.emit('status.changed', { id: this.id, status: this.#status });
            throw err;
        }
    }

    /**
     * Write a minimal models.json for a local OpenAI-compatible provider.
     * Only called automatically if no models.json exists yet.
     * @param {string} filePath
     * @param {{ api: string, baseUrl: string, apiKey: string }} defaults
     */
    async #writeModelsConfig(filePath, defaults) {
        const config = {
            providers: {
                [this.llmProvider]: {
                    baseUrl: this.agentConfig?.baseUrl || defaults.baseUrl,
                    api: defaults.api,
                    apiKey: this.agentConfig?.apiKey || defaults.apiKey,
                    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
                    models: [{ id: this.model }],
                },
            },
        };
        await writeFile(filePath, JSON.stringify(config, null, 2));
        logger.debug(`Auto-generated models.json for agent ${this.id} (${this.llmProvider})`);
    }

    async stop() {
        if (!this.isActive) return this;

        try {
            this.#session?.agent.abort();
            await this.#session?.agent.waitForIdle();
            this.#session?.dispose();
        } catch (err) {
            logger.warn(`Error stopping agent ${this.id}: ${err.message}`);
        } finally {
            this.#session = null;
            this.#status = AGENT_STATUS_CODES.INACTIVE;
            this.emit('status.changed', { id: this.id, status: this.#status });
            logger.debug(`Agent stopped: ${this.id}`);
        }
        return this;
    }

    async restart() {
        await this.stop();
        return this.start();
    }

    /**
     * Send a prompt and wait for completion. Returns the new assistant messages.
     * @param {string} message
     * @returns {Promise<Array>}
     */
    async prompt(message) {
        if (!this.isActive) throw new Error('Agent is not active');
        const messages = [];
        const unsub = this.#session.subscribe((event) => {
            if (event.type === 'message_end' && event.message.role === 'assistant') {
                messages.push(event.message);
            }
        });
        try {
            await this.#session.prompt(message);
        } finally {
            unsub();
        }
        return messages;
    }

    /**
     * Stream a prompt. Calls onEvent for each pi-agent event.
     * @param {string} message
     * @param {Function} onEvent
     * @returns {Promise<void>}
     */
    async stream(message, onEvent) {
        if (!this.isActive) throw new Error('Agent is not active');
        const unsub = this.#session.subscribe(onEvent);
        try {
            await this.#session.prompt(message);
        } finally {
            unsub();
        }
    }

    /**
     * Abort the current operation, if any.
     */
    abort() {
        this.#session?.agent.abort();
    }

    /**
     * Update a config key in memory (persisted externally by the Agents service).
     * @param {string} key
     * @param {*} value
     */
    setConfigKey(key, value) {
        const allowed = ['label', 'description', 'color', 'llmProvider', 'model', 'metadata', 'config'];
        if (!allowed.includes(key)) throw new Error(`Config key "${key}" is not allowed`);
        this.#config[key] = value;
    }

    toJSON() {
        return {
            id: this.id,
            name: this.name,
            label: this.label,
            description: this.description,
            color: this.color,
            owner: this.owner,
            llmProvider: this.llmProvider,
            model: this.model,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            metadata: this.metadata,
            config: this.agentConfig,
            rootPath: this.#rootPath,
            status: this.#status,
            isActive: this.isActive,
        };
    }
}

export default Agent;
