'use strict';

import path from 'path';
import { writeFile, readFile, access } from 'fs/promises';
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
import { createCanvasTools } from './tools/index.js';

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

const LOCAL_MODEL_INPUT = ['text', 'image'];

export const AGENT_SESSION_MODES = {
    EXPERIMENTAL: 'experimental',
    PERSISTENT: 'persistent',
    INCOGNITO: 'incognito',
};

function normalizeSlug(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export function sanitizeAgentData(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeAgentData(entry));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value)
            .filter(([key]) => key !== 'apiKey')
            .map(([key, entry]) => [key, sanitizeAgentData(entry)])
    );
}

function getAgentSessionDir(agentDir) {
    return path.join(agentDir, 'sessions');
}

function normalizeSessionMode(mode) {
    if (mode === AGENT_SESSION_MODES.EXPERIMENTAL) {
        return AGENT_SESSION_MODES.EXPERIMENTAL;
    }
    return mode === AGENT_SESSION_MODES.INCOGNITO
        ? AGENT_SESSION_MODES.INCOGNITO
        : AGENT_SESSION_MODES.PERSISTENT;
}

function normalizeSessionConfig(config = {}) {
    const mode = normalizeSessionMode(config.mode);
    const experimentalPath = config.experimentalPath || null;
    const pathValue = config.path || config.sessionPath || (mode === AGENT_SESSION_MODES.EXPERIMENTAL ? experimentalPath : null);
    return {
        mode,
        ...(mode !== AGENT_SESSION_MODES.INCOGNITO && pathValue ? { path: pathValue } : {}),
        ...(experimentalPath ? { experimentalPath } : {}),
    };
}

function serializeSessionInfo(info, currentPath, mode, experimentalPath) {
    const slug = normalizeSlug(info.name);
    return {
        id: info.id,
        slug: slug || info.id,
        path: info.path,
        cwd: info.cwd,
        name: info.name,
        parentSessionPath: info.parentSessionPath,
        createdAt: info.created.toISOString(),
        updatedAt: info.modified.toISOString(),
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
        allMessagesText: info.allMessagesText,
        isCurrent: mode !== AGENT_SESSION_MODES.INCOGNITO && info.path === currentPath,
        isExperimental: Boolean(experimentalPath && info.path === experimentalPath),
    };
}

async function persistSessionManager(sessionManager) {
    const sessionFile = sessionManager.getSessionFile();
    const header = sessionManager.getHeader();
    if (!sessionFile || !header) return;

    const entries = sessionManager.getEntries();
    const content = [header, ...entries].map((entry) => JSON.stringify(entry)).join('\n');
    await writeFile(sessionFile, `${content}\n`);
}

function resolveSessionInfo(sessions, sessionIdentifier) {
    const identifier = String(sessionIdentifier || '');
    const identifierSlug = normalizeSlug(identifier);
    return sessions.find((session) => (
        session.id === identifier
        || (identifierSlug && normalizeSlug(session.name) === identifierSlug)
    ));
}

function ensureUniqueSessionSlug(sessions, name, currentSessionId = null) {
    const slug = normalizeSlug(name);
    if (!slug) return;
    const duplicate = sessions.find((session) => (
        session.id !== currentSessionId
        && normalizeSlug(session.name) === slug
    ));
    if (duplicate) throw new Error(`Session name already exists: ${name}`);
}

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
    get access()      { return this.#config.access || null; }
    get agentConfig() { return this.#config.config || {}; }
    get systemPrompt(){ return this.agentConfig?.prompts?.system || ''; }
    get rootPath()    { return this.#rootPath; }
    get status()      { return this.#status; }
    get isActive()    { return this.#status === AGENT_STATUS_CODES.ACTIVE; }
    get isProcessing(){ return Boolean(this.#session?.isStreaming); }
    get session()     { return this.#session; }
    get sessionConfig() { return normalizeSessionConfig(this.agentConfig?.session); }

    #homePath()    { return path.join(this.#rootPath, 'home'); }
    #runtimePath() { return path.join(this.#rootPath, 'runtime'); }
    #sessionDir() { return getAgentSessionDir(this.#runtimePath()); }
    async #resolveExperimentalPath(sessionConfig = this.sessionConfig) {
        if (sessionConfig.experimentalPath) {
            return sessionConfig.experimentalPath;
        }

        const sessionManager = SessionManager.create(this.#homePath(), this.#sessionDir());
        sessionManager.appendSessionInfo('Experimental');
        await persistSessionManager(sessionManager);
        return sessionManager.getSessionFile();
    }

    #sessionManager(config = this.sessionConfig) {
        if (config.mode === AGENT_SESSION_MODES.INCOGNITO) {
            return SessionManager.inMemory(this.#homePath());
        }
        if (config.path) {
            return SessionManager.open(config.path, this.#sessionDir(), this.#homePath());
        }
        return SessionManager.continueRecent(this.#homePath(), this.#sessionDir());
    }

    /**
     * Lifecycle
     */
    /**
     * @param {Object} [options]
     * @param {Object|null} [options.canvasEnv] - Runtime env for canvas tools
     *   ({ CANVAS_URL, CANVAS_TOKEN, CANVAS_WORKSPACE, CANVAS_BASE_PATH, ... });
     *   null/absent = unbound agent, no canvas tools.
     */
    async start(options = {}) {
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
                await this.#ensureLocalModelsConfig(modelsJsonPath, localDefaults);
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

            // Canvas tools only for bound agents with an explicit runtime env;
            // gated off via config.tools.canvas.enabled = false.
            const canvasToolsEnabled = this.agentConfig?.tools?.canvas?.enabled !== false;
            const canvasTools = options.canvasEnv && canvasToolsEnabled
                ? createCanvasTools(options.canvasEnv)
                : [];

            const sessionOptions = {
                cwd: this.#homePath(),
                agentDir: runtimePath,
                model: modelObj,
                authStorage,
                modelRegistry,
                sessionManager: this.#sessionManager(),
                tools: [...createCodingTools(this.#homePath()), ...canvasTools],
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
                    models: [{ id: this.model, input: LOCAL_MODEL_INPUT }],
                },
            },
        };
        await writeFile(filePath, JSON.stringify(config, null, 2));
        logger.debug(`Auto-generated models.json for agent ${this.id} (${this.llmProvider})`);
    }

    async #ensureLocalModelsConfig(filePath, defaults) {
        const exists = await access(filePath).then(() => true).catch(() => false);
        if (!exists) {
            await this.#writeModelsConfig(filePath, defaults);
            return;
        }

        let config;
        try {
            config = JSON.parse(await readFile(filePath, 'utf8'));
        } catch {
            return;
        }
        const model = config?.providers?.[this.llmProvider]?.models?.find((entry) => entry?.id === this.model);
        if (!model || model.input?.includes('image')) return;

        model.input = Array.isArray(model.input) ? [...new Set([...model.input, 'image'])] : LOCAL_MODEL_INPUT;
        await writeFile(filePath, JSON.stringify(config, null, 2));
        logger.debug(`Enabled image input for ${this.llmProvider}/${this.model} in models.json`);
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
    async prompt(message, options = {}) {
        if (!this.isActive) throw new Error('Agent is not active');
        const messages = [];
        const unsub = this.#session.subscribe((event) => {
            if (event.type === 'message_end' && event.message.role === 'assistant') {
                messages.push(event.message);
            }
        });
        try {
            await this.#session.prompt(message, {
                ...(Array.isArray(options.images) && options.images.length > 0
                    ? { images: options.images }
                    : {}),
                ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
            });
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
    async stream(message, onEvent, options = {}) {
        if (!this.isActive) throw new Error('Agent is not active');
        const unsub = this.#session.subscribe(onEvent);
        try {
            await this.#session.prompt(message, {
                ...(Array.isArray(options.images) && options.images.length > 0
                    ? { images: options.images }
                    : {}),
                ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
            });
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
        const allowed = ['name', 'label', 'description', 'color', 'llmProvider', 'model', 'metadata', 'config', 'access'];
        if (!allowed.includes(key)) throw new Error(`Config key "${key}" is not allowed`);
        this.#config[key] = value;
    }

    getCurrentSessionSelection() {
        const sessionConfig = this.sessionConfig;
        if (sessionConfig.mode === AGENT_SESSION_MODES.INCOGNITO && !this.#session?.sessionManager) {
            return { mode: sessionConfig.mode };
        }
        const sessionManager = this.#session?.sessionManager || this.#sessionManager(sessionConfig);
        return {
            mode: sessionConfig.mode,
            sessionId: sessionManager.getSessionId(),
            ...(sessionConfig.mode === AGENT_SESSION_MODES.PERSISTENT
                || sessionConfig.mode === AGENT_SESSION_MODES.EXPERIMENTAL
                ? { path: sessionManager.getSessionFile() || sessionConfig.path }
                : {}),
        };
    }

    getSessionContext() {
        const sessionSelection = this.getCurrentSessionSelection();
        if (sessionSelection.mode === AGENT_SESSION_MODES.INCOGNITO && !this.#session?.sessionManager) {
            return {
                mode: sessionSelection.mode,
                messages: [],
                thinkingLevel: 'high',
                model: null,
            };
        }
        const sessionManager = this.#session?.sessionManager || this.#sessionManager(this.sessionConfig);
        const context = sessionManager.buildSessionContext();
        return {
            mode: sessionSelection.mode,
            sessionId: sessionSelection.sessionId,
            sessionFile: sessionSelection.path,
            messages: context.messages,
            thinkingLevel: context.thinkingLevel,
            model: context.model,
        };
    }

    async listSessions() {
        const sessionConfig = this.sessionConfig;
        const currentPath = this.getCurrentSessionSelection().path;
        const experimentalPath = sessionConfig.experimentalPath || null;
        const sessions = await SessionManager.list(this.#homePath(), this.#sessionDir());

        return {
            mode: sessionConfig.mode,
            currentSessionId: this.getCurrentSessionSelection().sessionId,
            currentSessionPath: currentPath,
            sessions: sessions.map((info) => serializeSessionInfo(info, currentPath, sessionConfig.mode, experimentalPath)),
        };
    }

    async createSession(options = {}) {
        const mode = normalizeSessionMode(options.mode);
        if (mode === AGENT_SESSION_MODES.INCOGNITO) {
            return { mode };
        }
        if (mode === AGENT_SESSION_MODES.EXPERIMENTAL) {
            const experimentalPath = await this.#resolveExperimentalPath();
            return {
                mode,
                path: experimentalPath,
                experimentalPath,
            };
        }

        const sessionManager = SessionManager.create(this.#homePath(), this.#sessionDir());
        if (typeof options.name === 'string' && options.name.trim()) {
            const sessions = await SessionManager.list(this.#homePath(), this.#sessionDir());
            ensureUniqueSessionSlug(sessions, options.name);
            sessionManager.appendSessionInfo(options.name);
        }
        await persistSessionManager(sessionManager);

        return {
            mode,
            path: sessionManager.getSessionFile(),
            experimentalPath: this.sessionConfig.experimentalPath || null,
        };
    }

    async selectSession(options = {}) {
        const mode = normalizeSessionMode(options.mode);
        if (mode === AGENT_SESSION_MODES.INCOGNITO) {
            return { mode };
        }
        if (mode === AGENT_SESSION_MODES.EXPERIMENTAL) {
            const experimentalPath = await this.#resolveExperimentalPath();
            return {
                mode,
                path: experimentalPath,
                experimentalPath,
            };
        }
        if (!options.sessionId) {
            return {
                mode,
                experimentalPath: this.sessionConfig.experimentalPath || null,
            };
        }

        const sessions = await SessionManager.list(this.#homePath(), this.#sessionDir());
        const selected = resolveSessionInfo(sessions, options.sessionId);
        if (!selected) {
            throw new Error(`Session not found: ${options.sessionId}`);
        }

        return {
            mode,
            path: selected.path,
            experimentalPath: this.sessionConfig.experimentalPath || null,
        };
    }

    async renameSession(options = {}) {
        if (!options.sessionId) throw new Error('Session ID is required');
        if (typeof options.name !== 'string' || !options.name.trim()) {
            throw new Error('Session name is required');
        }

        const sessions = await SessionManager.list(this.#homePath(), this.#sessionDir());
        const selected = resolveSessionInfo(sessions, options.sessionId);
        if (!selected) throw new Error(`Session not found: ${options.sessionId}`);
        ensureUniqueSessionSlug(sessions, options.name, selected.id);

        const sessionManager = SessionManager.open(selected.path, this.#sessionDir(), this.#homePath());
        sessionManager.appendSessionInfo(options.name.trim());
        await persistSessionManager(sessionManager);
    }

    async deleteSession(options = {}) {
        if (!options.sessionId) throw new Error('Session ID is required');

        const sessionConfig = this.sessionConfig;
        const sessions = await SessionManager.list(this.#homePath(), this.#sessionDir());
        const selected = resolveSessionInfo(sessions, options.sessionId);
        if (!selected) throw new Error(`Session not found: ${options.sessionId}`);
        if (sessionConfig.experimentalPath && selected.path === sessionConfig.experimentalPath) {
            throw new Error('Experimental session cannot be deleted');
        }

        const currentSelection = this.getCurrentSessionSelection();
        const currentDeleted = currentSelection.path === selected.path;
        const wasActive = this.isActive;
        if (currentDeleted && wasActive) {
            await this.stop();
        }

        await unlink(selected.path);

        return {
            deletedSessionId: selected.id,
            currentDeleted,
            wasActive,
            session: {
                mode: currentDeleted ? AGENT_SESSION_MODES.PERSISTENT : sessionConfig.mode,
                path: currentDeleted ? null : sessionConfig.path || null,
                experimentalPath: sessionConfig.experimentalPath || null,
            },
        };
    }

    toJSON() {
        return sanitizeAgentData({
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
            access: this.access,
            config: this.agentConfig,
            rootPath: this.#rootPath,
            status: this.#status,
            isActive: this.isActive,
        });
    }
}

export default Agent;
