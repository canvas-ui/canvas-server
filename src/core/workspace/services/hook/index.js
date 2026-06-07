'use strict';

import EventEmitter from 'eventemitter2';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { createLogger } from '../../../../utils/log.js';
import LinkerHook from './internal/LinkerHook.js';

const logger = createLogger('hook-service');

/**
 * HookService
 *
 * Manages workspace hooks (both system and user-defined).
 * Listens to workspace events and dispatches them to registered hooks.
 */
class HookService extends EventEmitter {
    #workspaceManager;
    #contextManager;
    #hooks = new Map(); // hookId -> hookInstance
    #workspaceListeners = new Map();
    #recentDispatches = new Map();
    #hookModuleCache = new Map(); // hookPath -> { mtimeMs, run } | { mtimeMs: null }
    #initialized = false;

    constructor(options = {}) {
        super();
        this.#workspaceManager = options.workspaceManager;
        this.#contextManager = options.contextManager;

        if (!this.#workspaceManager || !this.#contextManager) {
            throw new Error('WorkspaceManager and ContextManager are required');
        }
    }

    async initialize() {
        if (this.#initialized) return this;

        logger.debug('HookService initializing...');

        // Register system hooks
        await this.#registerSystemHooks();

        // TODO: Load user hooks from workspace/hooks directory

        this.#initialized = true;
        logger.debug('HookService initialized');
        return this;
    }

    async #registerSystemHooks() {
        // Register LinkerHook
        const linkerHook = new LinkerHook({
            contextManager: this.#contextManager,
            workspaceManager: this.#workspaceManager
        });
        this.registerHook(linkerHook);
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
        const hookPath = path.join(workspace.hooksPath || path.join(workspace.rootPath, 'hooks'), `${eventName}.js`);

        // Resolve the hook's exported function from cache. We key on mtime so an
        // edited hook is hot-reloaded, but an unchanged hook is compiled once
        // instead of re-imported on every event (which also leaked a module into
        // the ESM registry per call).
        let stat;
        try {
            stat = fs.statSync(hookPath);
        } catch {
            return; // hook file does not exist for this event
        }

        try {
            let cached = this.#hookModuleCache.get(hookPath);
            if (!cached || cached.mtimeMs !== stat.mtimeMs) {
                const moduleUrl = `${pathToFileURL(hookPath).href}?mtime=${stat.mtimeMs}`;
                const hookModule = await import(moduleUrl);
                const run = hookModule.default || hookModule.run;

                if (typeof run !== 'function') {
                    throw new Error(`Hook "${hookPath}" does not export a function`);
                }
                cached = { mtimeMs: stat.mtimeMs, run };
                this.#hookModuleCache.set(hookPath, cached);
            }
            const run = cached.run;

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
            const update = async (id, document, options = {}) => workspace.put({ ...document, id }, options);
            const unlink = async (id, options = {}) => workspace.unlink(id, options);
            const deleteDocument = async (id) => workspace.delete(id);
            const get = async (id, options = { parse: true }) => workspace.get(id, options);
            const list = async (spec = {}) => workspace.list(spec);
            const find = async (spec = {}) => workspace.search(spec);

            await run({
                event,
                payload,
                eventName,
                workspace,
                db,
                tree,
                logger,
                emit,
                insert: put,
                update,
                remove: unlink,
                deleteDocument,
                get,
                list,
                find,
                link: async (documentId, contexts = []) => {
                    const targets = Array.isArray(contexts) ? contexts : [contexts];
                    for (const context of targets.filter(Boolean)) {
                        await workspace.link(documentId, { context, emitEvent: true });
                    }
                },
            });
        } catch (err) {
            logger.debug(`Error running workspace hook ${hookPath}: ${err.message}`);
        }
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
