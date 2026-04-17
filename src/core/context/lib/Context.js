'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import { v4 as uuidv4 } from 'uuid';

// Logging
import { createLogger } from '../../../utils/log.js';
const logger = createLogger('context-manager:context');

// Includes
import Url from './Url.js';
import { parseDocumentId, parseDocumentIdArray } from '../../../utils/documentId.js';

// Constants
const DEFAULT_BASE_URL = '/';

/**
 * Context
 *
 * A Context models where a user and their bound devices are focused right now.
 * It is not the same thing as a ContextTree.
 *
 * - Context: runtime focus/navigation state
 * - ContextTree: indexed view used to resolve and query context paths
 */

class Context extends EventEmitter {

    // Context properties
    #id;
    #name;
    #scope; // 'workspace' (bound to one workspace) or 'universe' (can cross workspace boundaries)
    #baseUrl;
    #url;
    #path;
    #pathArray;
    #userId;
    #color;

    // Access Control List: maps userId to accessLevel (e.g., {"user@example.com": "documentRead"})
    #acl;

    // Runtime Context arrays
    #serverContextArray; // server/os/linux, server/version/1.0.0, server/datetime/, server/ip/192.168.1.1
    #clientContextArray; // client/os/linux, client/app/firefox, client/datetime/, client/user/john.doe

    // Query state
    #contextBitmapArray = [];
    #attributes = [];
    #filters = [];

    // Rules for auto-linking
    #rules = [];

    // Workspace references
    #workspace; // Current workspace instance
    #tree; // bound context tree
    #treeId;
    #workspaceManager; // Workspace manager instance
    #contextManager; // Context manager instance
    #workspaceEventHandlers; // Event handlers for workspace event forwarding

    // Context metadata
    #createdAt;
    #updatedAt;
    #isLocked;

    // Additional properties
    #pendingUrl;

    constructor(url = DEFAULT_BASE_URL, options = {}) {
        // Enable wildcard events for EventEmitter2 so ContextManager can listen with **
        super({
            wildcard: true,
            delimiter: '.',
            newListener: false,
            maxListeners: 50,
            ...(options.eventEmitterOptions || {})
        });

        // Context properties
        this.#id = options.id || uuidv4(); // TODO: Use human-typeable 6-char ULID
        this.#name = options.name || null;
        this.#scope = options.scope || (options.workspace?.type === 'universe' ? 'universe' : 'workspace');
        this.#url = null;
        this.#baseUrl = options.baseUrl || DEFAULT_BASE_URL;
        this.#path = null;
        this.#pathArray = [];
        this.#isLocked = options.locked || false;

        // User ID
        if (!options.userId) { throw new Error('User ID is required'); }
        this.#userId = options.userId;

        // Workspace references
        if (!options.workspace) { throw new Error('Workspace instance is required'); }
        if (!options.workspaceManager) { throw new Error('Workspace manager instance is required'); }
        this.#workspace = options.workspace;
        this.#workspaceManager = options.workspaceManager;
        this.#treeId = options.treeId || this.#workspace.getDefaultContextTree()?.id || null;
        this.#tree = this.#workspace.getContextTree(this.#treeId);
        this.#color = this.#workspace.color;

        // Context manager references
        if (!options.contextManager) { throw new Error('Context manager instance is required'); }
        this.#contextManager = options.contextManager;

        // Context metadata
        this.#createdAt = options.createdAt || new Date().toISOString();
        this.#updatedAt = options.updatedAt || new Date().toISOString();

        // ACL
        this.#acl = options.acl || {};

        // Context variables
        this.#serverContextArray = options.serverContextArray || [];
        this.#clientContextArray = options.clientContextArray || [];

        // Rules
        this.#rules = options.rules || [];

        // Set up event forwarding from workspace
        this.#setupWorkspaceEventForwarding();

        // Set initial URL - simplified logic now that Url properly handles null workspaceId
        try {
            // Validate base URL if provided
            if (this.#baseUrl !== '/') {
                const base = new Url(this.#baseUrl);
                if (!base.isValid) {
                    throw new Error(`Invalid base URL provided: ${this.#baseUrl}`);
                }
            }

            // Parse the initial URL
            const parsedUrl = new Url(url);
            if (!parsedUrl.isValid) {
                throw new Error(`Invalid initial URL provided: ${url}`);
            }

            // Check if URL is within base URL constraints
            if (this.#baseUrl !== '/' && !parsedUrl.path.startsWith(new Url(this.#baseUrl).path)) {
                logger.debug(`Provided URL "${url}" is outside base URL "${this.#baseUrl}". Forcing URL to base URL.`);
                const baseUrl = new Url(this.#baseUrl);
                this.#url = baseUrl.url;
                this.#path = baseUrl.path;
                this.#pathArray = baseUrl.pathArray;
                this.#contextBitmapArray = [...baseUrl.pathArray]; // Initialize contextBitmapArray
            } else {
                // If no workspaceId in URL, use current workspace name
                if (!parsedUrl.workspaceId) {
                    this.#url = `${this.#workspace.name}://${parsedUrl.path.replace(/^\//, '')}`;
                    this.#path = parsedUrl.path;
                    this.#pathArray = parsedUrl.pathArray;
                    this.#contextBitmapArray = [...parsedUrl.pathArray]; // Initialize contextBitmapArray
                } else if (parsedUrl.workspaceId === this.#workspace.name) {
                    // Same workspace, use as-is
                    this.#url = parsedUrl.url;
                    this.#path = parsedUrl.path;
                    this.#pathArray = parsedUrl.pathArray;
                    this.#contextBitmapArray = [...parsedUrl.pathArray]; // Initialize contextBitmapArray
                } else if (this.#scope === 'universe') {
                    // Universe-scoped: different workspace, store as pending for later switching
                    this.#pendingUrl = url;
                    this.#url = `${this.#workspace.name}://${parsedUrl.path.replace(/^\//, '')}`;
                    this.#path = parsedUrl.path;
                    this.#pathArray = parsedUrl.pathArray;
                    this.#contextBitmapArray = [...parsedUrl.pathArray];
                } else {
                    throw new Error(`Workspace-scoped context cannot target a different workspace: "${parsedUrl.workspaceId}"`);
                }
            }
        } catch (error) {
            // Clean up on error
            this.#baseUrl = '/';
            this.#url = null;
            this.#path = null;
            this.#pathArray = [];
            this.#contextBitmapArray = [];
            throw new Error(`Failed to initialize context: ${error.message}`);
        }

        logger.debug(`Context ${this.#id} constructor finished. Initial URL state: ${this.#url}, Base URL: ${this.#baseUrl}`);
        this.emit('context.created', this.toJSON());
    }

    /**
     * Initialize the context by processing any pending URL switch
     * This should be called after the context is created if you need
     * to ensure the context is fully initialized with the correct workspace
     * @returns {Promise<Context>} - The initialized context
     */
    async initialize() {
        if (this.#pendingUrl) {
            logger.debug(`Processing pending URL switch to ${this.#pendingUrl}`);
            const pendingUrl = this.#pendingUrl;
            this.#pendingUrl = null;
            return this.setUrl(pendingUrl);
        }

        return Promise.resolve(this);
    }

    // Getters / Setters
    get id() { return this.#id; }
    get name() { return this.#name; }
    set name(name) { this.#name = name || null; }
    get scope() { return this.#scope; }
    get isUniverse() { return this.#scope === 'universe'; }
    get userId() { return this.#userId; }
    get baseUrl() { return this.#baseUrl; }
    get url() { return this.#url; }
    set url(url) { return this.setUrl(url); }
    get path() { return this.#path; }
    get pathArray() { return this.#pathArray; }
    get workspace() { return this.#workspace; }
    get workspaceId() { return this.#workspace.id; }
    get workspaceName() { return this.#workspace.name; }
    get treeId() { return this.#treeId; }
    get color() { return this.#color; }
    get pendingUrl() { return this.#pendingUrl; }
    get bitmapArrays() {
        return {
            server: this.#serverContextArray,
            client: this.#clientContextArray,
            context: this.#contextBitmapArray,
            attributes: this.#attributes,
            filters: this.#filters,
        };
    }
    get acl() { return this.#acl; }
    get serverContextArray() { return this.#serverContextArray; }
    get clientContextArray() { return this.#clientContextArray; }
    get contextBitmapArray() { return this.#contextBitmapArray; }
    get attributes() { return this.#attributes; }
    get filters() { return this.#filters; }
    get rules() { return [...this.#rules]; }

    /**
     * Helper Methods
     */

    /**
     * Convert context array to path string for SynapsD query operations
     * @param {Array<string>} contextArray - Array of context layers like ['/', 'foo', 'bar']
     * @returns {string} Path string like '/foo/bar' or '/' for root
     * @private
     */
    #convertContextArrayToPath(contextArray) {
        if (!Array.isArray(contextArray) || contextArray.length === 0) {
            return '/';
        }

        // Filter out root '/' and empty strings
        const pathParts = contextArray.filter(part => part && part !== '/');

        // If no parts remain, return root
        if (pathParts.length === 0) {
            return '/';
        }

        // Join parts with '/' and ensure leading slash
        return '/' + pathParts.join('/');
    }

    #buildContextSelector(contextArray = this.#contextBitmapArray) {
        const path = this.#convertContextArrayToPath(contextArray);
        if (path === '/') return null;
        return {
            tree: this.#treeId,
            path,
        };
    }

    #buildMergedContextArray(options = {}) {
        const parts = [...this.#contextBitmapArray];
        if (options.includeServerContext && this.#serverContextArray?.length > 0) {
            parts.push(...this.#serverContextArray);
        }
        if (options.includeClientContext && this.#clientContextArray?.length > 0) {
            parts.push(...this.#clientContextArray);
        }
        return [...new Set(parts)];
    }

    #requireWorkspace() {
        if (!this.#workspace?.isActive) {
            throw new Error('Workspace or database not available');
        }
        return this.#workspace;
    }

    /**
     * Context API
     */

    /**
     * Grant access to this context to another user.
     * @param {string} sharedWithUserId - The ID of the user to grant access to.
     * @param {'documentRead' | 'documentWrite' | 'documentReadWrite'} accessLevel - The level of access to grant.
     */
    async grantAccess(sharedWithUserId, accessLevel) {
        if (!sharedWithUserId || typeof sharedWithUserId !== 'string') {
            throw new Error('Invalid sharedWithUserId provided.');
        }
        const validAccessLevels = ['documentRead', 'documentWrite', 'documentReadWrite'];
        if (!validAccessLevels.includes(accessLevel)) {
            throw new Error(`Invalid accessLevel: ${accessLevel}. Must be one of ${validAccessLevels.join(', ')}`);
        }

        if (sharedWithUserId === this.#userId) {
            logger.debug(`User ${sharedWithUserId} is the owner, no need to grant explicit access.`);
            return Promise.resolve(this); // Owner always has full access
        }

        this.#acl[sharedWithUserId] = accessLevel;
        this.#updatedAt = new Date().toISOString();
        this.emit('context.acl.updated', { id: this.#id, userId: sharedWithUserId, accessLevel });

        // Save changes to index
        await this.#contextManager.saveContext(this.#userId, this);
        return Promise.resolve(this);
    }

    /**
     * Revoke access to this context from another user.
     * @param {string} sharedWithUserId - The ID of the user whose access to revoke.
     */
    async revokeAccess(sharedWithUserId) {
        if (!sharedWithUserId || typeof sharedWithUserId !== 'string') {
            throw new Error('Invalid sharedWithUserId provided.');
        }

        if (sharedWithUserId === this.#userId) {
            logger.debug(`Cannot revoke access from the owner ${sharedWithUserId}.`);
            return Promise.resolve(this);
        }

        if (this.#acl[sharedWithUserId]) {
            delete this.#acl[sharedWithUserId];
            this.#updatedAt = new Date().toISOString();
            this.emit('context.acl.revoked', { id: this.#id, userId: sharedWithUserId });

            // Save changes to index
            await this.#contextManager.saveContext(this.#userId, this);
        } else {
            logger.debug(`No explicit access found for ${sharedWithUserId} to revoke.`);
        }
        return Promise.resolve(this);
    }

    /**
     * Grant access to this context to another user by email (recommended method).
     * This uses the new ACL structure: acl.users[email] with metadata.
     * @param {string} userEmail - The email of the user to grant access to.
     * @param {'documentRead' | 'documentWrite' | 'documentReadWrite'} accessLevel - The level of access to grant.
     * @param {Object} options - Additional options
     * @param {string} [options.description] - Description of the share
     * @param {string} [options.grantedBy] - User ID who granted access
     */
    async grantAccessByEmail(userEmail, accessLevel, options = {}) {
        if (!userEmail || typeof userEmail !== 'string') {
            throw new Error('Invalid userEmail provided.');
        }
        const validAccessLevels = ['documentRead', 'documentWrite', 'documentReadWrite'];
        if (!validAccessLevels.includes(accessLevel)) {
            throw new Error(`Invalid accessLevel: ${accessLevel}. Must be one of ${validAccessLevels.join(', ')}`);
        }

        // Resolve email to userId for owner check
        const targetUser = await this.#workspaceManager.users.getByEmail(userEmail);
        if (!targetUser) {
            throw new Error(`User with email ${userEmail} not found`);
        }

        logger.debug(`grantAccessByEmail: Resolved ${userEmail} to userId: ${targetUser.id}`);

        if (targetUser.id === this.#userId) {
            logger.debug(`User ${userEmail} is the owner, no need to grant explicit access.`);
            return Promise.resolve(this); // Owner always has full access
        }

        // Initialize users object if it doesn't exist
        if (!this.#acl.users) {
            this.#acl.users = {};
        }

        // Store by email with metadata
        this.#acl.users[userEmail] = {
            accessLevel,
            userId: targetUser.id, // Store userId for backward compatibility
            description: options.description || `Shared context access for ${userEmail}`,
            grantedAt: new Date().toISOString(),
            grantedBy: options.grantedBy || this.#userId
        };

        logger.debug(`grantAccessByEmail: Stored share for ${userEmail} (userId: ${targetUser.id}) with accessLevel: ${accessLevel}`);
        logger.debug(`grantAccessByEmail: Context ACL users:`, JSON.stringify(this.#acl.users, null, 2));

        this.#updatedAt = new Date().toISOString();
        this.emit('context.acl.updated', { id: this.#id, userEmail, accessLevel });

        // Save changes to index
        await this.#contextManager.saveContext(this.#userId, this);
        logger.debug(`grantAccessByEmail: Context saved to index for context ${this.#id}`);
        return Promise.resolve(this);
    }

    /**
     * Revoke access to this context from another user by email.
     * @param {string} userEmail - The email of the user whose access to revoke.
     */
    async revokeAccessByEmail(userEmail) {
        if (!userEmail || typeof userEmail !== 'string') {
            throw new Error('Invalid userEmail provided.');
        }

        // Check if users object exists
        if (!this.#acl.users || !this.#acl.users[userEmail]) {
            logger.debug(`No explicit access found for ${userEmail} to revoke.`);
            return Promise.resolve(this);
        }

        delete this.#acl.users[userEmail];
        this.#updatedAt = new Date().toISOString();
        this.emit('context.acl.revoked', { id: this.#id, userEmail });

        // Save changes to index
        await this.#contextManager.saveContext(this.#userId, this);
        return Promise.resolve(this);
    }

    /**
     * Update access level for a user by email.
     * @param {string} userEmail - The email of the user to update.
     * @param {'documentRead' | 'documentWrite' | 'documentReadWrite'} accessLevel - The new access level.
     * @param {Object} options - Additional options
     * @param {string} [options.description] - Updated description
     * @param {string} [options.updatedBy] - User ID who updated access
     */
    async updateAccessByEmail(userEmail, accessLevel, options = {}) {
        if (!userEmail || typeof userEmail !== 'string') {
            throw new Error('Invalid userEmail provided.');
        }
        const validAccessLevels = ['documentRead', 'documentWrite', 'documentReadWrite'];
        if (!validAccessLevels.includes(accessLevel)) {
            throw new Error(`Invalid accessLevel: ${accessLevel}. Must be one of ${validAccessLevels.join(', ')}`);
        }

        // Check if users object exists
        if (!this.#acl.users || !this.#acl.users[userEmail]) {
            throw new Error(`No share found for ${userEmail}`);
        }

        // Update the share
        this.#acl.users[userEmail] = {
            ...this.#acl.users[userEmail],
            accessLevel,
            description: options.description !== undefined ? options.description : this.#acl.users[userEmail].description,
            updatedAt: new Date().toISOString(),
            updatedBy: options.updatedBy || this.#userId
        };

        this.#updatedAt = new Date().toISOString();
        this.emit('context.acl.updated', { id: this.#id, userEmail, accessLevel });

        // Save changes to index
        await this.#contextManager.saveContext(this.#userId, this);
        return Promise.resolve(this);
    }

    /**
     * Update the complete ACL for this context
     * @param {Object} newACL - The new ACL object
     */
    async updateACL(newACL) {
        if (!newACL || typeof newACL !== 'object') {
            throw new Error('Invalid ACL object provided.');
        }

        this.#acl = { ...newACL };
        this.#updatedAt = new Date().toISOString();
        this.emit('context.acl.updated', { id: this.#id, acl: this.#acl });

        // Save changes to index
        await this.#contextManager.saveContext(this.#userId, this);
        return Promise.resolve(this);
    }

    /**
     * Check if a user has a specific permission level for this context.
     * The context owner always has all permissions.
     * Supports both old format (acl[userId]) and new format (acl.users[email]).
     * @param {string} accessingUserId - The ID of the user attempting to access.
     * @param {'documentRead' | 'documentWrite' | 'documentReadWrite'} requiredAccessLevel - The minimum access level required.
     * @returns {boolean} - True if the user has the required permission, false otherwise.
     */
    checkPermission(accessingUserId, requiredAccessLevel) {
        if (!accessingUserId) {
            logger.debug('No accessingUserId provided for permission check.');
            return false;
        }

        logger.debug(`🔒 checkPermission: Checking if user ${accessingUserId} has ${requiredAccessLevel} for context ${this.#id}`);
        logger.debug(`🔒 checkPermission: Context owner: ${this.#userId}`);

        // Owner always has full permission
        if (accessingUserId === this.#userId) {
            logger.debug(`🔒 checkPermission: User is owner, granting full access`);
            return true;
        }

        let grantedAccessLevel = null;

        // Try old format first (acl[userId])
        if (this.#acl[accessingUserId]) {
            grantedAccessLevel = this.#acl[accessingUserId];
            logger.debug(`🔒 checkPermission: Found permission in old format: ${grantedAccessLevel}`);
        }

        // Try new format (acl.users[email] where we need to match by userId)
        if (!grantedAccessLevel && this.#acl.users) {
            logger.debug(`🔒 checkPermission: Checking new ACL format, found ${Object.keys(this.#acl.users).length} email entries`);
            for (const [email, shareData] of Object.entries(this.#acl.users)) {
                logger.debug(`🔒 checkPermission: Checking ${email} with userId ${shareData.userId}`);
                if (shareData.userId === accessingUserId) {
                    grantedAccessLevel = shareData.accessLevel;
                    logger.debug(`🔒 checkPermission: ✓ Found match! User ${accessingUserId} has ${grantedAccessLevel} via ${email}`);
                    break;
                }
            }
        }

        if (!grantedAccessLevel) {
            logger.debug(`🔒 checkPermission: ✗ User ${accessingUserId} has no explicit permissions granted for context ${this.#id}.`);
            logger.debug(`🔒 checkPermission: ACL contents:`, JSON.stringify(this.#acl, null, 2));
            return false;
        }

        // Define permission hierarchy
        const permissionHierarchy = {
            documentRead: 0,
            documentWrite: 1, // documentWrite implies read for simplicity in this check
            documentReadWrite: 2,
        };

        // For MVP, let's treat manage as a future permission above ReadWrite
        // const managePermissionLevel = 3;


        if (!(requiredAccessLevel in permissionHierarchy)) {
            logger.debug(`Unknown requiredAccessLevel: ${requiredAccessLevel}`);
            return false; // Or throw an error
        }

        if (!(grantedAccessLevel in permissionHierarchy)) {
            logger.debug(`User ${accessingUserId} has an unknown grantedAccessLevel: ${grantedAccessLevel}`);
            return false; // Or throw an error
        }

        const requiredLevel = permissionHierarchy[requiredAccessLevel];
        const grantedLevel = permissionHierarchy[grantedAccessLevel];

        // A user has permission if their granted level is equal to or higher than the required level.
        // Special handling for documentWrite: if documentWrite is required, documentRead is not enough.
        // If documentRead is required, documentWrite or documentReadWrite is enough.
        if (requiredAccessLevel === 'documentWrite') {
            return grantedAccessLevel === 'documentWrite' || grantedAccessLevel === 'documentReadWrite';
        }
        // For documentRead, any defined access level is sufficient.
        // For documentReadWrite, only documentReadWrite is sufficient.
        return grantedLevel >= requiredLevel;
    }

    async setClientContextArray(clientContextArray) {
        if (!Array.isArray(clientContextArray)) {
            clientContextArray = [clientContextArray];
        }

        this.#clientContextArray = clientContextArray;
        this.emit('context.updated', { id: this.#id, clientContextArray: this.#clientContextArray });

        // Save changes to index
        await this.#contextManager.saveContext(this.#userId, this);
    }

    async clearClientContextArray() {
        this.#clientContextArray = [];
        this.emit('context.updated', { id: this.#id, clientContextArray: this.#clientContextArray });

        // Save changes to index
        await this.#contextManager.saveContext(this.#userId, this);
    }

    setServerContextArray(serverContextArray) {
        if (!Array.isArray(serverContextArray)) {
            serverContextArray = [serverContextArray];
        }

        this.#serverContextArray = serverContextArray;
        this.emit('context.updated', { id: this.#id, serverContextArray: this.#serverContextArray });
    }

    async clearServerContextArray() {
        this.#serverContextArray = [];
        this.emit('context.updated', { id: this.#id, serverContextArray: this.#serverContextArray });

        // Save changes to index
        await this.#contextManager.saveContext(this.#userId, this);
    }

    async setUrl(url) {
        if (this.#isLocked) {
            throw new Error('Context is locked');
        }

        const parsed = new Url(url);
        if (!parsed.isValid) {
            throw new Error(`Invalid URL provided: ${url}`);
        }

        logger.debug(`Attempting to set URL to ${parsed.url}`);
        logger.debug(`Parsed URL: ${JSON.stringify({ workspaceId: parsed.workspaceId, path: parsed.path, pathArray: parsed.pathArray })}`);

        // Validate against base URL if it's set and not root
        if (this.#baseUrl && this.#baseUrl !== '/') {
            const base = new Url(this.#baseUrl);
            if (!parsed.path.startsWith(base.path)) {
                throw new Error(`Cannot set URL "${url}" outside the context base URL "${this.#baseUrl}"`);
            }
        }

        // Capture old state before any changes so we can unlock the previous path
        const previousUrl = this.#url;
        const previousPath = this.#path;
        const previousTree = this.#tree;

        // Determine target workspace name
        const targetWorkspaceName = parsed.workspaceId || this.#workspace.name;

        // If the workspace name is different, unlock the old path on the old tree first, then switch
        if (targetWorkspaceName !== this.#workspace.name) {
            if (!this.isUniverse) {
                throw new Error(`Workspace-scoped context cannot navigate to a different workspace. Target: "${targetWorkspaceName}", current: "${this.#workspace.name}"`);
            }
            if (previousPath && previousPath !== '/' && previousTree) {
                try {
                    await previousTree.unlockPath(previousPath, this.#id);
                } catch (err) {
                    logger.warn(`Context ${this.#id}: failed to unlock path "${previousPath}" on workspace switch: ${err.message}`);
                }
            }
            await this.#switchWorkspace(targetWorkspaceName);
        } else if (previousPath && previousPath !== '/' && previousPath !== parsed.path) {
            // Same workspace, moving to a different path — unlock the old one
            try {
                await previousTree.unlockPath(previousPath, this.#id);
            } catch (err) {
                logger.warn(`Context ${this.#id}: failed to unlock previous path "${previousPath}": ${err.message}`);
            }
        }

        // Create the URL path in the current workspace
        const contextLayers = await this.#tree.insertPath(parsed.path);
        this.#contextBitmapArray = parsed.pathArray;
        logger.debug(`ContextPath: ${parsed.path}, contextLayer IDs: ${JSON.stringify(contextLayers)}`);

        // Lock all layers along the new path by this context ID
        if (parsed.path && parsed.path !== '/') {
            try {
                await this.#tree.lockPath(parsed.path, this.#id);
            } catch (err) {
                logger.warn(`Context ${this.#id}: failed to lock new path "${parsed.path}": ${err.message}`);
            }
        }

        // Update the internal URL state - always use the target workspace name
        this.#url = `${targetWorkspaceName}://${parsed.path.replace(/^\//, '')}`;
        this.#path = parsed.path;
        this.#pathArray = parsed.pathArray;

        // Update the updated timestamp
        this.#updatedAt = new Date().toISOString();

        // Notify affected workspaces so M2 tree views can refresh lock state
        try {
            this.#workspace.emit('context.path.changed', { contextId: this.#id, workspaceName: this.#workspace.name });
        } catch (err) {
            logger.warn(`Context ${this.#id}: failed to emit context.path.changed: ${err.message}`);
        }

        // Emit the change event (include previousUrl so consumers know what path was vacated)
        logger.debug(`📋 Context: Emitting context.url.set event for context ${this.#id}, new URL: ${this.#url}`);
        this.emit('context.url.set', { id: this.#id, url: this.#url, previousUrl });

        // Save changes to index
        await this.#contextManager.saveContext(this.#userId, this);

        return Promise.resolve(this);
    }

    async setBaseUrl(newBaseUrl) {
        if (this.#isLocked) {
            throw new Error('Context is locked');
        }

        // Allow setting base URL back to '/' (effectively removing constraint)
        if (newBaseUrl !== '/') {
            // Validate the new base URL format itself
            const parsedNewBase = new Url(newBaseUrl);
            if (!parsedNewBase.isValid) {
                throw new Error(`Invalid base URL format: ${newBaseUrl}`);
            }
            // Ensure the new base URL is within the same workspace
            if (parsedNewBase.workspaceId && parsedNewBase.workspaceId !== this.#workspace.name) {
                throw new Error(`Cannot set base URL to a different workspace: ${newBaseUrl}`);
            }

            // Check if the current URL is compatible with the new base URL
            if (this.#url) {
                const currentParsed = new Url(this.#url);
                // Only check path if the current URL is actually in the same workspace
                if ((!currentParsed.workspaceId || currentParsed.workspaceId === this.#workspace.name) &&
                    !currentParsed.path.startsWith(parsedNewBase.path)) {
                    throw new Error(
                        `Current URL "${this.#url}" is outside the proposed new base URL "${newBaseUrl}". Please navigate within the new base URL before setting it.`,
                    );
                }
            }
        }

        logger.debug(`Setting base URL from "${this.#baseUrl}" to "${newBaseUrl}"`);
        this.#baseUrl = newBaseUrl;
        this.#updatedAt = new Date().toISOString();
        this.emit('context.updated', { id: this.#id, baseUrl: this.#baseUrl });

        // Save changes to index
        await this.#contextManager.saveContext(this.#userId, this);

        return Promise.resolve(this);
    }

    async setTree(nameOrId) {
        if (this.#isLocked) {
            throw new Error('Context is locked');
        }
        const tree = this.#workspace.getContextTree(nameOrId);
        this.#tree = tree;
        this.#treeId = tree.id;
        this.#updatedAt = new Date().toISOString();
        await this.#contextManager.saveContext(this.#userId, this);
        this.emit('context.tree.set', { id: this.#id, treeId: this.#treeId });
        return this;
    }

    async lock() {
        this.#isLocked = true;
        this.#updatedAt = new Date().toISOString();
        this.emit('context.locked', { id: this.#id, locked: this.#isLocked });

        // Save changes to index
        await this.#contextManager.saveContext(this.#userId, this);

        return Promise.resolve(this);
    }

    async unlock() {
        this.#isLocked = false;
        this.#updatedAt = new Date().toISOString();
        this.emit('context.unlocked', { id: this.#id, locked: this.#isLocked });

        // Save changes to index
        await this.#contextManager.saveContext(this.#userId, this);
    }

    destroy() {
        // Perform any cleanup needed
        this.#isLocked = true;

        // Clean up workspace event forwarding
        this.#cleanupWorkspaceEventForwarding();

        // Clear references
        this.#tree = null;
        this.#workspace = null;
        this.#workspaceManager = null;

        // Update the updated timestamp
        this.#updatedAt = new Date().toISOString();

        // Emit destroy event
        this.emit('context.deleted', { id: this.#id });

        // Remove all listeners
        this.removeAllListeners();

        return Promise.resolve(this);
    }

    async #switchWorkspace(workspaceName) {
        if (this.#isLocked) {
            throw new Error('Context is locked');
        }

        const hasWs = await this.#workspaceManager.hasWorkspace(this.#userId, workspaceName, this.#userId);
        if (!hasWs) {
            throw new Error(`Workspace "${workspaceName}" not found`);
        }

        try {
            // Clean up event forwarding from the old workspace
            this.#cleanupWorkspaceEventForwarding();

            const newWorkspaceInstance = await this.#workspaceManager.getWorkspace(this.#userId, workspaceName, this.#userId);
            this.#workspace = newWorkspaceInstance;
            try {
                this.#tree = this.#workspace.getContextTree(this.#treeId);
            } catch {
                this.#tree = this.#workspace.getDefaultContextTree();
                this.#treeId = this.#tree?.id || null;
            }
            this.#color = this.#workspace.color;

            // Set up event forwarding for the new workspace
            this.#setupWorkspaceEventForwarding();

            logger.debug(`Context "${this.#id}" successfully switched to workspace "${workspaceName}"`);
        } catch (error) {
            throw new Error(`Failed to switch workspace: ${error.message}`);
        }
    }

    /**
     * Bitmaps
     */

    setAttributes(attributeArray) {
        if (!Array.isArray(attributeArray)) { attributeArray = [attributeArray]; }
        this.#attributes = attributeArray;
        this.emit('context.updated', { id: this.#id, attributes: this.#attributes });
    }

    appendAttributes(attributeArray) {
        if (!Array.isArray(attributeArray)) { attributeArray = [attributeArray]; }
        this.#attributes.push(...attributeArray);
        this.emit('context.updated', { id: this.#id, attributes: this.#attributes });
    }

    removeAttributes(attributeArray) {
        if (!Array.isArray(attributeArray)) { attributeArray = [attributeArray]; }
        this.#attributes = this.#attributes.filter((a) => !attributeArray.includes(a));
        this.emit('context.updated', { id: this.#id, attributes: this.#attributes });
    }

    clearAttributes() {
        this.#attributes = [];
        this.emit('context.updated', { id: this.#id, attributes: this.#attributes });
    }



    /**
     * Rules API
     */

    async addRule(rule) {
        if (!rule || !rule.id || !rule.type) {
            throw new Error('Invalid rule object. Must have id and type.');
        }

        // Check for duplicate rule ID
        if (this.#rules.some(r => r.id === rule.id)) {
            throw new Error(`Rule with ID ${rule.id} already exists.`);
        }

        this.#rules.push(rule);
        this.#updatedAt = new Date().toISOString();
        this.emit('context.rule.added', { id: this.#id, rule });

        // Save changes
        await this.#contextManager.saveContext(this.#userId, this);
        return rule;
    }

    async removeRule(ruleId) {
        const initialLength = this.#rules.length;
        this.#rules = this.#rules.filter(r => r.id !== ruleId);

        if (this.#rules.length !== initialLength) {
            this.#updatedAt = new Date().toISOString();
            this.emit('context.rule.removed', { id: this.#id, ruleId });

            // Save changes
            await this.#contextManager.saveContext(this.#userId, this);
            return true;
        }
        return false;
    }

    /**
     * Document API
     */

    async put(accessingUserId, document, features = [], options = {}) {
        if (!this.checkPermission(accessingUserId, 'documentWrite')) {
            throw new Error('Access denied: User requires documentWrite permission.');
        }
        const workspace = this.#requireWorkspace();
        if (!document) {
            throw new Error('Document is required');
        }

        const contextSelector = this.#buildContextSelector([
            ...this.#pathArray,
            ...this.#serverContextArray,
            ...this.#clientContextArray,
        ]);

        const result = await workspace.put(document, {
            context: contextSelector,
            features: [...this.#attributes, ...features],
            emitEvent: options.emitEvent,
        });

        const documentId = document.id || result.id || result;
        this.emit('document.inserted', {
            contextId: this.#id,
            id: documentId,
            document,
            context: contextSelector,
            features,
            workspaceId: this.#workspace.id,
            timestamp: new Date().toISOString(),
        });

        return result;
    }

    async putMany(accessingUserId, documentArray, features = [], options = {}) {
        if (!this.checkPermission(accessingUserId, 'documentWrite')) {
            throw new Error('Access denied: User requires documentWrite permission.');
        }
        const workspace = this.#requireWorkspace();
        if (!Array.isArray(documentArray)) {
            throw new Error('Document array must be an array');
        }

        const contextSelector = this.#buildContextSelector([
            ...this.#pathArray,
            ...this.#serverContextArray,
            ...this.#clientContextArray,
        ]);

        const result = await workspace.putMany(documentArray, {
            context: contextSelector,
            features: [...this.#attributes, ...features],
            emitEvent: options.emitEvent,
        });

        const documentIds = Array.isArray(result)
            ? result
            : documentArray.map((doc) => doc.id).filter((id) => id != null);

        this.emit('document.inserted', {
            contextId: this.#id,
            documentIds,
            context: contextSelector,
            features,
            workspaceId: this.#workspace.id,
            timestamp: new Date().toISOString(),
        });

        return result;
    }

    async getByChecksumString(accessingUserId, checksumString) {
        if (!this.checkPermission(accessingUserId, 'documentRead')) {
            throw new Error('Access denied: User requires documentRead permission.');
        }
        const workspace = this.#requireWorkspace();
        if (!checksumString || typeof checksumString !== 'string') {
            throw new Error('Checksum string is required.');
        }
        return await workspace.getByChecksumString(checksumString);
    }

    async hasByChecksumString(accessingUserId, checksum, features = []) {
        if (!this.checkPermission(accessingUserId, 'documentRead')) {
            throw new Error('Access denied: User requires documentRead permission.');
        }
        const workspace = this.#requireWorkspace();

        const contextSelector = this.#buildContextSelector(this.#contextBitmapArray);
        return await workspace.hasByChecksumString(checksum, {
            context: contextSelector,
            features,
        });
    }

    async unlink(accessingUserId, documentId, features, options = {}) {
        if (!this.checkPermission(accessingUserId, 'documentReadWrite')) {
            throw new Error('Access denied: User requires documentReadWrite permission.');
        }
        const workspace = this.#requireWorkspace();

        const contextSelector = this.#buildContextSelector(this.#contextBitmapArray);
        const result = await workspace.unlink(documentId, {
            context: contextSelector,
            features,
        }, options);

        this.emit('document.removed', {
            contextId: this.#id,
            id: documentId,
            context: contextSelector,
            features,
            workspaceId: this.#workspace.id,
            timestamp: new Date().toISOString(),
        });

        return result;
    }

    async unlinkMany(accessingUserId, documentIdArray, features, options = {}) {
        if (!this.checkPermission(accessingUserId, 'documentReadWrite')) {
            throw new Error('Access denied: User requires documentReadWrite permission.');
        }
        const workspace = this.#requireWorkspace();
        if (!Array.isArray(documentIdArray)) {
            throw new Error('Document ID array must be an array');
        }

        const numericDocumentIdArray = parseDocumentIdArray(documentIdArray, 'Document ID array');
        const contextSelector = this.#buildContextSelector(this.#contextBitmapArray);
        const result = await workspace.unlinkMany(numericDocumentIdArray, {
            context: contextSelector,
            features,
        }, options);

        this.emit('document.removed.batch', {
            contextId: this.#id,
            documentIds: numericDocumentIdArray,
            context: contextSelector,
            features,
            workspaceId: this.#workspace.id,
            timestamp: new Date().toISOString(),
        });

        return result;
    }

    async deleteMany(accessingUserId, documentIdArray, options = {}) {
        if (accessingUserId !== this.#userId) {
            throw new Error('Access denied: Only the context owner can delete documents directly from the database.');
        }
        if (!this.checkPermission(accessingUserId, 'documentReadWrite')) {
            throw new Error('Access denied: User requires documentReadWrite permission for direct DB deletion.');
        }
        const workspace = this.#requireWorkspace();
        if (!Array.isArray(documentIdArray)) {
            throw new Error('Document ID array must be an array');
        }

        const numericDocumentIdArray = parseDocumentIdArray(documentIdArray, 'Document ID array');
        const result = await workspace.deleteMany(numericDocumentIdArray, options);

        this.emit('document.deleted.batch', {
            contextId: this.#id,
            documentIds: numericDocumentIdArray,
            count: numericDocumentIdArray.length,
            workspaceId: this.#workspace.id,
            timestamp: new Date().toISOString(),
        });

        return result;
    }

    async getDocumentById(accessingUserId, id, options = { parse: true }) {
        // This is a direct DB access method, only context owner should call it.
        if (accessingUserId !== this.#userId) {
            throw new Error('Access denied: This operation is only available to the context owner.');
        }
        return await this.#requireWorkspace().getDocumentById(id, options);
    }

    async getDocumentsByIdArray(accessingUserId, idArray, options = { parse: true, limit: null }) {
        if (accessingUserId !== this.#userId) {
            throw new Error('Access denied: This operation is only available to the context owner.');
        }
        return await this.#requireWorkspace().getDocumentsByIdArray(idArray, options);
    }

    async hasDocument(accessingUserId, id, featureArray = []) {
        if (!this.checkPermission(accessingUserId, 'documentRead')) {
            throw new Error('Access denied: User requires documentRead permission.');
        }
        const workspace = this.#requireWorkspace();

        const contextSelector = this.#buildContextSelector(this.#contextBitmapArray);
        return await workspace.has(id, {
            context: contextSelector,
            features: featureArray,
        });
    }

    async list(accessingUserId, spec = {}) {
        if (!this.checkPermission(accessingUserId, 'documentRead')) {
            throw new Error('Access denied: User requires documentRead permission.');
        }
        const workspace = this.#requireWorkspace();

        const { attributes, features = null, filters, options = {}, ...rest } = spec;
        const contextSelector = this.#buildContextSelector(this.#buildMergedContextArray(options));
        return await workspace.list({
            context: contextSelector,
            features: features ?? attributes,
            filters,
            ...options,
            ...rest,
        });
    }

    async search(accessingUserId, spec = {}) {
        if (!this.checkPermission(accessingUserId, 'documentRead')) {
            throw new Error('Access denied: User requires documentRead permission.');
        }
        const workspace = this.#requireWorkspace();

        const { query, attributes, features = null, filters, options = {}, ...rest } = spec;
        const contextSelector = this.#buildContextSelector(this.#buildMergedContextArray(options));
        return await workspace.search({
            query,
            context: contextSelector,
            features: features ?? attributes,
            filters,
            ...options,
            ...rest,
        });
    }



    /**
     * Utils
     */

    toJSON() {
        return {
            id: this.#id,
            name: this.#name,
            scope: this.#scope,
            userId: this.#userId,
            url: this.#url,
            baseUrl: this.#baseUrl,
            path: this.#path,
            pathArray: this.#pathArray,
            workspaceId: this.#workspace?.id,
            workspaceName: this.#workspace?.name,
            workspaceActive: this.#workspace?.isActive ?? false,
            treeId: this.#treeId,
            color: this.#color,
            acl: this.#acl,
            createdAt: this.#createdAt,
            updatedAt: this.#updatedAt,
            locked: this.#isLocked,
            serverContextArray: this.#serverContextArray,
            clientContextArray: this.#clientContextArray,
            contextBitmapArray: this.#contextBitmapArray,
            attributes: this.#attributes,
            filters: this.#filters,
            pendingUrl: this.#pendingUrl || null,
            rules: this.#rules,
        };
    }

    async getDocumentByChecksum(accessingUserId, checksumString, featureArray = []) {
        if (!this.checkPermission(accessingUserId, 'documentRead')) {
            throw new Error('Access denied: User requires documentRead permission.');
        }
        const workspace = this.#requireWorkspace();
        if (!checksumString || typeof checksumString !== 'string') {
            throw new Error('Checksum string is required.');
        }

        const documentInContext = await workspace.getByChecksumString(checksumString);
        if (!documentInContext) {
            logger.debug(`Document with checksum '${checksumString}' not found within context path '${this.#path}'.`);
            return null;
        }

        if (featureArray && featureArray.length > 0) {
            const contextSelector = this.#buildContextSelector(this.#contextBitmapArray);
            const matchesAttributes = await workspace.has(documentInContext.id, {
                context: contextSelector,
                features: featureArray,
            });
            if (!matchesAttributes) {
                logger.debug(`Document ID '${documentInContext.id}' (checksum '${checksumString}') found but does not match features: [${featureArray.join(', ')}].`);
                return null;
            }
        }

        return documentInContext;
    }

    /**
     * Setup event forwarding from workspace to context
     * @private
     */
    #setupWorkspaceEventForwarding() {
        if (!this.#workspace) return;

        logger.debug(`Setting up workspace event forwarding for context "${this.#id}" (wild-card mode)`);

        const handler = (eventName, payload) => {
            const enriched = {
                contextId: this.#id,
                contextUrl: this.#url,
                contextPath: this.#path,
                userId: this.#userId,
                ...payload
            };

            this.emit(`context.workspace.${eventName}`, enriched);

            if (eventName.startsWith('document.')) {
                this.emit(eventName, { contextId: this.#id, ...enriched });
                this.emit('context.updated', {
                    id: this.#id,
                    event: eventName,
                    documentId: enriched.id || enriched.documentId,
                    documentIds: enriched.documentIds,
                });
            }
        };

        this.#workspaceEventHandlers = handler;
        this.#workspace.onAny(handler);
    }

    /**
     * Clean up workspace event forwarding
     * @private
     */
    #cleanupWorkspaceEventForwarding() {
        if (this.#workspace && this.#workspaceEventHandlers) {
            this.#workspace.offAny(this.#workspaceEventHandlers);
            this.#workspaceEventHandlers = null;
            logger.debug(`Workspace event forwarding cleanup completed for context "${this.#id}"`);
        }
    }
}

export default Context;
