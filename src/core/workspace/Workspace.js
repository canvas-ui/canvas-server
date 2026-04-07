'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import * as fsPromises from 'fs/promises';
import path from 'path';
import Conf from 'conf';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
// Logging
import { createLogger } from '../../utils/log.js';

// Includes
import Db from '../../services/synapsd/src/index.js';
import Stored from '../../services/stored/src/index.js';
import { parseDocumentId, parseDocumentIdArray } from '../../utils/documentId.js';
import {
    getIncomingFileContextFromStoredLocation,
    normalizeIncomingTreePath,
    shouldExcludeIncoming,
} from '../../utils/incoming-documents.js';

// Constants
import {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DIRECTORIES,
    WORKSPACE_SERVICES,
} from './lib/constants.js';

/*
 * Workspace
 */

class Workspace extends EventEmitter {
    static HOME_STORED_BACKEND = 'fs:home';
    static HOME_BACKEND_FEATURE = 'data/backend/home';
    static INCOMING_TREE_NAME = 'incoming';
    static DEFAULT_CONTEXT_TREE_NAME = 'default';

    #rootPath = null;
    #configStore = null;
    #logger;

    #db = null;
    #stored = null;
    #status = WORKSPACE_STATUS_CODES.INACTIVE;
    #runtimeListeners = [];
    #storedListeners = [];

    // Managers (injected)
    #storageManager = null;
    #roleManager = null;

    constructor(options) {
        super({
            wildcard: true,
            delimiter: '.',
            newListener: false,
            maxListeners: 100,
            ...(options.eventEmitterOptions || {})
        });
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
        return {
            ...WORKSPACE_SERVICES,
            ...(this.#configStore.get('services') || {}),
        };
    }

    get db() {
        if (!this.#db) throw new Error('Database not initialized');
        return this.#db;
    }

    get stored() {
        return this.#stored;
    }

    get stats() {
        if (!this.isActive || !this.#db) return null;
        return this.#db.stats;
    }

    get homePath() {
        return path.join(this.#rootPath, WORKSPACE_DIRECTORIES.home);
    }

    get dataPath() {
        return path.join(this.#rootPath, WORKSPACE_DIRECTORIES.data);
    }

    get hooksPath() {
        return path.join(this.#rootPath, WORKSPACE_DIRECTORIES.hooks);
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
            await Promise.all([
                fsPromises.mkdir(this.dataPath, { recursive: true }),
                fsPromises.mkdir(this.homePath, { recursive: true }),
                fsPromises.mkdir(this.hooksPath, { recursive: true }),
            ]);

            // Initialize DB
            const dbPath = path.join(this.#rootPath, WORKSPACE_DIRECTORIES.db || 'Db');
            this.#db = new Db({ path: dbPath });
            await this.#db.start();
            await this.#ensureContextTree();
            await this.#ensureDirectoryTree();
            await this.#ensureIncomingTree();
            this.#bindRuntimeEvents();
            await this.#startStoredHomeIndex();

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
            await this.#stopStoredHomeIndex();
            if (this.#db) {
                this.#unbindRuntimeEvents();
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

    #getActiveDb() {
        if (!this.isActive || !this.#db) {
            throw new Error('Workspace not active');
        }
        return this.#db;
    }

    #normalizeFeatureInput(features = [], attributes) {
        return features.length > 0 ? features : (attributes?.allOf ?? attributes ?? []);
    }

    #normalizeQuerySpec(spec = {}) {
        const { attributes, features = null, ...rest } = spec;
        return {
            ...rest,
            ...(features != null ? { features } : {}),
            ...(features == null && attributes != null ? { features: attributes } : {}),
        };
    }

    async put(record, { context = '/', directory = null, features = [], attributes, emitEvent = true } = {}) {
        const db = this.#getActiveDb();
        return await db.put(record, {
            context: this.#normalizeTreeSelector('context', context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector('directory', directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
        });
    }

    async link(id, { context = '/', directory = null, features = [], attributes, emitEvent = true } = {}) {
        const db = this.#getActiveDb();
        return await db.link(id, {
            context: this.#normalizeTreeSelector('context', context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector('directory', directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
        });
    }

    async unlink(id, { context = null, directory = null, features = [], attributes } = {}, options = {}) {
        const db = this.#getActiveDb();
        return await db.unlink(id, {
            context: context == null ? null : this.#normalizeTreeSelector('context', context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector('directory', directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
        }, options);
    }

    async delete(id) {
        return await this.#getActiveDb().delete(parseDocumentId(id, 'Document ID'));
    }

    async get(id, options = { parse: true }) {
        return await this.#getActiveDb().get(parseDocumentId(id, 'Document ID'), options);
    }

    async has(id, { context = null, directory = null, features = [], attributes } = {}) {
        const db = this.#getActiveDb();
        return await db.has(parseDocumentId(id, 'Document ID'), {
            context: context == null ? null : this.#normalizeTreeSelector('context', context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector('directory', directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    async putMany(records, { context = '/', directory = null, features = [], attributes } = {}) {
        const db = this.#getActiveDb();
        return await db.putMany(records, {
            context: this.#normalizeTreeSelector('context', context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector('directory', directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    async linkMany(ids, { context = '/', directory = null, features = [], attributes, emitEvent = true } = {}) {
        const db = this.#getActiveDb();
        return await db.linkMany(parseDocumentIdArray(ids, 'Document ID array'), {
            context: this.#normalizeTreeSelector('context', context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector('directory', directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
        });
    }

    async unlinkMany(ids, { context = null, directory = null, features = [], attributes } = {}, options = {}) {
        const db = this.#getActiveDb();
        return await db.unlinkMany(parseDocumentIdArray(ids, 'Document ID array'), {
            context: context == null ? null : this.#normalizeTreeSelector('context', context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector('directory', directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
        }, options);
    }

    async deleteMany(ids, options = {}) {
        return await this.#getActiveDb().deleteMany(parseDocumentIdArray(ids, 'Document ID array'), options);
    }

    async getByChecksumString(checksumString, options = { parse: true }) {
        return await this.#getActiveDb().getByChecksumString(checksumString, options);
    }

    async listDocumentTreeMemberships(id, treeNameOrId) {
        return await this.#getActiveDb().listDocumentTreeMemberships(parseDocumentId(id, 'Document ID'), treeNameOrId);
    }

    async hasByChecksumString(checksumString, { context = '/', features = [], attributes } = {}) {
        const db = this.#getActiveDb();
        return await db.hasByChecksumString(checksumString, {
            context: this.#normalizeTreeSelector('context', context, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    async find(spec = {}) {
        return await this.#getActiveDb().find(this.#normalizeQuerySpec(spec));
    }

    async search(spec = {}) {
        return await this.#getActiveDb().search(this.#normalizeQuerySpec(spec));
    }

    async list(options = {}) {
        const { context, features = [], attributes, filters, includeIncoming = false, ...rest } = options;
        const normalizedContext = this.#normalizeTreeSelector('context', context ?? '/', '/');

        return await this.find({
            context: normalizedContext,
            features: features.length > 0 ? features : (attributes ?? []),
            filters,
            ...(shouldExcludeIncoming(normalizedContext?.path, includeIncoming) ? { excludeTree: { tree: Workspace.INCOMING_TREE_NAME } } : {}),
            ...rest,
        });
    }

    getTree(nameOrId) {
        const tree = nameOrId
            ? this.#getActiveDb().getTree(nameOrId)
            : this.#getPreferredContextTree();
        if (!tree) throw new Error(`Tree not found: ${nameOrId}`);
        return tree;
    }

    async listTrees(type = null) {
        return await this.#getActiveDb().listTrees(type);
    }

    async createTree(name, type = 'context', options = {}) {
        return await this.#getActiveDb().createTree(name, type, options);
    }

    async renameTree(nameOrId, newName) {
        return await this.#getActiveDb().renameTree(nameOrId, newName);
    }

    async destroyTree(nameOrId) {
        return await this.#getActiveDb().deleteTree(nameOrId);
    }

    getDefaultContextTree() {
        const tree = this.#getPreferredContextTree();
        if (!tree) throw new Error('Default context tree not available');
        return tree;
    }

    getDefaultDirectoryTree() {
        const tree = this.#getPreferredDirectoryTree();
        if (!tree) throw new Error('Default directory tree not available');
        return tree;
    }

    async getDocumentById(id, options = { parse: true }) {
        return await this.get(id, options);
    }

    async getDocumentsByIdArray(ids, options = { parse: true }) {
        return await this.#getActiveDb().getDocumentsByIdArray(parseDocumentIdArray(ids, 'Document ID array'), options);
    }

    getIncomingTree() {
        return this.getDirectoryTree(Workspace.INCOMING_TREE_NAME);
    }

    getContextTree(nameOrId) {
        const tree = nameOrId ? this.getTree(nameOrId) : this.getDefaultContextTree();
        if (tree.type !== 'context') throw new Error(`Tree is not a context tree: ${nameOrId}`);
        return tree;
    }

    getDirectoryTree(nameOrId) {
        const tree = nameOrId ? this.getTree(nameOrId) : this.getDefaultDirectoryTree();
        if (tree.type !== 'directory') throw new Error(`Tree is not a directory tree: ${nameOrId}`);
        return tree;
    }

    getContextTreeSelector(path = '/', treeNameOrId = null) {
        return this.#normalizeTreeSelector('context', { tree: treeNameOrId, path }, '/');
    }

    getDirectoryTreeSelector(path = '/', treeNameOrId = null) {
        return this.#normalizeTreeSelector('directory', { tree: treeNameOrId, path }, '/');
    }

    getIncomingTreeSelector(path = '/') {
        const normalizedPath = Array.isArray(path)
            ? path.map((value) => normalizeIncomingTreePath(value))
            : normalizeIncomingTreePath(path);
        return this.getDirectoryTreeSelector(normalizedPath, Workspace.INCOMING_TREE_NAME);
    }

    async listBitmaps(prefix = '', { includeData = false } = {}) {
        const keys = await this.#getActiveDb().bitmapIndex.listBitmaps(prefix);
        const bitmaps = await Promise.all(keys.map(async (key) => this.getBitmap(key, { includeData })));
        return bitmaps.filter(Boolean);
    }

    async getBitmap(key, { includeData = false } = {}) {
        if (!key || typeof key !== 'string') throw new Error('Bitmap key is required');

        const bitmap = await this.#getActiveDb().bitmapIndex.getBitmap(key, false);
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
        if (!key || typeof key !== 'string') throw new Error('Bitmap key is required');

        const bitmap = await this.#getActiveDb().bitmapIndex.getBitmap(key, false);
        if (!bitmap) return null;

        const serialized = bitmap.serialize(true); // Roaring portable format
        return Buffer.isBuffer(serialized) ? serialized : Buffer.from(serialized);
    }

    #normalizeTreeSelector(type, selector, defaultPath = '/') {
        if (selector == null) {
            return null;
        }

        if (typeof selector === 'string' || Array.isArray(selector)) {
            selector = { path: selector };
        }

        if (typeof selector !== 'object' || Array.isArray(selector)) {
            throw new Error(`Invalid ${type} selector`);
        }

        const path = selector.path ?? selector[type] ?? defaultPath;
        const tree = selector.tree ?? selector.treeId ?? null;
        const resolvedTree = tree
            ? (type === 'context' ? this.getContextTree(tree) : this.getDirectoryTree(tree))
            : (type === 'context' ? this.getDefaultContextTree() : this.getDefaultDirectoryTree());

        return {
            ...selector,
            tree: resolvedTree.id,
            path,
        };
    }

    clearDatabaseSync() {
        return this.#getActiveDb().clearSync();
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

    async #startStoredHomeIndex() {
        if (this.#stored) { return; }

        try {
            this.#stored = new Stored({
                index: { path: path.join(this.dataPath, 'stored-index') },
                checksums: ['sha256', 'md5'],
                primaryChecksum: 'sha256',
            });

            this.#stored.addBackend(Workspace.HOME_STORED_BACKEND, {
                driver: 'file',
                root: this.homePath,
                watch: true,
                provider: 'fs',
                account: 'home',
                container: 'workspace-home',
            });

            this.#bindStoredRuntimeEvents();
            await this.#syncStoredHomeSnapshot();
        } catch (error) {
            this.#logger.warn({ workspaceId: this.id, error: error.message }, 'Stored home indexing unavailable');
            await this.#stopStoredHomeIndex();
        }
    }

    async #stopStoredHomeIndex() {
        this.#unbindStoredRuntimeEvents();
        if (!this.#stored) { return; }

        try {
            await this.#stored.stop();
        } catch (error) {
            this.#logger.warn({ workspaceId: this.id, error: error.message }, 'Failed to stop stored home indexing');
        } finally {
            this.#stored = null;
        }
    }

    #bindStoredRuntimeEvents() {
        this.#unbindStoredRuntimeEvents();
        if (!this.#stored?.on) { return; }

        const eventMap = {
            'file:add': (payload) => this.#upsertStoredFileDocument(payload),
            'file:change': (payload) => this.#upsertStoredFileDocument(payload),
            'file:unlink': (payload) => this.#unlinkStoredFileDocument(payload),
        };

        this.#storedListeners = Object.entries(eventMap).map(([eventName, handler]) => {
            const listener = async (payload = {}) => {
                try {
                    await handler(payload);
                } catch (error) {
                    this.#logger.warn({ workspaceId: this.id, eventName, error: error.message }, 'Stored file sync failed');
                }
            };

            this.#stored.on(eventName, listener);
            return { eventName, listener };
        });
    }

    #unbindStoredRuntimeEvents() {
        if (!this.#stored?.off) {
            this.#storedListeners = [];
            return;
        }

        for (const { eventName, listener } of this.#storedListeners) {
            this.#stored.off(eventName, listener);
        }
        this.#storedListeners = [];
    }

    async #syncStoredHomeSnapshot() {
        if (!this.#stored) { return; }

        const files = await this.#stored.scan(Workspace.HOME_STORED_BACKEND);
        for (const file of files) {
            await this.#upsertStoredFileDocument(file);
        }
    }

    async #upsertStoredFileDocument(storedFile = {}) {
        const checksumArray = this.#buildStoredChecksumArray(storedFile.checksums);
        if (checksumArray.length === 0) { return null; }

        const meta = this.#getStoredMetadata(storedFile);
        const backends = this.#resolveStoredLocations(storedFile, meta, true);
        const incomingPaths = this.#buildStoredIncomingPaths(backends);
        if (incomingPaths.length === 0) { return null; }

        const primaryChecksum = checksumArray[0];
        const existingDocument = await this.db.getByChecksumString(primaryChecksum).catch(() => null);
        const documentData = this.#buildStoredFileDocument(storedFile, checksumArray, backends, existingDocument);
        const features = this.#buildStoredFileFeatures(backends);
        const currentIncomingPaths = existingDocument?.id
            ? await this.db.listDocumentTreePaths(existingDocument.id, Workspace.INCOMING_TREE_NAME).catch(() => [])
            : [];

        let documentId;
        if (existingDocument?.id) {
            documentId = await this.put({ ...documentData, id: existingDocument.id }, {
                directory: this.getIncomingTreeSelector(incomingPaths),
                features,
            });
        } else {
            documentId = await this.put(documentData, {
                directory: this.getIncomingTreeSelector(incomingPaths),
                features,
            });
        }

        await this.#removeStoredIncomingPaths(documentId, currentIncomingPaths, incomingPaths);
        return documentId;
    }

    async #unlinkStoredFileDocument(storedFile = {}) {
        const checksumArray = this.#buildStoredChecksumArray(storedFile.checksums);
        if (checksumArray.length === 0) { return null; }

        const existingDocument = await this.db.getByChecksumString(checksumArray[0]).catch(() => null);
        if (!existingDocument?.id) { return null; }

        const meta = this.#getStoredMetadata(storedFile);
        const backends = this.#resolveStoredLocations(storedFile, meta, false);
        const incomingPaths = this.#buildStoredIncomingPaths(backends);
        const currentIncomingPaths = await this.db.listDocumentTreePaths(existingDocument.id, Workspace.INCOMING_TREE_NAME).catch(() => []);
        const documentData = this.#buildStoredFileDocument(storedFile, checksumArray, backends, existingDocument);
        const features = this.#buildStoredFileFeatures(backends);

        await this.put({ ...documentData, id: existingDocument.id }, { features });
        await this.#removeStoredIncomingPaths(existingDocument.id, currentIncomingPaths, incomingPaths);
        return existingDocument.id;
    }

    #getStoredMetadata(storedFile = {}) {
        if (!this.#stored) { return null; }
        if (storedFile.id && this.#stored.has(storedFile.id)) {
            return this.#stored.stat(storedFile.id);
        }
        if (storedFile.backend && storedFile.key) {
            return this.#stored.stat(`${storedFile.backend}:${storedFile.key}`);
        }
        return null;
    }

    #resolveStoredLocations(storedFile = {}, meta = null, allowFallback = true) {
        if (Array.isArray(storedFile.locations) && storedFile.locations.length > 0) {
            return storedFile.locations;
        }
        if (Array.isArray(meta?.locations) && meta.locations.length > 0) {
            return meta.locations;
        }
        return allowFallback && storedFile.backend && storedFile.key
            ? [this.#buildStoredLocation(storedFile.backend, storedFile.key)]
            : [];
    }

    #buildStoredLocation(backendName, key) {
        const backend = this.#stored?.getBackend(backendName);
        const config = backend?.config || {};
        const [providerHint, ...accountHintParts] = String(backendName || '').split(':').filter(Boolean);

        return {
            backend: backendName,
            driver: config.driver || null,
            key,
            synced: true,
            source: {
                provider: config.provider || providerHint || config.driver || 'unknown',
                account: config.account || (accountHintParts.length > 0 ? accountHintParts.join(':') : (providerHint || backendName || 'default')),
                container: config.container || config.bucket || config.share || config.folder || (config.root ? path.basename(path.resolve(config.root)) : 'root'),
                path: key,
            },
        };
    }

    #buildStoredChecksumArray(checksums = {}) {
        const priority = ['sha256', 'sha1', 'md5'];
        return Object.entries(checksums || {})
            .filter(([, value]) => typeof value === 'string' && value.length > 0)
            .sort(([algoA], [algoB]) => {
                const idxA = priority.indexOf(algoA);
                const idxB = priority.indexOf(algoB);
                return (idxA === -1 ? priority.length : idxA) - (idxB === -1 ? priority.length : idxB) || algoA.localeCompare(algoB);
            })
            .map(([algorithm, hash]) => `${algorithm}/${hash}`);
    }

    #buildStoredIncomingPaths(backends = []) {
        return Array.from(new Set(
            backends
                .map((backend) => normalizeIncomingTreePath(getIncomingFileContextFromStoredLocation(backend)))
                .filter(Boolean)
        ));
    }

    #buildStoredFileFeatures(backends = []) {
        const features = [];

        for (const backend of backends) {
            if (backend.backend === Workspace.HOME_STORED_BACKEND) {
                features.push(Workspace.HOME_BACKEND_FEATURE);
            }
            if (backend?.source?.provider) {
                features.push(`data/source/${backend.source.provider}`);
            }
        }

        return Array.from(new Set(features));
    }

    #buildStoredFileDocument(storedFile = {}, checksumArray = [], backends = [], existingDocument = null) {
        const key = storedFile.key || existingDocument?.data?.path || '';
        const filename = key ? path.basename(key) : (existingDocument?.data?.filename || 'file');
        const size = Number.isFinite(storedFile.size) ? storedFile.size : existingDocument?.data?.size;
        const mimeType = storedFile.mimeType || existingDocument?.data?.mime;
        const docLocations = this.#buildStoredLocations(backends);
        const data = {
            ...(existingDocument?.data || {}),
            filename,
            path: key,
            backend: storedFile.backend || existingDocument?.data?.backend || Workspace.HOME_STORED_BACKEND,
        };

        if (Number.isFinite(size)) {
            data.size = size;
        } else {
            delete data.size;
        }

        if (typeof mimeType === 'string' && mimeType.length > 0) {
            data.mime = mimeType;
        } else {
            delete data.mime;
        }

        return {
            schema: 'data/abstraction/file',
            checksumArray: checksumArray.length > 0 ? checksumArray : (existingDocument?.checksumArray || []),
            data,
            locations: docLocations,
            metadata: {
                ...(existingDocument?.metadata || {}),
                backends,  // workspace-internal storage backend descriptors
            },
        };
    }

    #buildStoredLocations(backends = []) {
        return Array.from(
            new Map(
                backends.flatMap((backend) => {
                    if (!backend?.key) { return []; }
                    const entries = [];
                    if (backend.backend === Workspace.HOME_STORED_BACKEND) {
                        entries.push([
                            `file://{WORKSPACE_ROOT}/home/${backend.key}`,
                            { url: `file://{WORKSPACE_ROOT}/home/${backend.key}`, metadata: { backend: backend.backend } },
                        ]);
                    }
                    entries.push([
                        `stored://${backend.backend}/${backend.key}`,
                        { url: `stored://${backend.backend}/${backend.key}`, metadata: { backend: backend.backend } },
                    ]);
                    return entries;
                })
            ).values()
        );
    }

    async #removeStoredIncomingPaths(docId, currentPaths = [], nextPaths = []) {
        const stalePaths = currentPaths.filter((path) => !nextPaths.includes(path));
        for (const directory of stalePaths) {
            await this.unlink(docId, { directory: this.getIncomingTreeSelector(directory) });
        }
    }

    async #ensureIncomingTree() {
        if (this.#db.getTree(Workspace.INCOMING_TREE_NAME)) {
            return this.#db.getTree(Workspace.INCOMING_TREE_NAME);
        }
        await this.#db.createTree(Workspace.INCOMING_TREE_NAME, 'directory');
        return this.#db.getTree(Workspace.INCOMING_TREE_NAME);
    }

    #getPreferredContextTree() {
        const db = this.#getActiveDb();
        return db.getTree(Workspace.DEFAULT_CONTEXT_TREE_NAME) || db.getDefaultContextTree();
    }

    #getPreferredDirectoryTree() {
        const db = this.#getActiveDb();
        return db.getTree(Workspace.INCOMING_TREE_NAME) || db.getDefaultDirectoryTree();
    }

    async #ensureContextTree() {
        if (this.#db.getTree(Workspace.DEFAULT_CONTEXT_TREE_NAME)) {
            return this.#db.getTree(Workspace.DEFAULT_CONTEXT_TREE_NAME);
        }

        // Migration: rename legacy names ('ContextTree', 'context') -> 'default'
        const defaultContextTree = this.#db.getDefaultContextTree();
        if (defaultContextTree?.type === 'context' && ['context', 'ContextTree'].includes(defaultContextTree.name)) {
            await this.#db.renameTree(defaultContextTree.id, Workspace.DEFAULT_CONTEXT_TREE_NAME);
            return this.#db.getTree(Workspace.DEFAULT_CONTEXT_TREE_NAME);
        }

        await this.#db.createTree(Workspace.DEFAULT_CONTEXT_TREE_NAME, 'context');
        return this.#db.getTree(Workspace.DEFAULT_CONTEXT_TREE_NAME);
    }

    async #ensureDirectoryTree() {
        if (this.#db.getTree(Workspace.INCOMING_TREE_NAME)) {
            return this.#db.getTree(Workspace.INCOMING_TREE_NAME);
        }

        // Migration: rename legacy names ('DirectoryTree', 'directory') -> 'incoming'
        const defaultDirectoryTree = this.#db.getDefaultDirectoryTree();
        if (defaultDirectoryTree?.type === 'directory' && ['directory', 'DirectoryTree'].includes(defaultDirectoryTree.name)) {
            await this.#db.renameTree(defaultDirectoryTree.id, Workspace.INCOMING_TREE_NAME);
            return this.#db.getTree(Workspace.INCOMING_TREE_NAME);
        }

        await this.#db.createTree(Workspace.INCOMING_TREE_NAME, 'directory');
        return this.#db.getTree(Workspace.INCOMING_TREE_NAME);
    }

    #setStatus(status) {
        if (this.#status !== status) {
            this.#status = status;
            this.emit('status.changed', { id: this.id, status });
        }
    }

    #bindRuntimeEvents() {
        this.#unbindRuntimeEvents();
        if (!this.#db) { return; }

        this.#runtimeListeners = [
            this.#createRuntimeListener(this.#db, 'db'),
        ].filter(Boolean);
    }

    #unbindRuntimeEvents() {
        for (const binding of this.#runtimeListeners) {
            binding.emitter.off('**', binding.listener);
        }
        this.#runtimeListeners = [];
    }

    #createRuntimeListener(emitter, source) {
        if (!emitter?.on) { return null; }

        const workspace = this;
        const listener = function (payload = {}) {
            const eventName = this.event;
            if (!eventName) { return; }

            const eventPayload = payload && typeof payload === 'object'
                ? { ...payload }
                : { value: payload };

            if (!eventPayload.workspaceId) {
                eventPayload.workspaceId = workspace.id;
            }
            if (!eventPayload.source) {
                eventPayload.source = source;
            }

            workspace.emit(eventName, eventPayload);
        };

        emitter.on('**', listener);
        return { emitter, listener };
    }
}

export default Workspace;
