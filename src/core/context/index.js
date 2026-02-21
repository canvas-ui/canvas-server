'use strict';

// Utils
import Url from './lib/Url.js';
import EventEmitter from 'eventemitter2';

// Logging
import { createLogger } from '../../utils/log.js';
const logger = createLogger('context-manager:index');

// Includes
import Context from './lib/Context.js';

// Constants
const DEFAULT_WORKSPACE_ID = 'universe';

/**
 * Context Manager
 */

class ContextManager extends EventEmitter {

    #indexStore;             // Persistent index of all contexts
    #workspaceManager;       // Reference to workspace manager

    // Runtime
    #contexts = new Map();   // In-memory cache of loaded contexts
    #initialized = false;    // Manager initialized flag

    /**
     * Create a new ContextManager
     * @param {Object} options - Manager options
     * @param {Object} options.indexStore - Index store for context data
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

        if (!options.indexStore) {
            throw new Error('Index store is required for ContextManager');
        }
        if (!options.workspaceManager) {
            throw new Error('WorkspaceManager is required for ContextManager');
        }

        this.#indexStore = options.indexStore;
        this.#workspaceManager = options.workspaceManager;

        logger.debug('Context manager created');
    }

    /**
     * Initialize manager
     */
    async initialize() {
        if (this.#initialized) { return this; }
        logger.debug('Initializing context manager: loading stored context IDs...');

        // Log the number of items directly from the store if possible, or after loading.
        // For a simple Map-like store, size might be available.
        // If indexStore is more complex, this log might need adjustment.
        const initialContextCount = typeof this.#indexStore.size === 'function' ? this.#indexStore.size() : (this.#indexStore.store ? Object.keys(this.#indexStore.store).length : 'N/A');
        logger.debug(`ContextManager initialized with ${initialContextCount} context(s) in index`);
        this.#initialized = true;
        return this;
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

            if (this.#contexts.has(contextKey) || this.#indexStore.has(contextKey)) {
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
            // Otherwise, resolve from URL or default to universe
            else if (parsed.workspaceId) {
                workspaceId = this.#workspaceManager.resolveWorkspaceId(userId, parsed.workspaceId);
            } else {
                workspaceId = this.#workspaceManager.resolveWorkspaceId(userId, DEFAULT_WORKSPACE_ID);
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

            const contextOptions = {
                ...options,
                id: contextId.toString(),
                userId: userId,
                workspace: workspace,
                workspaceId: workspace.id,
                workspaceManager: this.#workspaceManager,
                contextManager: this,
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

        // Backward-compat for older mixed-case IDs: try to locate by case-insensitive match.
        // (We now canonicalize IDs to lowercase.)
        if (!this.#contexts.has(contextKey) && !this.#indexStore.has(contextKey)) {
            const allContexts = this.#indexStore.store || {};
            const ownerPrefix = ownerUserId ? `${ownerUserId}/` : null;

            // 1) In-memory
            for (const [key, instance] of this.#contexts) {
                if (ownerPrefix && !key.startsWith(ownerPrefix)) continue;
                if ((instance?.id || '').toString().toLowerCase() === contextId) {
                    contextKey = key;
                    break;
                }
            }

            // 2) Persistent store
            if (!this.#contexts.has(contextKey) && !this.#indexStore.has(contextKey)) {
                for (const [key, data] of Object.entries(allContexts)) {
                    if (ownerPrefix && !key.startsWith(ownerPrefix)) continue;
                    if ((data?.id || '').toString().toLowerCase() === contextId) {
                        contextKey = key;
                        ownerUserId = data.userId;
                        break;
                    }
                }
            }
        }

        // Check if it's a shared context owned by someone else
        if (ownerUserId === userId && !this.#contexts.has(contextKey) && !this.#indexStore.has(contextKey)) {
            const allContexts = this.#indexStore.store || {};
            for (const [key, contextData] of Object.entries(allContexts)) {
                if (contextData.id === contextId && contextData.userId !== userId) {
                    const hasAccess = await this.#checkContextAccess(contextData, userId);
                    if (hasAccess) {
                        contextKey = key;
                        ownerUserId = contextData.userId;
                        break;
                    }
                }
            }
        }

        try {
            let contextInstance = null;

            if (this.#contexts.has(contextKey)) {
                contextInstance = this.#contexts.get(contextKey);
            } else {
                const storedContextData = this.#indexStore.get(contextKey);
                if (storedContextData) {
                    if (storedContextData.userId !== ownerUserId) {
                        throw new Error(`Owner mismatch: expected ${ownerUserId}, found ${storedContextData.userId}`);
                    }

                    let workspaceId = storedContextData.workspaceId;
                    if (workspaceId && (workspaceId.includes(':') || workspaceId.length < 12)) {
                         const resolvedId = this.#workspaceManager.resolveWorkspaceId(ownerUserId, workspaceId);
                         if (resolvedId) workspaceId = resolvedId;
                    }

                    const workspace = await this.#workspaceManager.getWorkspace(workspaceId, ownerUserId);
                    if (!workspace) {
                        throw new Error(`Failed to load workspace ${storedContextData.workspaceId} for context ${contextKey}`);
                    }

                    // Workspace must be active to create context (Context constructor accesses workspace.db and workspace.tree)
                    if (!workspace.isActive) {
                        throw new Error(`Workspace ${workspace.name} is not active. Start the workspace before accessing contexts.`);
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
            }

            if (contextInstance) {
                if (userId !== contextInstance.userId) {
                    if (!contextInstance.checkPermission(userId, 'documentRead')) {
                        throw new Error(`Access denied: user ${userId} lacks permission for context ${contextKey}`);
                    }
                }
                return contextInstance;
            }

            if (canAutoCreate) {
                const createOptions = { ...options, id: contextId.toString() };
                return this.createContext(userId, options.url || '/', createOptions);
            }

            throw new Error(`Context not found: ${contextKey}`);
        } catch (error) {
            throw error;
        }
    }

    hasContext(userId, contextIdOrFullIdentifier) {
        if (!this.#initialized) {
            throw new Error('ContextManager not initialized');
        }
        const { ownerUserId, contextId } = this.#parseContextIdentifier(contextIdOrFullIdentifier, userId);
        const contextKey = this.#constructContextKey(ownerUserId, contextId);
        // This check doesn't verify permissions, just existence.
        // For a true "has access" check, getContext would be needed.
        return this.#contexts.has(contextKey) || this.#indexStore.has(contextKey);
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

            // Search persistent store
            const allContextsInStore = this.#indexStore.store || {};
            for (const [contextKey, contextData] of Object.entries(allContextsInStore)) {
                if (contextData.id === contextId) {
                    return {
                        contextKey,
                        contextData,
                        userId: contextData.userId
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
                    } catch (error) {
                        userContextsArray.push(contextInstance.toJSON());
                    }
                    processedKeys.add(key);
                }
            }

            const allContextsInStore = this.#indexStore.store;
            if (allContextsInStore) {
                for (const key in allContextsInStore) {
                    if (processedKeys.has(key)) continue;

                    const storedContextData = allContextsInStore[key];
                    if (!storedContextData) continue;

                    if (key.startsWith(ownedPrefix)) {
                        try {
                            const ownerUser = await this.#workspaceManager.users.get(storedContextData.userId);
                            userContextsArray.push({
                                ...storedContextData,
                                ownerEmail: ownerUser.email
                            });
                        } catch (error) {
                            userContextsArray.push(storedContextData);
                        }
                        processedKeys.add(key);
                    } else {
                        const hasAccess = await this.#checkContextAccess(storedContextData, userId);

                        if (hasAccess) {
                            try {
                                const ownerUser = await this.#workspaceManager.users.get(storedContextData.userId);
                                userContextsArray.push({
                                    ...storedContextData,
                                    ownerEmail: ownerUser.email,
                                    type: 'shared',
                                    isShared: true
                                });
                            } catch (error) {
                                userContextsArray.push({
                                    ...storedContextData,
                                    type: 'shared',
                                    isShared: true
                                });
                            }
                            processedKeys.add(key);
                        }
                    }
                }
            }

            return userContextsArray;
        } catch (error) {
            return [];
        }
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
        if (requestedId === 'default') {
            throw new Error('Default context cannot be removed');
        }

        try {
            let contextKey = this.#constructContextKey(userId, requestedId);
            let actualId = requestedId;

            // Backward-compat: contexts created before lowercasing may be stored under mixed-case keys/ids.
            // Try to locate them by case-insensitive ID match within the owner's contexts.
            if (!this.#contexts.has(contextKey) && !this.#indexStore.has(contextKey)) {
                const ownedPrefix = `${userId}/`;

                for (const [key, instance] of this.#contexts) {
                    if (!key.startsWith(ownedPrefix)) continue;
                    if ((instance?.id || '').toString().toLowerCase() === requestedId) {
                        contextKey = key;
                        actualId = instance.id.toString();
                        break;
                    }
                }

                if (!this.#contexts.has(contextKey) && !this.#indexStore.has(contextKey)) {
                    const allContexts = this.#indexStore.store || {};
                    for (const [key, data] of Object.entries(allContexts)) {
                        if (!key.startsWith(ownedPrefix)) continue;
                        if ((data?.id || '').toString().toLowerCase() === requestedId) {
                            contextKey = key;
                            actualId = data.id.toString();
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

            // Remove from index store if exists (which should be the case)
            if (this.#indexStore.has(contextKey)) {
                this.#indexStore.delete(contextKey);
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
        this.#indexStore.set(contextKey, contextData);
        this.#setupEventForwarding(context);
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

    async #checkContextAccess(contextData, accessingUserId) {
        // Check if user has access to this context via ACL
        if (!contextData || !contextData.acl) return false;

        // Check old format: acl[userId]
        if (contextData.acl[accessingUserId]) {
            return true;
        }

        // Check new format: acl.users[email] where userId matches
        if (contextData.acl.users) {
            for (const [email, shareData] of Object.entries(contextData.acl.users)) {
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
            if (this.#contexts.has(contextKey) || this.#indexStore.has(contextKey)) {
                return contextId;
            }

            // Fallback: older mixed-case IDs stored before canonicalization
            const allContexts = this.#indexStore.store || {};
            const ownerPrefix = `${resolvedUserId}/`;
            for (const [key, data] of Object.entries(allContexts)) {
                if (!key.startsWith(ownerPrefix)) continue;
                if ((data?.id || '').toString().toLowerCase() === contextId) {
                    return data.id;
                }
            }

            return null;
        } catch (error) {
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
        } catch (error) {
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

        // Get contexts from persistent store that aren't in memory
        const allContextsInStore = this.#indexStore.store || {};
        for (const [contextKey, contextData] of Object.entries(allContextsInStore)) {
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
