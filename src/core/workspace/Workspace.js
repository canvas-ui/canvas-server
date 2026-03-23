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
import {
    buildMountedIncomingTree,
    resolveMountedDocumentScope,
    DEFAULT_DOCUMENT_DATASET,
    INCOMING_DOCUMENT_DATASET,
    normalizeDocumentDataset,
} from './lib/documentDataset.js';

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
    * Getters / Setters
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

    get services() {
        return this.#configStore.get('services') || {
            dotfiles: { enabled: false },
            home: { enabled: false, transports: ['webdav'] },
        };
    }

    get db() {
        if (!this.#db) throw new Error('Database not initialized');
        return this.#db;
    }

    get stats() {
        if (!this.isActive || !this.#db) return null;
        return this.#db.stats;
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

    get homePath() {
        return path.join(this.#rootPath, WORKSPACE_DIRECTORIES.home);
    }

    isServiceEnabled(serviceName) {
        const services = this.services;
        return services[serviceName]?.enabled === true;
    }

    setServiceConfig(serviceName, config) {
        const services = this.services;
        services[serviceName] = { ...services[serviceName], ...config };
        this.#configStore.set('services', services);
        this.emit('services.changed', { service: serviceName, config: services[serviceName] });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UI Configuration
    // ─────────────────────────────────────────────────────────────────────────

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

    // ─────────────────────────────────────────────────────────────────────────
    // Links
    // ─────────────────────────────────────────────────────────────────────────

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

    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    async start() {
        if (this.isActive) return this;

        this.#logger.debug({ workspaceId: this.id }, 'Starting workspace');
        try {
            // Initialize DB
            const dbPath = path.join(this.#rootPath, WORKSPACE_DIRECTORIES.db || 'Db');
            this.#db = new Db({ path: dbPath });
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

    // ─────────────────────────────────────────────────────────────────────────
    // CRUD Methods
    // ─────────────────────────────────────────────────────────────────────────

    async insert(data, { context = '/', directory = null, features = [], emitEvent = true, dataset = DEFAULT_DOCUMENT_DATASET } = {}) {
        if (!this.isActive) throw new Error('Workspace not active');
        const scope = resolveMountedDocumentScope({ dataset, contextSpec: context });
        return await this.db.insertDocument(data, { context: scope.contextSpec, directory, features, emitEvent, dataset: scope.dataset });
    }

    async update(id, data, { context = null, directory = null, features = [], dataset = DEFAULT_DOCUMENT_DATASET } = {}) {
        if (!this.isActive) throw new Error('Workspace not active');
        const scope = context === null
            ? { dataset: normalizeDocumentDataset(dataset), contextSpec: null }
            : resolveMountedDocumentScope({ dataset, contextSpec: context });
        return await this.db.updateDocument(id, data, { context: scope.contextSpec, directory, features, dataset: scope.dataset });
    }

    async remove(id, { context = '/', features = [], dataset = DEFAULT_DOCUMENT_DATASET } = {}) {
        if (!this.isActive) throw new Error('Workspace not active');
        const scope = resolveMountedDocumentScope({ dataset, contextSpec: context });
        return await this.db.removeDocument(id, { context: scope.contextSpec, features, dataset: scope.dataset });
    }

    async delete(id, { dataset = DEFAULT_DOCUMENT_DATASET } = {}) {
        if (!this.isActive) throw new Error('Workspace not active');
        return await this.db.deleteDocument(parseDocumentId(id, 'Document ID'), { dataset });
    }

    async get(id, options = { parse: true, dataset: DEFAULT_DOCUMENT_DATASET }) {
        if (!this.isActive) throw new Error('Workspace not active');
        return await this.db.getDocumentById(id, options);
    }

    async list(options = {}) {
         if (!this.isActive) throw new Error('Workspace not active');
         const { contextSpec = '/', featureBitmapArray = [], filterArray = [], dataset = DEFAULT_DOCUMENT_DATASET, ...rest } = options;
         const scope = resolveMountedDocumentScope({ dataset, contextSpec });
         return await this.db.findDocuments(scope.contextSpec, featureBitmapArray, filterArray, { ...rest, dataset: scope.dataset });
    }

    async getMountedTree() {
        if (!this.isActive || !this.#db) { throw new Error('Workspace not active'); }
        const incomingTree = await this.#db.getJsonTreeForDataset(INCOMING_DOCUMENT_DATASET);
        return buildMountedIncomingTree(this.#db.jsonTree, incomingTree);
    }

    async listBitmaps(prefix = '', { includeData = false } = {}) {
        if (!this.isActive) throw new Error('Workspace not active');
        const keys = await this.db.bitmapIndex.listBitmaps(prefix);
        const bitmaps = await Promise.all(keys.map(async (key) => this.getBitmap(key, { includeData })));
        return bitmaps.filter(Boolean);
    }

    async getBitmap(key, { includeData = false } = {}) {
        if (!this.isActive) throw new Error('Workspace not active');
        if (!key || typeof key !== 'string') throw new Error('Bitmap key is required');

        const bitmap = await this.db.bitmapIndex.getBitmap(key, false);
        if (!bitmap) return null;

        const out = {
            key: bitmap.key,
            size: bitmap.size,
            isEmpty: bitmap.isEmpty,
            min: bitmap.isEmpty ? null : bitmap.minimum(),
            max: bitmap.isEmpty ? null : bitmap.maximum(),
        };

        if (includeData) out.ids = bitmap.toArray();
        return out;
    }

    async getBitmapRawBuffer(key) {
        if (!this.isActive) throw new Error('Workspace not active');
        if (!key || typeof key !== 'string') throw new Error('Bitmap key is required');

        const bitmap = await this.db.bitmapIndex.getBitmap(key, false);
        if (!bitmap) return null;

        const serialized = bitmap.serialize(true); // Roaring portable format
        return Buffer.isBuffer(serialized) ? serialized : Buffer.from(serialized);
    }

    clearDatabaseSync() {
        if (!this.isActive) { throw new Error('Workspace not active'); }
        return this.db.clearSync();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Token Management
    // ─────────────────────────────────────────────────────────────────────────

    createToken(options = {}) {
        const tokenId = uuidv4();
        const name = options.name || 'Workspace token';
        const description = options.description || '';
        const permissions = options.permissions || ['read', 'write'];
        const expiresAt = options.expiresAt || null;

        const randomPart = crypto.randomBytes(24).toString('hex');
        const tokenValue = `canvas-workspace-${randomPart}`;
        const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');

        const token = { id: tokenId, name, description, permissions, createdAt: new Date().toISOString(), expiresAt };

        const acl = this.#configStore.get('acl') || { tokens: {} };
        if (!acl.tokens) acl.tokens = {};
        acl.tokens[`sha256:${tokenHash}`] = token;
        this.#configStore.set('acl', acl);

        return { ...token, value: tokenValue, hash: `sha256:${tokenHash}` };
    }

    listTokens() {
        const acl = this.#configStore.get('acl') || { tokens: {} };
        return Object.entries(acl.tokens || {}).map(([hash, token]) => ({ ...token, hash }));
    }

    deleteToken(hash) {
        const acl = this.#configStore.get('acl') || { tokens: {} };
        if (!acl.tokens || !acl.tokens[hash]) return false;
        delete acl.tokens[hash];
        this.#configStore.set('acl', acl);
        return true;
    }

    verifyToken(tokenValue) {
        if (!tokenValue) return null;

        const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');
        const hashKey = `sha256:${tokenHash}`;

        const acl = this.#configStore.get('acl') || { tokens: {} };
        const token = acl.tokens?.[hashKey];
        if (!token) return null;
        if (token.expiresAt && new Date(token.expiresAt) < new Date()) return null;

        return { ...token, workspaceId: this.id, workspaceName: this.name };
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

    #setStatus(status) {
        if (this.#status !== status) {
            this.#status = status;
            this.emit('status.changed', { id: this.id, status });
        }
    }
}

export default Workspace;
