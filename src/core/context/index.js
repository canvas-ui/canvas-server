'use strict';

// Utils
import Url from './lib/Url.js';
import EventEmitter from 'eventemitter2';

// Logging
import { createLogger } from '../../utils/log.js';
const logger = createLogger('context-manager:index');

// Includes
import Context from './lib/Context.js';
import { accessDenied, contextNotFound, workspaceNotReady } from './lib/errors.js';
import { compareByUserOrder } from '../../utils/list-order.js';

/**
 * Context Manager
 *
 * Contexts are user-local (owned by a userId, may point at any of the user's
 * workspaces). Persistence is one index file per user
 * (db/users/<userId>/contexts.json, key = contextId) opened lazily through
 * the shared Jim factory.
 */

class ContextManager extends EventEmitter {

    #indexFactory;           // Jim instance — per-user context index files
    #userIndexes = new Map();// userId -> Conf
    #workspaceManager;       // Reference to workspace manager

    // Runtime
    #contexts = new Map();   // In-memory cache of loaded contexts (key: userId/contextId)
    #initialized = false;    // Manager initialized flag

    /**
     * Create a new ContextManager
     * @param {Object} options - Manager options
     * @param {Object} options.indexFactory - Jim instance for per-user index files
     * @param {Object} options.workspaceManager - Workspace manager instance
     */
    constructor(options = {}) {
        // Ensure wildcard events are enabled so WebSocket bridge can listen to "**"
        // Provide default delimiter "." to match our dot-notation events
        super({
            wildcard: true,
            delimiter: '.',
            newListener: false,
            maxListeners: 100,
            ...(options.eventEmitterOptions || {})
        });

        if (!options.indexFactory) {
            throw new Error('indexFactory (jim) is required for ContextManager');
        }
        if (!options.workspaceManager) {
            throw new Error('WorkspaceManager is required for ContextManager');
        }

        this.#indexFactory = options.indexFactory;
        this.#workspaceManager = options.workspaceManager;

        logger.debug('Context manager created');
    }

    /**
     * Initialize manager
     */
    async initialize() {
        if (this.#initialized) { return this; }
        this.#initialized = true;
        logger.debug('ContextManager initialized (per-user index files)');
        return this;
    }

    /**
     * Per-user store helpers
     */

    #getUserIndex(userId) {
        if (!this.#userIndexes.has(userId)) {
            this.#userIndexes.set(userId, this.#indexFactory.getOrCreateIndex('contexts', { scope: `users/${userId}` }));
        }
        return this.#userIndexes.get(userId);
    }

    #userStore(userId) {
        return this.#getUserIndex(userId).store || {};
    }

    #storeHas(userId, contextId) {
        return this.#getUserIndex(userId).has(this.#sanitizeContextId(contextId.toString()));
    }

    #storeGet(userId, contextId) {
        return this.#getUserIndex(userId).get(this.#sanitizeContextId(contextId.toString())) || null;
    }

    #storeSet(userId, contextId, data) {
        this.#getUserIndex(userId).set(this.#sanitizeContextId(contextId.toString()), data);
    }

    #storeDelete(userId, contextId) {
        this.#getUserIndex(userId).delete(this.#sanitizeContextId(contextId.toString()));
    }

    #knownUserIds() {
        const ids = new Set(this.#userIndexes.keys());
        for (const id of Object.keys(this.#workspaceManager.users?.indexStore?.store || {})) {
            ids.add(id);
        }
        return ids;
    }

    // Iterate every [userId, contextId, data] across all per-user indexes.
    *#allEntries() {
        for (const userId of this.#knownUserIds()) {
            const store = this.#userStore(userId);
            for (const contextId in store) {
                if (store[contextId]) yield [userId, contextId, store[contextId]];
            }
        }
    }

    /**
     * Getters
     */

    get contexts() { return Array.from(this.#contexts.values()); }

    /**
     * Context Management API
     */

    /**
     * Create a new context for a user
     * @param {string} userId - User ID
     * @param {string} url - Context URL
     * @param {Object} options - Context options
     * @param {string|number} [options.id] - Custom context ID
     * @returns {Promise<Context>} Created context
     */
    async createContext(userId, url = '/', options = {}) {
        if (!this.#initialized) {
            throw new Error('ContextManager not initialized');
        }

        if (!userId) {
            throw new Error('User ID is required to create a context');
        }

        if (!options.id) {
            throw new Error('Context ID is required to create a context');
        }

        try {
            let contextId = options.id;
            contextId = this.#sanitizeContextId(contextId);

            // Lets get the context key
            const contextKey = this.#constructContextKey(userId, contextId);

            if (this.#contexts.has(contextKey) || this.#storeHas(userId, contextId)) {
                throw new Error(`Context with key ${contextKey} already exists`);
            }

            const parsed = new Url(url);

            // Determine workspace ID
            let workspaceId;

            // If options.workspaceId is provided (from API), use it directly (UUID) or resolve if it's a name
            if (options.workspaceId) {
                workspaceId = options.workspaceId;
                // Allow callers to pass a workspace name (e.g. "Work") instead of UUID
                if (workspaceId && (workspaceId.includes(':') || workspaceId.length < 12)) {
                    workspaceId = this.#workspaceManager.resolveWorkspaceId(userId, workspaceId) || workspaceId;
                }
            }
            // Otherwise, resolve from the URL's workspace part
            else if (parsed.workspaceId) {
                workspaceId = this.#workspaceManager.resolveWorkspaceId(userId, parsed.workspaceId);
            }
            // There is no special default workspace anymore: fall back to the
            // user's primary workspace (first in their explicit ordering). A
            // user can legitimately have zero workspaces — surface that clearly.
            else {
                const owned = (await this.#workspaceManager.listWorkspaces(userId))
                    .filter((ws) => ws.owner === userId);
                if (owned.length === 0) {
                    throw new Error(`Cannot create context: user ${userId} has no workspaces`);
                }
                workspaceId = owned[0].id; // listWorkspaces is user-order sorted
            }

            if (!workspaceId) {
                throw new Error(`Workspace not found for user ${userId}`);
            }

            const workspace = await this.#workspaceManager.getWorkspace(workspaceId, userId);
            if (!workspace) {
                throw new Error(`Workspace not found or not accessible: ${parsed.workspaceId || workspaceId} for user ${userId}`);
            }

            // Ensure workspace is running
            if (!workspace.isActive) {
                await workspace.start();
            }

            // Resolve treeId from treeType when no explicit treeId was provided.
            // 'context' → workspace's default context tree (named "context", type=context)
            // 'directory' → workspace's default directory tree (named "directory", type=directory)
            let resolvedTreeId = options.treeId || null;
            if (!resolvedTreeId && options.treeType) {
                try {
                    const tree = options.treeType === 'directory'
                        ? workspace.getDefaultDirectoryTree()
                        : workspace.getDefaultContextTree();
                    resolvedTreeId = tree?.id || null;
                } catch (e) {
                    logger.debug(`Failed to resolve ${options.treeType} tree: ${e.message}`);
                }
            }

            const contextOptions = {
                ...options,
                id: contextId.toString(),
                userId: userId,
                workspace: workspace,
                workspaceId: workspace.id,
                workspaceManager: this.#workspaceManager,
                contextManager: this,
                treeId: resolvedTreeId,
            };

            const context = new Context(parsed.url, contextOptions);
            await context.initialize();

            this.saveContext(userId, context);

            // Emit the context.created event with a consistent payload structure including id
            const contextData = context.toJSON();
            this.emit('context.created', { id: context.id, ...contextData });
            logger.debug(`Context created with ID ${context.id} and emitted context.created event`);

            return context;
        } catch (error) {
            logger.debug(`Error creating context: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get a context by ID for a user
     * @param {string} userId - User ID of the person trying to access the context
     * @param {string|number} contextIdOrFullIdentifier - Context ID (e.g., 'default', 'myContext') or a full identifier for a shared context (e.g., 'owner@email.com/contextName').
     * @param {Object} options - Options
     * @param {boolean} [options.autoCreate=false] - Whether to auto-create the context if it doesn't exist. This only applies if the context is for the accessing userId.
     * @param {string} [options.url='/'] - URL to use when auto-creating
     * @returns {Promise<Context>} Context instance
     */
    async getContext(userId, contextIdOrFullIdentifier, options = {}) {
        if (!this.#initialized) {
            throw new Error('ContextManager not initialized');
        }
        if (!userId) {
            throw new Error('User ID (accessing user) is required');
        }

        let { ownerUserId, contextId } = this.#parseContextIdentifier(contextIdOrFullIdentifier, userId);

        // Auto-creation should only happen if the accessing user is the owner.
        // And if the contextId is not a shared context identifier.
        const canAutoCreate = options.autoCreate
            && ownerUserId === userId &&
            !contextIdOrFullIdentifier.toString().includes('/');

        let contextKey = this.#constructContextKey(ownerUserId, contextId);
        let storedContextData = this.#storeGet(ownerUserId, contextId);

        // Backward-compat for older mixed-case IDs: try to locate by case-insensitive match.
        // (We now canonicalize IDs to lowercase.)
        if (!this.#contexts.has(contextKey) && !storedContextData) {
            // 1) In-memory
            const ownerPrefix = ownerUserId ? `${ownerUserId}/` : null;
            for (const [key, instance] of this.#contexts) {
                if (ownerPrefix && !key.startsWith(ownerPrefix)) continue;
                if ((instance?.id || '').toString().toLowerCase() === contextId) {
                    contextKey = key;
                    break;
                }
            }

            // 2) Persistent store (owner's index file)
            if (!this.#contexts.has(contextKey)) {
                const ownerStore = ownerUserId ? this.#userStore(ownerUserId) : {};
                for (const data of Object.values(ownerStore)) {
                    if ((data?.id || '').toString().toLowerCase() === contextId) {
                        storedContextData = data;
                        contextKey = this.#constructContextKey(ownerUserId, data.id);
                        break;
                    }
                }
            }
        }

        // Check if it's a shared context owned by someone else
        if (ownerUserId === userId && !this.#contexts.has(contextKey) && !storedContextData) {
            for (const [entryUserId, , contextData] of this.#allEntries()) {
                if (contextData.id === contextId && contextData.userId !== userId) {
                    const hasAccess = await this.#checkContextAccess(contextData, userId);
                    if (hasAccess) {
                        ownerUserId = contextData.userId || entryUserId;
                        storedContextData = contextData;
                        contextKey = this.#constructContextKey(ownerUserId, contextData.id);
                        break;
                    }
                }
            }
        }

        let contextInstance = null;

            if (this.#contexts.has(contextKey)) {
                contextInstance = this.#contexts.get(contextKey);
            } else if (storedContextData) {
                if (storedContextData.userId !== ownerUserId) {
                    throw accessDenied(`Owner mismatch: expected ${ownerUserId}, found ${storedContextData.userId}`);
                }

                let workspaceId = storedContextData.workspaceId;
                if (workspaceId && (workspaceId.includes(':') || workspaceId.length < 12)) {
                     const resolvedId = this.#workspaceManager.resolveWorkspaceId(ownerUserId, workspaceId);
                     if (resolvedId) workspaceId = resolvedId;
                }

                // Resolve the workspace; a permanently missing workspace marks
                // the context orphaned (its workspace was deleted or moved away)
                // instead of failing opaquely.
                let workspace = null;
            void workspace;
                try {
                    workspace = await this.#workspaceManager.getWorkspaceOrThrow(workspaceId, ownerUserId);
                } catch (err) {
                    if (err?.code === 'WORKSPACE_NOT_FOUND') {
                        this.#markContextOrphaned(ownerUserId, storedContextData);
                        throw workspaceNotReady(`Context ${contextKey} is orphaned: workspace ${storedContextData.workspaceName || workspaceId} is gone`);
                    }
                    throw workspaceNotReady(`Failed to load workspace ${storedContextData.workspaceId} for context ${contextKey}: ${err.message}`);
                }

                // Workspaces start on demand — there is no login-time universe
                // auto-start anymore (Context constructor needs workspace.db and
                // a bound context tree).
                if (!workspace.isActive) {
                    try {
                        await workspace.start();
                    } catch (err) {
                        throw workspaceNotReady(`Workspace ${workspace.name} could not be started: ${err.message}`);
                    }
                }

                // Workspace is back — clear a stale orphan flag lazily
                if (storedContextData.status === 'orphaned') {
                    const { _status, _orphanedAt, ...clean } = storedContextData;
                    this.#storeSet(ownerUserId, storedContextData.id, clean);
                    storedContextData = clean;
                }

                const contextOptions = {
                    ...storedContextData,
                    userId: ownerUserId,
                    workspace: workspace,
                    workspaceManager: this.#workspaceManager,
                    contextManager: this,
                };

                const loadedContext = new Context(storedContextData.url, contextOptions);
                await loadedContext.initialize();

                this.#contexts.set(contextKey, loadedContext);
                this.#setupEventForwarding(loadedContext);

                contextInstance = loadedContext;
            }

            if (contextInstance) {
                if (userId !== contextInstance.userId) {
                    if (!contextInstance.checkPermission(userId, 'documentRead')) {
                        throw accessDenied(`Access denied: user ${userId} lacks permission for context ${contextKey}`);
                    }
                }
                return contextInstance;
            }

            if (canAutoCreate) {
                const createOptions = { ...options, id: contextId.toString() };
                return this.createContext(userId, options.url || '/', createOptions);
            }

            throw contextNotFound(`Context not found: ${contextKey}`);
    }

    hasContext(userId, contextIdOrFullIdentifier) {
        if (!this.#initialized) {
            throw new Error('ContextManager not initialized');
        }
        const { ownerUserId, contextId } = this.#parseContextIdentifier(contextIdOrFullIdentifier, userId);
        const contextKey = this.#constructContextKey(ownerUserId, contextId);
        // This check doesn't verify permissions, just existence.
        // For a true "has access" check, getContext would be needed.
        return this.#contexts.has(contextKey) || this.#storeHas(ownerUserId, contextId);
    }

    /**
     * Find a context by ID across all users (for sharing/pub access)
     * @param {string} contextId - Context ID to find
     * @returns {Promise<Object|null>} Context metadata if found, null otherwise
     */
    async findContextById(contextId) {
        if (!this.#initialized) {
            throw new Error('ContextManager not initialized');
        }
        if (!contextId) {
            throw new Error('Context ID is required');
        }

        try {
            // Search in-memory cache first
            for (const [contextKey, contextInstance] of this.#contexts) {
                if (contextInstance.id === contextId) {
                    return {
                        contextKey,
                        contextData: contextInstance.toJSON(),
                        userId: contextInstance.userId
                    };
                }
            }

            // Search persistent stores
            for (const [entryUserId, , contextData] of this.#allEntries()) {
                if (contextData.id === contextId) {
                    return {
                        contextKey: this.#constructContextKey(contextData.userId || entryUserId, contextData.id),
                        contextData,
                        userId: contextData.userId || entryUserId
                    };
                }
            }

            return null;
        } catch (error) {
            logger.debug(`Error finding context by ID ${contextId}: ${error.message}`);
            return null;
        }
    }

    /**
     * List all contexts for a user
     * @param {string} userId - User ID
     * @returns {Promise<Array<Object>>} Array of context metadata
     */
    async listUserContexts(userId) {
        if (!this.#initialized) throw new Error('ContextManager not initialized');
        if (!userId) throw new Error('User ID is required');

        try {
            const userContextsArray = [];
            const processedKeys = new Set();

            const ownedPrefix = `${userId}/`;
            for (const [key, contextInstance] of this.#contexts) {
                if (key.startsWith(ownedPrefix)) {
                    try {
                        const ownerUser = await this.#workspaceManager.users.get(contextInstance.userId);
                        userContextsArray.push({
                            ...contextInstance.toJSON(),
                            ownerEmail: ownerUser.email
                        });
                    } catch  {
                        userContextsArray.push(contextInstance.toJSON());
                    }
                    processedKeys.add(key);
                }
            }

            {
                for (const [entryUserId, entryContextId, storedContextData] of this.#allEntries()) {
                    const key = this.#constructContextKey(entryUserId, entryContextId);
                    if (processedKeys.has(key)) continue;
                    if (!storedContextData) continue;

                    const storedWorkspaceActive = await this.#resolveWorkspaceActive(storedContextData);

                    if (key.startsWith(ownedPrefix)) {
                        try {
                            const ownerUser = await this.#workspaceManager.users.get(storedContextData.userId);
                            userContextsArray.push({
                                ...storedContextData,
                                workspaceActive: storedWorkspaceActive,
                                ownerEmail: ownerUser.email
                            });
                        } catch  {
                            userContextsArray.push({ ...storedContextData, workspaceActive: storedWorkspaceActive });
                        }
                        processedKeys.add(key);
                    } else {
                        const hasAccess = await this.#checkContextAccess(storedContextData, userId);

                        if (hasAccess) {
                            try {
                                const ownerUser = await this.#workspaceManager.users.get(storedContextData.userId);
                                userContextsArray.push({
                                    ...storedContextData,
                                    workspaceActive: storedWorkspaceActive,
                                    ownerEmail: ownerUser.email,
                                    type: 'shared',
                                    isShared: true
                                });
                            } catch  {
                                userContextsArray.push({
                                    ...storedContextData,
                                    workspaceActive: storedWorkspaceActive,
                                    type: 'shared',
                                    isShared: true
                                });
                            }
                            processedKeys.add(key);
                        }
                    }
                }
            }

            // User-defined order at the source — same contract as workspaces
            // (explicit `order` first, unordered last).
            return userContextsArray.sort(compareByUserOrder);
        } catch  {
            return [];
        }
    }

    /**
     * Update a context's mutable properties
     * @param {string} userId - User ID
     * @param {string|number} contextId - Context ID
     * @param {Object} updates - Fields to update (acl, rules, etc.)
     * @returns {Promise<Context|null>} Updated context or null if not found
     */
    async updateContext(userId, contextId, updates = {}) {
        const context = await this.getContext(userId, contextId);
        if (!context) return null;

        if (updates.name !== undefined) context.name = updates.name || null;
        if (updates.order !== undefined) context.order = updates.order;
        if (updates.metadata !== undefined) context.metadata = updates.metadata;
        if (updates.acl !== undefined) await context.updateACL(updates.acl);
        if (updates.rules !== undefined) {
            for (const rule of (context.rules || [])) await context.removeRule(rule.id);
            for (const rule of updates.rules) await context.addRule(rule);
        }
        // Stored query binding — the server-enforced filters bound clients inherit.
        if (updates.features !== undefined || updates.filters !== undefined) {
            await context.setQuery({ features: updates.features, filters: updates.filters });
        }

        this.saveContext(userId, context);
        this.emit('context.updated', { ...context.toJSON(), contextId: context.id });
        return context;
    }

    /**
     * Remove a context for a user
     * @param {string} userId - User ID
     * @param {string|number} contextId - Context ID
     * @returns {Promise<boolean>} True if context was removed
     */
    async removeContext(userId, contextId) {
        if (!this.#initialized) {
            throw new Error('ContextManager not initialized');
        }

        if (!userId) throw new Error('User ID is required');
        // For removeContext, contextId should be a simple ID, not a shared one,
        // as you can only remove your own contexts.
        if (!contextId || contextId === undefined || contextId === null || contextId.toString().includes('/')) {
            throw new Error('Valid Context ID is required and cannot be a shared context identifier.');
        }

        const requestedId = this.#sanitizeContextId(contextId.toString());

        try {
            let contextKey = this.#constructContextKey(userId, requestedId);
            let actualId = requestedId;

            // Backward-compat: contexts created before lowercasing may be stored under mixed-case keys/ids.
            // Try to locate them by case-insensitive ID match within the owner's contexts.
            if (!this.#contexts.has(contextKey) && !this.#storeHas(userId, actualId)) {
                const ownedPrefix = `${userId}/`;

                for (const [key, instance] of this.#contexts) {
                    if (!key.startsWith(ownedPrefix)) continue;
                    if ((instance?.id || '').toString().toLowerCase() === requestedId) {
                        contextKey = key;
                        actualId = instance.id.toString();
                        break;
                    }
                }

                if (!this.#contexts.has(contextKey) && !this.#storeHas(userId, actualId)) {
                    for (const [storedId, data] of Object.entries(this.#userStore(userId))) {
                        if ((data?.id || storedId).toString().toLowerCase() === requestedId) {
                            actualId = (data?.id || storedId).toString();
                            contextKey = this.#constructContextKey(userId, actualId);
                            break;
                        }
                    }
                }
            }
            let contextWasRemoved = false;

            if (this.#contexts.has(contextKey)) {
                const context = this.#contexts.get(contextKey);
                await context.destroy();
                this.#contexts.delete(contextKey);
                contextWasRemoved = true;
            }

            // Remove from the owner's index store if present
            if (this.#storeHas(userId, actualId)) {
                this.#storeDelete(userId, actualId);
                contextWasRemoved = true;
            }

            // Only emit event and log if something was actually removed
            if (contextWasRemoved) {
                this.emit('context.deleted', {
                    contextKey: contextKey,
                    userId: userId,
                    contextId: actualId
                });
                logger.debug(`Context ${contextKey} removed.`);
                return true;
            } else {
                logger.debug(`Context ${contextKey} not found, nothing to remove.`);
                return false;
            }
        } catch (error) {
            logger.debug(`Error removing context for user ${userId}: ${error.message}`);
            return false;
        }
    }

    /**
     * Save a context to memory and persistent store
     * @param {string} userId
     * @param {Context} context - Context instance
     * @private
     */
    saveContext(userId, context) {
        if (!userId || !context || !context.id) {
            throw new Error(`Invalid context data: ${JSON.stringify(context)}`);
        };

        const contextKey = this.#constructContextKey(userId, context.id);
        const contextData = context.toJSON();

        this.#contexts.set(contextKey, context);
        this.#storeSet(userId, context.id, contextData);
        this.#setupEventForwarding(context);
    }

    // Mark a stored context whose workspace disappeared (deleted / moved away).
    // Orphaned contexts stay listed and deletable; the flag clears lazily on
    // the next successful getContext once the workspace is back.
    #markContextOrphaned(userId, contextData) {
        if (!contextData?.id) return;
        if (contextData.status === 'orphaned') return;
        this.#storeSet(userId, contextData.id, {
            ...contextData,
            status: 'orphaned',
            orphanedAt: new Date().toISOString(),
        });
        logger.warn(`Context ${userId}/${contextData.id} marked orphaned (workspace ${contextData.workspaceName || contextData.workspaceId} missing)`);
    }

    /**
     * Private methods
     */

    /**
     * Setup event forwarding from context instance to manager
     * @param {Context} context - Context instance
     * @private
     */
    #setupEventForwarding(context) {
        if (context._eventsForwarded) return;

        const manager = this;
        const wildcardForwarder = function (payload = {}) {
            const eventName = this.event;
            const enriched = { ...payload, contextId: context.id };
            manager.emit(eventName, enriched);
        };

        context.on('**', wildcardForwarder);
        context._eventsForwarded = true;
    }

    #sanitizeContextId(contextId) {
        if (contextId === undefined || contextId === null || contextId === '') {
            contextId = 'default';
        }

        // Allow: A-Z a-z 0-9 . _ -
        // (We still strip anything else to keep IDs URL-safe and filesystem-ish.)
        contextId = contextId.replace(/[^a-zA-Z0-9._-]/g, '');


        // Limit to 16 characters
        contextId = contextId.substring(0, 16);

        // Canonicalize: treat IDs as case-insensitive
        return contextId.toString().trim().toLowerCase();
    }

    #constructContextKey(userId, contextId) {
        return `${userId}/${this.#sanitizeContextId(contextId.toString())}`; // Ensure contextId is sanitized here
    }

    #parseContextIdentifier(identifier, defaultUserId) {
        const idStr = identifier.toString();
        if (idStr.includes('/')) {
            const parts = idStr.split('/');
            if (parts.length === 2 && parts[0] && parts[1]) {
                // Simple user/resource format: user.name/context.name or user.id/context.id
                return { ownerUserId: parts[0], contextId: this.#sanitizeContextId(parts[1]) };
            } else {
                throw new Error(`Invalid context identifier format: ${idStr}. Expected 'user.name/context.name' or simple 'contextId'.`);
            }
        }
        // If no '/', it's a simple contextId, owner is the defaultUserId (usually the accessing user)
        return { ownerUserId: defaultUserId, contextId: this.#sanitizeContextId(idStr) };
    }

    async #resolveWorkspaceActive(contextData) {
        if (!contextData?.workspaceId) return false;
        try {
            const ws = await this.#workspaceManager.getWorkspace(contextData.workspaceId, contextData.userId);
            return ws?.isActive ?? false;
        } catch {
            return false;
        }
    }

    async #checkContextAccess(contextData, accessingUserId) {
        // Check if user has access to this context via ACL
        if (!contextData || !contextData.acl) return false;

        // Check old format: acl[userId]
        if (contextData.acl[accessingUserId]) {
            return true;
        }

        // Check new format: acl.users[email] where userId matches
        if (contextData.acl.users) {
            for (const [_email, shareData] of Object.entries(contextData.acl.users)) {
                if (shareData.userId === accessingUserId) {
                    return true;
                }
            }
        }

        return false;
    }

        /**
     * Resolves a context ID from a simple context identifier
     * @param {string} contextIdentifier - Simple identifier in format user.name/context.name
     * @returns {Promise<string|null>} The context ID if found, null otherwise
     */
    async resolveContextIdFromSimpleIdentifier(contextIdentifier) {
        try {
            const { ownerUserId, contextId } = this.#parseContextIdentifier(contextIdentifier, null);

            // If no ownerUserId was parsed (simple contextId), return null as this method is for user/context format
            if (!ownerUserId) {
                return null;
            }

            // Resolve the user identifier to a user ID if needed
            const resolvedUserId = await this.#workspaceManager.users.resolveId(ownerUserId);
            if (!resolvedUserId) {
                return null;
            }

            // Check if context exists
            const contextKey = this.#constructContextKey(resolvedUserId, contextId);
            if (this.#contexts.has(contextKey) || this.#storeHas(resolvedUserId, contextId)) {
                return contextId;
            }

            // Fallback: older mixed-case IDs stored before canonicalization
            for (const data of Object.values(this.#userStore(resolvedUserId))) {
                if ((data?.id || '').toString().toLowerCase() === contextId) {
                    return data.id;
                }
            }

            return null;
        } catch  {
            return null;
        }
    }

    /**
     * Construct a simple resource address from context data
     * @param {Object} context - Context object with userId and id
     * @returns {Promise<string|null>} Resource address in format user.name/context.id
     */
    async constructResourceAddress(context) {
        if (!context || !context.userId || !context.id) {
            return null;
        }

        try {
            // Get user info to construct the address
            const user = await this.#workspaceManager.users.get(context.userId);
            if (!user || !user.name) {
                return null;
            }

            return `${user.name}/${context.id}`;
        } catch  {
            return null;
        }
    }

    async grantContextAccess(requestingUserId, targetContextIdentifier, sharedWithUserId, accessLevel) {
        if (!this.#initialized) throw new Error('ContextManager not initialized');
        if (!requestingUserId) throw new Error('Requesting User ID is required.');
        if (!targetContextIdentifier) throw new Error('Target Context Identifier is required.');
        if (!sharedWithUserId) throw new Error('User ID or email to share with is required.');
        if (!accessLevel) throw new Error('Access level is required.');

        const { ownerUserId, contextId: actualContextId } = this.#parseContextIdentifier(targetContextIdentifier, requestingUserId);

        if (requestingUserId !== ownerUserId) {
            throw new Error(`Access denied: User ${requestingUserId} is not the owner of context ${targetContextIdentifier}.`);
        }

        try {
            // Get the context - this uses the owner's ID to fetch
            const context = await this.getContext(ownerUserId, actualContextId); // Pass ownerUserId as accessing user for this internal step

            // Check if sharedWithUserId is an email address (contains @)
            const isEmail = sharedWithUserId.includes('@');

            if (isEmail) {
                // Use new email-based sharing method
                logger.debug(`Using email-based sharing for ${sharedWithUserId}`);
                await context.grantAccessByEmail(sharedWithUserId, accessLevel, {
                    description: `Shared context access for ${sharedWithUserId}`,
                    grantedBy: requestingUserId
                });
            } else {
                // Use old userId-based sharing method (for backward compatibility)
                logger.debug(`Using userId-based sharing for ${sharedWithUserId}`);
                await context.grantAccess(sharedWithUserId, accessLevel);
            }

            logger.debug(`Access granted to ${sharedWithUserId} for context ${targetContextIdentifier} with level ${accessLevel} by ${requestingUserId}`);
            return true;
        } catch (error) {
            logger.debug(`Error granting access to context ${targetContextIdentifier}: ${error.message}`);
            throw error;
        }
    }

    async revokeContextAccess(requestingUserId, targetContextIdentifier, sharedWithUserId) {
        if (!this.#initialized) throw new Error('ContextManager not initialized');
        if (!requestingUserId) throw new Error('Requesting User ID is required.');
        if (!targetContextIdentifier) throw new Error('Target Context Identifier is required.');
        if (!sharedWithUserId) throw new Error('User ID or email to revoke access from is required.');

        const { ownerUserId, contextId: actualContextId } = this.#parseContextIdentifier(targetContextIdentifier, requestingUserId);

        if (requestingUserId !== ownerUserId) {
            throw new Error(`Access denied: User ${requestingUserId} is not the owner of context ${targetContextIdentifier}.`);
        }

        try {
            // Get the context - this uses the owner's ID to fetch
            const context = await this.getContext(ownerUserId, actualContextId); // Pass ownerUserId as accessing user for this internal step

            // Check if sharedWithUserId is an email address (contains @)
            const isEmail = sharedWithUserId.includes('@');

            if (isEmail) {
                // Use new email-based revocation method
                logger.debug(`Using email-based revocation for ${sharedWithUserId}`);
                await context.revokeAccessByEmail(sharedWithUserId);
            } else {
                // Use old userId-based revocation method (for backward compatibility)
                logger.debug(`Using userId-based revocation for ${sharedWithUserId}`);
                await context.revokeAccess(sharedWithUserId);
            }

            logger.debug(`Access revoked from ${sharedWithUserId} for context ${targetContextIdentifier} by ${requestingUserId}`);
            return true;
        } catch (error) {
            logger.debug(`Error revoking access from context ${targetContextIdentifier}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Token Management API - Public methods for token operations
     */

    /**
     * Get all contexts with their metadata (for token searches)
     * This provides a proper public API instead of direct store access
     * @returns {Array<Object>} Array of context metadata objects
     */
    getAllContexts() {
        if (!this.#initialized) {
            throw new Error('ContextManager not initialized');
        }

        const contexts = [];

        // Get contexts from in-memory cache
        for (const [contextKey, contextInstance] of this.#contexts) {
            contexts.push({
                contextKey,
                id: contextInstance.id,
                userId: contextInstance.userId,
                acl: contextInstance.acl,
                name: contextInstance.name || contextInstance.id,
                url: contextInstance.url,
                workspaceId: contextInstance.workspaceId,
                scope: contextInstance.scope,
            });
        }

        // Get contexts from persistent stores that aren't in memory
        for (const [entryUserId, entryContextId, contextData] of this.#allEntries()) {
            const contextKey = this.#constructContextKey(entryUserId, entryContextId);
            if (!this.#contexts.has(contextKey)) {
                contexts.push({
                    contextKey,
                    id: contextData.id,
                    userId: contextData.userId,
                    acl: contextData.acl,
                    name: contextData.name,
                    url: contextData.url,
                    workspaceId: contextData.workspaceId,
                    scope: contextData.scope,
                });
            }
        }

        return contexts;
    }

    /**
     * Get contexts owned by a specific user
     * @param {string} userId - User ID to get contexts for
     * @returns {Array<Object>} Array of context metadata objects owned by the user
     */
    getContextsForUser(userId) {
        if (!this.#initialized) {
            throw new Error('ContextManager not initialized');
        }
        if (!userId) {
            throw new Error('User ID is required');
        }

        return this.getAllContexts().filter(context => context.userId === userId);
    }

    /**
     * Get all contexts bound to a specific workspace
     * @param {string} workspaceId - Workspace ID
     * @returns {Array<Object>} Array of context metadata objects for the workspace
     */
    getContextsForWorkspace(workspaceId) {
        if (!this.#initialized) throw new Error('ContextManager not initialized');
        if (!workspaceId) throw new Error('Workspace ID is required');
        return this.getAllContexts().filter(ctx => ctx.workspaceId === workspaceId);
    }

    /**
     * Find context by token hash (for token validation)
     * @param {string} tokenHash - SHA256 hash of the token
     * @returns {Object|null} Context metadata if token found, null otherwise
     */
    findContextByTokenHash(tokenHash) {
        if (!this.#initialized) {
            throw new Error('ContextManager not initialized');
        }
        if (!tokenHash) {
            throw new Error('Token hash is required');
        }

        const allContexts = this.getAllContexts();

        for (const context of allContexts) {
            if (context.acl?.tokens?.[tokenHash]) {
                return {
                    ...context,
                    tokenData: context.acl.tokens[tokenHash]
                };
            }
        }

        return null;
    }

}

export default ContextManager;
