'use strict';

import EventEmitter from 'eventemitter2';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createLogger } from '../../../../utils/log.js';

const logger = createLogger('hook-service');

/**
 * HookService
 *
 * Manages workspace hooks (both system and user-defined).
 * Listens to workspace events and dispatches them to registered hooks.
 */
class HookService extends EventEmitter {
    #workspaceManager;
    #agents = null;
    #messaging = null;
    #hooks = new Map(); // hookId -> hookInstance
    #workspaceListeners = new Map();
    #recentDispatches = new Map();
    #hookModuleCache = new Map(); // hookPath -> { mtimeMs, run, debounce }
    #debounce = new Map(); // key -> { timer, payloads }
    #initialized = false;

    constructor(options = {}) {
        super();
        this.#workspaceManager = options.workspaceManager;
        this.#agents = options.agents || null;

        if (!this.#workspaceManager) {
            throw new Error('WorkspaceManager is required');
        }
    }

    // ── Late-bound service wiring ───────────────────────────────────────────
    // Agents is constructed after HookService, so it is injected once available
    // rather than required up front.

    setAgents(agents) { this.#agents = agents; }
    setMessaging(messaging) { this.#messaging = messaging; }

    async initialize() {
        if (this.#initialized) return this;

        // System hooks have all been moved to seeded, user-editable example
        // hooks under git/hooks. Nothing to register in-process.
        this.#initialized = true;
        logger.debug('HookService initialized');
        return this;
    }

    registerHook(hook) {
        if (!hook || !hook.id) {
            throw new Error('Invalid hook: must have an id');
        }
        this.#hooks.set(hook.id, hook);
        logger.debug(`Registered hook: ${hook.id}`);
    }

    trackWorkspace(workspace) {
        if (!workspace?.id) {
            return;
        }

        const existing = this.#workspaceListeners.get(workspace.id);
        if (existing?.workspace === workspace) { return; }
        if (existing) { this.untrackWorkspace(workspace.id); }

        const hookService = this;
        const listener = async function (payload = {}) {
            const eventName = this.event;
            if (!eventName) { return; }
            if (payload?.source === 'hook') { return; }
            try {
                await hookService.dispatchEvent(eventName, payload, workspace.id);
            } catch (err) {
                logger.debug(`Error dispatching workspace hook event ${eventName}: ${err.message}`);
            }
        };

        workspace.on('**', listener);
        this.#workspaceListeners.set(workspace.id, { workspace, listener });
    }

    untrackWorkspace(workspaceId) {
        const binding = this.#workspaceListeners.get(workspaceId);
        if (!binding) { return; }

        binding.workspace.off('**', binding.listener);
        this.#workspaceListeners.delete(workspaceId);
    }

    /**
     * Dispatch an event to all applicable hooks
     * @param {string} eventName
     * @param {Object} payload
     * @param {string} workspaceId
     */
    async dispatchEvent(eventName, payload, workspaceId) {
        if (payload?.source === 'hook') { return; }
        if (this.#isDuplicateDispatch(eventName, payload, workspaceId)) { return; }

        logger.debug(`Dispatching event ${eventName} to ${this.#hooks.size} hooks`);

        const workspace = await this.#workspaceManager.getWorkspace(workspaceId);
        if (!workspace) {
            logger.debug(`Workspace ${workspaceId} not available for hook dispatch`);
            return;
        }

        const promises = [];
        for (const hook of this.#hooks.values()) {
            if (this.#shouldRunHook(hook, eventName)) {
                promises.push(this.#runHook(hook, eventName, payload, workspaceId));
            }
        }

        promises.push(this.#runWorkspaceHook(workspace, eventName, payload));

        await Promise.allSettled(promises);
    }

    #shouldRunHook(hook, eventName) {
        // Simple filter: if hook has 'events' array, check if eventName is in it
        // If no 'events' array, assume it wants all events (or let it filter internally)
        if (hook.events && Array.isArray(hook.events)) {
            return hook.events.includes(eventName) || hook.events.includes('*');
        }
        return true;
    }

    async #runHook(hook, eventName, payload, workspaceId) {
        try {
            logger.debug(`Running hook ${hook.id} for event ${eventName}`);
            await hook.run(eventName, payload, workspaceId);
        } catch (err) {
            logger.debug(`Error running hook ${hook.id}: ${err.message}`);
        }
    }

    async #runWorkspaceHook(workspace, eventName, payload) {
        const hooksRoot = workspace.hooksPath || path.join(workspace.rootPath, 'hooks');
        const hookFiles = this.#resolveHookFiles(hooksRoot, eventName);
        if (hookFiles.length === 0) { return; }

        await Promise.allSettled(
            hookFiles.map((hookPath) => this.#dispatchHookFile(hookPath, workspace, eventName, payload))
        );
    }

    // Collect every enabled handler for an event: the single `{event}.js` file
    // plus every `*.js` inside the `{event}/` directory. A leading underscore
    // (`_name.js`) marks a hook as disabled (the webui toggle renames it); `lib/`
    // holds shared modules and is never auto-run.
    #resolveHookFiles(hooksRoot, eventName) {
        const files = [];

        const singleFile = path.join(hooksRoot, `${eventName}.js`);
        if (this.#statFile(singleFile)) { files.push(singleFile); }

        const eventDir = path.join(hooksRoot, eventName);
        try {
            for (const entry of fs.readdirSync(eventDir, { withFileTypes: true })) {
                if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_')) {
                    files.push(path.join(eventDir, entry.name));
                }
            }
        } catch { /* no directory for this event */ }

        return files;
    }

    #statFile(filePath) {
        try {
            const stat = fs.statSync(filePath);
            return stat.isFile() ? stat : null;
        } catch {
            return null;
        }
    }

    // Resolve a hook's exported function (and its optional `debounce` window)
    // from cache, keyed on mtime so an edited hook is hot-reloaded but an
    // unchanged hook is compiled once (re-importing on every event also leaks a
    // module into the ESM registry per call).
    async #loadHookRun(hookPath) {
        const stat = this.#statFile(hookPath);
        if (!stat) { return null; }

        let cached = this.#hookModuleCache.get(hookPath);
        if (!cached || cached.mtimeMs !== stat.mtimeMs) {
            const moduleUrl = `${pathToFileURL(hookPath).href}?mtime=${stat.mtimeMs}`;
            const hookModule = await import(moduleUrl);
            const run = hookModule.default || hookModule.run;
            if (typeof run !== 'function') {
                throw new Error(`Hook "${hookPath}" does not export a function`);
            }
            const debounce = Number(hookModule.debounce) > 0 ? Number(hookModule.debounce) : 0;
            cached = { mtimeMs: stat.mtimeMs, run, debounce };
            this.#hookModuleCache.set(hookPath, cached);
        }
        return cached;
    }

    async #dispatchHookFile(hookPath, workspace, eventName, payload) {
        let loaded;
        try {
            loaded = await this.#loadHookRun(hookPath);
        } catch (err) {
            logger.debug(`Error loading workspace hook ${hookPath}: ${err.message}`);
            return;
        }
        if (!loaded) { return; }

        if (loaded.debounce > 0) {
            this.#scheduleDebounced(hookPath, workspace, eventName, payload, loaded);
            return;
        }

        const context = this.#buildHookContext(workspace, eventName, payload);
        await this.#invokeHook(loaded.run, context, hookPath);
    }

    // Coalesce a burst of events (e.g. N singleton inserts the app didn't batch)
    // into a single run carrying every payload in `context.payloads`, so an
    // agent()-driven categorizer fires once per burst, not once per document.
    #scheduleDebounced(hookPath, workspace, eventName, payload, loaded) {
        const key = `${workspace.id}::${eventName}::${hookPath}`;
        let entry = this.#debounce.get(key);
        if (!entry) { entry = { payloads: [] }; this.#debounce.set(key, entry); }
        entry.payloads.push(payload);

        if (entry.timer) { clearTimeout(entry.timer); }
        entry.timer = setTimeout(() => {
            this.#debounce.delete(key);
            const payloads = entry.payloads;
            const context = this.#buildHookContext(workspace, eventName, payloads[payloads.length - 1]);
            context.payloads = payloads;
            context.event.payloads = payloads;
            this.#invokeHook(loaded.run, context, hookPath);
        }, loaded.debounce);
        if (entry.timer.unref) { entry.timer.unref(); }
    }

    async #invokeHook(run, context, hookPath) {
        try {
            await run(context);
        } catch (err) {
            logger.debug(`Error running workspace hook ${hookPath}: ${err.message}`);
        }
    }

    #buildHookContext(workspace, eventName, payload) {
        const event = {
            name: eventName,
            workspaceId: workspace.id,
            payload,
            timestamp: new Date().toISOString(),
        };

        const db = workspace.isActive ? workspace.db : null;
        const tree = workspace.isActive ? workspace.getDefaultContextTree() : null;
        const emit = async (name, nextPayload = {}) => {
            workspace.emit(name, {
                ...(nextPayload && typeof nextPayload === 'object' ? nextPayload : { value: nextPayload }),
                workspaceId: workspace.id,
                source: 'hook',
            });
        };
        const put = async (document, options = {}) => workspace.put(document, options);

        return {
            event,
            payload,
            payloads: [payload], // debounced runs replace this with the coalesced burst
            eventName,
            workspace,
            db,
            tree,
            logger,
            emit,
            insert: put,
            update: async (id, document, options = {}) => workspace.put({ ...document, id }, options),
            remove: async (id, options = {}) => workspace.unlink(id, options),
            deleteDocument: async (id) => workspace.delete(id),
            get: async (id, options = { parse: true }) => workspace.get(id, options),
            list: async (spec = {}) => workspace.list(spec),
            find: async (spec = {}) => workspace.search(spec),
            agent: this.#buildAgentHelper(workspace),
            notify: this.#buildNotifyHelper(workspace),
            link: async (documentId, contexts = []) => {
                const targets = Array.isArray(contexts) ? contexts : [contexts];
                for (const context of targets.filter(Boolean)) {
                    await workspace.link(documentId, { context, emitEvent: true });
                }
            },
        };
    }

    // Pure-function agent call: start the agent if needed, prompt it, return text.
    // Returns null (and logs) instead of throwing so a hook keeps running.
    #buildAgentHelper(workspace) {
        return async (slugOrId, prompt, options = {}) => {
            if (!this.#agents) {
                logger.debug('Hook agent() called but no agents service is wired');
                return null;
            }
            try {
                return await this.#agents.prompt(workspace.owner, slugOrId, prompt, options);
            } catch (err) {
                logger.debug(`Hook agent(${slugOrId}) failed: ${err.message}`);
                return null;
            }
        };
    }

    // Deliver a message to the workspace owner over a bound channel
    // (Slack/WhatsApp/console). Returns null instead of throwing so a hook
    // keeps running when no channel is configured.
    #buildNotifyHelper(workspace) {
        return async (message, options = {}) => {
            if (!this.#messaging) {
                logger.debug('Hook notify() called but no messaging service is wired');
                return null;
            }
            try {
                return await this.#messaging.notify(workspace.owner, message, options);
            } catch (err) {
                logger.debug(`Hook notify() failed: ${err.message}`);
                return null;
            }
        };
    }

    #isDuplicateDispatch(eventName, payload = {}, workspaceId) {
        const key = this.#buildDispatchKey(eventName, payload, workspaceId);
        if (!key) { return false; }
        const now = Date.now();
        for (const [entryKey, timestamp] of this.#recentDispatches) {
            if (now - timestamp > 1000) {
                this.#recentDispatches.delete(entryKey);
            }
        }
        if (this.#recentDispatches.has(key)) {
            logger.debug(`Skipping duplicate hook event ${eventName} for workspace ${workspaceId}`);
            return true;
        }
        this.#recentDispatches.set(key, now);
        return false;
    }

    #buildDispatchKey(eventName, payload = {}, workspaceId) {
        const ids = payload.ids || payload.documentIds || payload.id || payload.documentId || payload.document?.id || '';
        const normalizedIds = Array.isArray(ids) ? ids.join(',') : String(ids || '');
        if (!normalizedIds) { return null; }
        return `${workspaceId}:${eventName}:${normalizedIds}:${payload.source || ''}`;
    }
}

export default HookService;
