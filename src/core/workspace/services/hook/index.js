'use strict';

import EventEmitter from 'eventemitter2';
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

    /**
     * Dispatch an event to all applicable hooks
     * @param {string} eventName
     * @param {Object} payload
     * @param {string} workspaceId
     */
    async dispatchEvent(eventName, payload, workspaceId) {
        logger.debug(`Dispatching event ${eventName} to ${this.#hooks.size} hooks`);

        const promises = [];
        for (const hook of this.#hooks.values()) {
            if (this.#shouldRunHook(hook, eventName, payload)) {
                promises.push(this.#runHook(hook, eventName, payload, workspaceId));
            }
        }

        await Promise.allSettled(promises);
    }

    #shouldRunHook(hook, eventName, payload) {
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
}

export default HookService;
