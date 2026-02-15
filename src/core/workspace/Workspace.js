'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import path from 'path';
import Conf from 'conf';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

// Logging
import { createLogger } from '../../utils/log.js';

// Includes
import Db from '../../services/synapsd/src/index.js';
import { parseDocumentId } from '../../utils/documentId.js';

// Constants
import {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DIRECTORIES,
} from './lib/constants.js';

/*
 * Workspace
 */

class Workspace extends EventEmitter {

    #rootPath = null;
    #configStore = null;
    #logger;

    #db = null;
    #status = WORKSPACE_STATUS_CODES.INACTIVE;

    // Managers (injected)
    #storageManager = null;
    #roleManager = null;

    constructor(options) {
        super(options.eventEmitterOptions);
        this.options = options;

        if (!options.rootPath) {
            throw new Error('Root path is required');
        }

        this.#rootPath = options.rootPath;

        if (!options.configStore) {
            throw new Error('Config store is required');
        }

        this.#configStore = options.configStore;
        this.#logger = options.logger || createLogger('workspace');

        // Managers can be optional
        this.#storageManager = options.storageManager;
        this.#roleManager = options.roleManager;

        // Initialize status from config if available
        const persistedStatus = this.#configStore.get('status');
        if (persistedStatus && Object.values(WORKSPACE_STATUS_CODES).includes(persistedStatus)) {
             if ([WORKSPACE_STATUS_CODES.ACTIVE, WORKSPACE_STATUS_CODES.INACTIVE, WORKSPACE_STATUS_CODES.ERROR].includes(persistedStatus)) {
                 this.#status = persistedStatus;
            }
        }
    }

    /*
    * Getters
    */
    get id() { return this.#configStore.get('id'); }
    get name() { return this.#configStore.get('name'); }
    get label() { return this.#configStore.get('label', this.name || this.id); }
    get description() { return this.#configStore.get('description'); }
    get color() { return this.#configStore.get('color'); }
    get icon() { return this.#configStore.get('icon', null); }
    get homeScreen() { return this.#configStore.get('homeScreen', {}); }
    get links() { return this.#configStore.get('links', {}); }
    get type() { return this.#configStore.get('type', 'workspace'); }
    get owner() { return this.#configStore.get('owner'); }
    get rootPath() { return this.#rootPath; }
    get status() { return this.#status; }
    get isActive() { return this.#status === WORKSPACE_STATUS_CODES.ACTIVE; }
    get config() { return this.#configStore.store; }
    get acl() { return this.#configStore.get('acl'); }

    /**
     * Get services configuration
     */
    get services() {
        return this.#configStore.get('services') || {
            dotfiles: { enabled: false },
            home: { enabled: false, transports: ['webdav'] },
        };
    }

    /**
     * Check if a specific service is enabled
     */
    isServiceEnabled(serviceName) {
        const services = this.services;
        return services[serviceName]?.enabled === true;
    }

    /**
     * Update service configuration
     */
    setServiceConfig(serviceName, config) {
        const services = this.services;
        services[serviceName] = { ...services[serviceName], ...config };
        this.#configStore.set('services', services);
        this.emit('services.changed', { service: serviceName, config: services[serviceName] });
    }

    /**
     * Workspace UI configuration
     */
    setIcon(url) {
        if (url == null || url === '') {
            this.#configStore.set('icon', null);
            this.emit('icon.changed', { id: this.id, icon: null });
            return true;
        }
        if (typeof url !== 'string') return false;
        this.#configStore.set('icon', url);
        this.emit('icon.changed', { id: this.id, icon: url });
        return true;
    }

    setHomeScreen(homeScreen) {
        if (homeScreen == null) {
            this.#configStore.set('homeScreen', {});
            this.emit('homeScreen.changed', { id: this.id, homeScreen: {} });
            return true;
        }
        if (typeof homeScreen !== 'object' || Array.isArray(homeScreen)) return false;
        this.#configStore.set('homeScreen', homeScreen);
        this.emit('homeScreen.changed', { id: this.id, homeScreen });
        return true;
    }

    /**
     * Workspace-linked resources
     *
     * Stored as:
     *  {
     *    links: {
     *      agents: ["canvas://canvas.local/agents/<id>", ...],
     *      contexts: [...],
     *      ...
     *    }
     *  }
     */
    listLinks(type = null) {
        const links = this.links || {};
        if (!type) return links;
        return Array.isArray(links[type]) ? links[type] : [];
    }

    addLink(type, ref) {
        if (!type || typeof type !== 'string') return false;
        if (!ref || typeof ref !== 'string') return false;

        const links = this.links || {};
        const arr = Array.isArray(links[type]) ? links[type] : [];
        if (arr.includes(ref)) return true;

        links[type] = [...arr, ref];
        this.#configStore.set('links', links);
        this.emit('links.changed', { id: this.id, type, action: 'add', ref });
        return true;
    }

    removeLink(type, ref) {
        if (!type || typeof type !== 'string') return false;
        if (!ref || typeof ref !== 'string') return false;

        const links = this.links || {};
        const arr = Array.isArray(links[type]) ? links[type] : [];
        if (!arr.length) return true;

        const next = arr.filter(r => r !== ref);
        links[type] = next;
        this.#configStore.set('links', links);
        this.emit('links.changed', { id: this.id, type, action: 'remove', ref });
        return true;
    }

    get db() {
        if (!this.#db) throw new Error('Database not initialized');
        return this.#db;
    }

    get tree() {
        if (!this.isActive || !this.#db?.tree) throw new Error('Tree not available');
        return this.#db.tree;
    }

    get directoryTree() {
        if (!this.isActive || !this.#db?.directoryTree) throw new Error('Directory tree not available');
        return this.#db.directoryTree;
    }

    get jsonTree() {
        if (!this.isActive || !this.#db) { throw new Error('Workspace not active'); }
        return this.#db.jsonTree;
    }

    /*
    * Lifecycle Methods
    */

    async start() {
        if (this.isActive) return this;

        this.#logger.debug({ workspaceId: this.id }, 'Starting workspace');
        try {
            // Initialize DB
             const dbPath = path.join(this.#rootPath, WORKSPACE_DIRECTORIES.db || 'Db');
             this.#db = new Db({
                path: dbPath,
             });

            await this.#db.start();
            this.#setStatus(WORKSPACE_STATUS_CODES.ACTIVE);
            this.emit('started', { id: this.id });
            return this;
        } catch (err) {
            console.error(`Failed to start workspace "${this.id}": ${err.message}`);
            this.#setStatus(WORKSPACE_STATUS_CODES.ERROR);
            throw err;
        }
    }

    async stop() {
        if (this.#status === WORKSPACE_STATUS_CODES.INACTIVE) return true;

        this.#logger.debug({ workspaceId: this.id }, 'Stopping workspace');
        try {
            if (this.#db) {
                await this.#db.shutdown();
                this.#db = null;
            }
            this.#setStatus(WORKSPACE_STATUS_CODES.INACTIVE);
            this.emit('stopped', { id: this.id });
            return true;
        } catch (err) {
             console.error(`Error stopping workspace "${this.id}": ${err.message}`);
             this.#setStatus(WORKSPACE_STATUS_CODES.ERROR);
             return false;
        }
    }

    #setStatus(status) {
        if (this.#status !== status) {
            this.#status = status;
            this.emit('status.changed', { id: this.id, status });
        }
    }

    /**
     * CRUD Methods
     */

    async insert(data, { context = '/', directory = null, features = [], emitEvent = true } = {}) {
        if (!this.isActive) throw new Error('Workspace not active');
        return await this.db.insertDocument(data, { context, directory, features, emitEvent });
    }

    async update(id, data, { context = null, directory = null, features = [] } = {}) {
        if (!this.isActive) throw new Error('Workspace not active');
        return await this.db.updateDocument(id, data, { context, directory, features });
    }

    async remove(id, { context = '/', features = [] } = {}) {
        if (!this.isActive) throw new Error('Workspace not active');
        return await this.db.removeDocument(id, context, features);
    }

    async delete(id) {
        if (!this.isActive) throw new Error('Workspace not active');
        return await this.db.deleteDocument(parseDocumentId(id, 'Document ID'));
    }

    async get(id, options = { parse: true }) {
        if (!this.isActive) throw new Error('Workspace not active');
        return await this.db.getDocumentById(id, options);
    }

    async list(options = {}) {
         if (!this.isActive) throw new Error('Workspace not active');
         const { contextSpec = '/', featureBitmapArray = [], filterArray = [], ...rest } = options;
         return await this.db.findDocuments(contextSpec, featureBitmapArray, filterArray, rest);
    }

    clearDatabaseSync() {
        if (!this.isActive) { throw new Error('Workspace not active'); }
        return this.db.clearSync();
    }

    /**
     * Token Management Methods
     */

    /**
     * Create a new access token for this workspace
     * @param {Object} options - Token options
     * @param {string} options.name - Token name
     * @param {string} options.description - Token description
     * @param {Array<string>} options.permissions - Permissions array (e.g., ['read', 'write'])
     * @param {string|null} options.expiresAt - Expiration date (ISO string) or null
     * @returns {Object} - Created token with value
     */
    createToken(options = {}) {
        const tokenId = uuidv4();
        const name = options.name || 'Workspace token';
        const description = options.description || '';
        const permissions = options.permissions || ['read', 'write'];
        const expiresAt = options.expiresAt || null;

        // Generate token value with canvas-workspace- prefix
        const randomPart = crypto.randomBytes(24).toString('hex');
        const tokenValue = `canvas-workspace-${randomPart}`;
        const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');

        const token = {
            id: tokenId,
            name,
            description,
            permissions,
            createdAt: new Date().toISOString(),
            expiresAt
        };

        // Get current ACL
        const acl = this.#configStore.get('acl') || { tokens: {} };
        if (!acl.tokens) acl.tokens = {};

        // Store with sha256: prefix to match the template structure
        acl.tokens[`sha256:${tokenHash}`] = token;

        // Save to config
        this.#configStore.set('acl', acl);

        // Return token with value (only returned on creation)
        return {
            ...token,
            value: tokenValue,
            hash: `sha256:${tokenHash}`
        };
    }

    /**
     * List all tokens for this workspace
     * @returns {Array<Object>} - Array of tokens (without hashes)
     */
    listTokens() {
        const acl = this.#configStore.get('acl') || { tokens: {} };
        const tokens = acl.tokens || {};

        return Object.entries(tokens).map(([hash, token]) => ({
            ...token,
            hash // Include the hash key for deletion
        }));
    }

    /**
     * Delete a token by hash
     * @param {string} hash - Token hash (with sha256: prefix)
     * @returns {boolean} - True if deleted
     */
    deleteToken(hash) {
        const acl = this.#configStore.get('acl') || { tokens: {} };
        if (!acl.tokens || !acl.tokens[hash]) {
            return false;
        }

        delete acl.tokens[hash];
        this.#configStore.set('acl', acl);
        return true;
    }

    /**
     * Verify a token against this workspace's ACL
     * @param {string} tokenValue - Token value to verify
     * @returns {Object|null} - Token data if valid, null otherwise
     */
    verifyToken(tokenValue) {
        if (!tokenValue) return null;

        const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');
        const hashKey = `sha256:${tokenHash}`;

        const acl = this.#configStore.get('acl') || { tokens: {} };
        const token = acl.tokens?.[hashKey];

        if (!token) return null;

        // Check if token is expired
        if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
            return null;
        }

        return {
            ...token,
            workspaceId: this.id,
            workspaceName: this.name
        };
    }

    toJSON() {
        return {
            ...this.config,
            id: this.id,
            icon: this.icon,
            homeScreen: this.homeScreen,
            status: this.status,
            isActive: this.isActive,
            rootPath: this.rootPath
        };
    }
}

export default Workspace;
