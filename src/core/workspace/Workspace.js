'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import * as fsPromises from 'fs/promises';
import path from 'path';
import Conf from 'conf';
import { v4 as uuidv4 } from 'uuid';
// Logging
import { createLogger } from '../../utils/log.js';

// Includes
import Db from '../../services/synapsd/src/index.js';
import { parseDocumentId, parseDocumentIdArray } from '../../utils/documentId.js';
import { normalizeIncomingTreePath } from '../../utils/incoming-documents.js';

// Sub-modules
import { WorkspaceTokens } from './lib/WorkspaceTokens.js';
import { WorkspaceStoredIndex } from './lib/WorkspaceStoredIndex.js';

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
    // Tree names
    static CONTEXT_TREE_NAME = 'context';
    static DIRECTORY_TREE_NAME = 'directory';
    // Tree types (used by the db layer)
    static CONTEXT_TYPE = 'context';
    static DIRECTORY_TYPE = 'directory';
    // Incoming documents path within directory tree
    static INCOMING_PATH = '/.incoming';

    #rootPath = null;
    #configStore = null;
    #logger;

    #db = null;
    #storedIndex = null;
    #tokens = null;
    #status = WORKSPACE_STATUS_CODES.INACTIVE;
    #runtimeListeners = [];

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

        if (!options.rootPath) throw new Error('Root path is required');
        if (!options.configStore) throw new Error('Config store is required');

        this.#rootPath = options.rootPath;
        this.#configStore = options.configStore;
        this.#logger = options.logger || createLogger('workspace');
        this.#storageManager = options.storageManager;
        this.#roleManager = options.roleManager;

        this.#tokens = new WorkspaceTokens({ configStore: this.#configStore, workspaceId: this.id });

        const persistedStatus = this.#configStore.get('status');
        if (persistedStatus && [WORKSPACE_STATUS_CODES.ACTIVE, WORKSPACE_STATUS_CODES.INACTIVE, WORKSPACE_STATUS_CODES.ERROR].includes(persistedStatus)) {
            this.#status = persistedStatus;
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
        return this.services[serviceName]?.enabled === true;
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

        links[type] = arr.filter(r => r !== ref);
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

            const dbPath = path.join(this.#rootPath, WORKSPACE_DIRECTORIES.db || 'Db');
            this.#db = new Db({ path: dbPath });
            await this.#db.start();
            await this.#ensureContextTree();
            await this.#ensureDirectoryTree();
            this.#bindRuntimeEvents();
            if (this.isServiceEnabled('home')) {
                await this.#startStoredIndex();
            }

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
            await this.#stopStoredIndex();
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
        if (!this.isActive || !this.#db) throw new Error('Workspace not active');
        return this.#db;
    }

    #normalizeFeatureInput(features = [], attributes) {
        return features.length > 0 ? features : (attributes?.allOf ?? attributes ?? []);
    }

    #normalizeQuerySpec(spec = {}) {
        const { attributes, features = null, limit = 200, ...rest } = spec;
        return {
            limit,
            ...rest,
            ...(features != null ? { features } : {}),
            ...(features == null && attributes != null ? { features: attributes } : {}),
        };
    }

    async put(record, { context = '/', directory = null, features = [], attributes, emitEvent = true } = {}) {
        const db = this.#getActiveDb();
        return await db.put(record, {
            context: this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
        });
    }

    async link(id, { context = '/', directory = null, features = [], attributes, emitEvent = true } = {}) {
        const db = this.#getActiveDb();
        return await db.link(id, {
            context: this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
        });
    }

    async unlink(id, { context = null, directory = null, features = [], attributes } = {}, options = {}) {
        const db = this.#getActiveDb();
        return await db.unlink(id, {
            context: context == null ? null : this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/'),
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
            context: context == null ? null : this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    async putMany(records, { context = '/', directory = null, features = [], attributes } = {}) {
        const db = this.#getActiveDb();
        return await db.putMany(records, {
            context: this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    async linkMany(ids, { context = '/', directory = null, features = [], attributes, emitEvent = true } = {}) {
        const db = this.#getActiveDb();
        return await db.linkMany(parseDocumentIdArray(ids, 'Document ID array'), {
            context: this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
        });
    }

    async unlinkMany(ids, { context = null, directory = null, features = [], attributes } = {}, options = {}) {
        const db = this.#getActiveDb();
        return await db.unlinkMany(parseDocumentIdArray(ids, 'Document ID array'), {
            context: context == null ? null : this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/'),
            directory: directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
        }, options);
    }

    async deleteMany(ids, options = {}) {
        return await this.#getActiveDb().deleteMany(parseDocumentIdArray(ids, 'Document ID array'), options);
    }

    /**
     * Evict documents from one or more storage backends, deleting physically stored
     * files and, when all backends are cleared, removing the document from the DB.
     *
     * Rules:
     *  - No locations on document → delete from DB directly (pure index record).
     *  - backends not specified + single backend → evict all, then delete from DB.
     *  - backends not specified + multiple backends detected → reject; caller must
     *    specify which backends to target to avoid orphaning files on remote storage.
     *  - backends specified → evict only those; keep DB record if any backend remains.
     *
     * The file watcher handles incoming-tree path cleanup automatically when files
     * are physically removed, so no explicit tree unlinking is needed here.
     */
    async evictDocumentsFromBackends(documentIds, { backends = null } = {}) {
        const db = this.#getActiveDb();
        const results = { successful: [], failed: [], skipped: [] };

        for (const rawId of documentIds) {
            const id = parseDocumentId(rawId, 'Document ID');
            try {
                const docs = await db.getDocumentsByIdArray([id], { parse: true });
                const doc = docs?.data?.[0];
                if (!doc) {
                    results.failed.push({ id, reason: 'not found' });
                    continue;
                }

                const checksumArray = doc.checksumArray || [];
                const docLocations = Array.isArray(doc.locations) ? doc.locations : [];

                // Pure index record with no storage locations — just delete from DB
                if (docLocations.length === 0) {
                    await db.delete(id);
                    results.successful.push({ id, action: 'db-deleted', reason: 'no storage locations' });
                    continue;
                }

                const docBackends = [...new Set(
                    docLocations.map(l => l.metadata?.backend).filter(Boolean)
                )];

                // Safety: if caller didn't specify backends and there are multiple distinct
                // backends, we cannot safely decide which physical files to delete.
                if (!backends && docBackends.length > 1) {
                    results.failed.push({
                        id,
                        reason: 'multiple backends detected — specify backends explicitly to avoid orphaning data',
                        backends: docBackends,
                    });
                    continue;
                }

                // Evict via Stored
                let deletedBackends = [];
                let remainingBackends = [...docBackends];

                if (this.#storedIndex?.isRunning && checksumArray.length > 0) {
                    const evictResult = await this.#storedIndex.evict(checksumArray[0], backends);
                    deletedBackends = evictResult.deleted;
                    remainingBackends = evictResult.remainingBackends;
                } else if (!this.#storedIndex?.isRunning) {
                    results.failed.push({ id, reason: 'home service not running — cannot evict from storage backends' });
                    continue;
                }

                if (remainingBackends.length === 0) {
                    // All backends cleared — safe to remove from DB entirely
                    await db.delete(id);
                    results.successful.push({ id, action: 'db-deleted', backendsCleared: deletedBackends });
                } else if (deletedBackends.length > 0) {
                    // Partial eviction — strip removed locations from the DB record
                    const updatedLocations = docLocations.filter(
                        l => !deletedBackends.includes(l.metadata?.backend)
                    );
                    await this.put({ ...doc, locations: updatedLocations }, null);
                    results.successful.push({ id, action: 'updated', backendsCleared: deletedBackends, remainingBackends });
                } else {
                    results.skipped.push({ id, reason: 'no matching backends found to evict', requested: backends });
                }
            } catch (err) {
                results.failed.push({ id, reason: err.message });
            }
        }

        return results;
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
            context: this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    async list(spec = {}) {
        return await this.#getActiveDb().list(this.#normalizeQuerySpec(spec));
    }

    async search(spec = {}) {
        return await this.#getActiveDb().search(this.#normalizeQuerySpec(spec));
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

    async createTree(name, type = Workspace.CONTEXT_TYPE, options = {}) {
        return await this.#getActiveDb().createTree(name, type, options);
    }

    async renameTree(nameOrId, newName) {
        return await this.#getActiveDb().renameTree(nameOrId, newName);
    }

    async destroyTree(nameOrId) {
        return await this.#getActiveDb().deleteTree(nameOrId);
    }

    getContextTree(nameOrId = null) {
        const tree = nameOrId ? this.getTree(nameOrId) : this.#getPreferredContextTree();
        if (tree.type !== Workspace.CONTEXT_TYPE) throw new Error(`Tree is not a context tree: ${nameOrId}`);
        return tree;
    }

    getDirectoryTree(nameOrId = null) {
        const tree = nameOrId ? this.getTree(nameOrId) : this.#getPreferredDirectoryTree();
        if (tree.type !== Workspace.DIRECTORY_TYPE) throw new Error(`Tree is not a directory tree: ${nameOrId}`);
        return tree;
    }

    getDefaultContextTree() { return this.getContextTree(); }
    getDefaultDirectoryTree() { return this.getDirectoryTree(); }

    getIncomingTree() {
        return this.getDirectoryTree(Workspace.DIRECTORY_TREE_NAME);
    }

    getContextTreeSelector(path = '/', treeNameOrId = null) {
        return this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, { tree: treeNameOrId, path }, '/');
    }

    getDirectoryTreeSelector(path = '/', treeNameOrId = null) {
        return this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, { tree: treeNameOrId, path }, '/');
    }

    getIncomingTreeSelector(path = '/') {
        const normalizedPath = Array.isArray(path)
            ? path.map((value) => normalizeIncomingTreePath(value))
            : normalizeIncomingTreePath(path);
        return this.getDirectoryTreeSelector(normalizedPath, Workspace.DIRECTORY_TREE_NAME);
    }

    async getDocumentsByIdArray(ids, options = { parse: true }) {
        return await this.#getActiveDb().getDocumentsByIdArray(parseDocumentIdArray(ids, 'Document ID array'), options);
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

    async deleteBitmap(key) {
        if (!key || typeof key !== 'string') throw new Error('Bitmap key is required');
        const normalized = key.replace(/^\/+|\/+$/g, '');
        if (normalized.startsWith('data/') || normalized === 'data') {
            throw new Error(`Refusing to delete bitmap "${key}": data/* bitmaps are protected (managed by document lifecycle).`);
        }
        const db = this.#getActiveDb();
        const existing = await db.bitmapIndex.getBitmap(normalized, false);
        if (!existing) return false;
        await db.bitmapIndex.deleteBitmap(normalized);
        return true;
    }

    async getBitmapRawBuffer(key) {
        if (!key || typeof key !== 'string') throw new Error('Bitmap key is required');

        const bitmap = await this.#getActiveDb().bitmapIndex.getBitmap(key, false);
        if (!bitmap) return null;

        const serialized = bitmap.serialize(true);
        return Buffer.isBuffer(serialized) ? serialized : Buffer.from(serialized);
    }

    #normalizeTreeSelector(type, selector, defaultPath = '/') {
        if (selector == null) return null;

        if (typeof selector === 'string' || Array.isArray(selector)) {
            selector = { path: selector };
        }

        if (typeof selector !== 'object' || Array.isArray(selector)) {
            throw new Error(`Invalid ${type} selector`);
        }

        const resolvedPath = selector.path ?? selector[type] ?? defaultPath;
        const tree = selector.tree ?? selector.treeId ?? null;
        const resolvedTree = tree
            ? (type === Workspace.CONTEXT_TYPE ? this.getContextTree(tree) : this.getDirectoryTree(tree))
            : (type === Workspace.CONTEXT_TYPE ? this.getDefaultContextTree() : this.getDefaultDirectoryTree());

        return { ...selector, tree: resolvedTree.id, path: resolvedPath };
    }

    clearDatabaseSync() {
        return this.#getActiveDb().clearSync();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Token Management (delegated to WorkspaceTokens)
    // ─────────────────────────────────────────────────────────────────────────

    createToken(options = {}) { return this.#tokens.create(options); }
    listTokens() { return this.#tokens.list(); }
    deleteToken(hash) { return this.#tokens.delete(hash); }
    verifyToken(tokenValue) { return this.#tokens.verify(tokenValue); }

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

    // ─────────────────────────────────────────────────────────────────────────
    // Stored home index (delegated to WorkspaceStoredIndex)
    // ─────────────────────────────────────────────────────────────────────────

    async startHomeService() {
        if (!this.isActive) return;
        await this.#startStoredIndex();
    }

    async stopHomeService() {
        await this.#stopStoredIndex();
    }

    async #startStoredIndex() {
        if (this.#storedIndex?.isRunning) return;
        this.#storedIndex = new WorkspaceStoredIndex({
            dataPath: this.dataPath,
            homePath: this.homePath,
            workspaceId: this.id,
            logger: this.#logger,
            put: this.put.bind(this),
            unlink: this.unlink.bind(this),
            getIncomingTreeSelector: this.getIncomingTreeSelector.bind(this),
            getDb: () => this.#db,
        });
        await this.#storedIndex.start();
    }

    async #stopStoredIndex() {
        if (!this.#storedIndex) return;
        await this.#storedIndex.stop();
        this.#storedIndex = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tree setup
    // ─────────────────────────────────────────────────────────────────────────

    #getPreferredContextTree() {
        const db = this.#getActiveDb();
        return db.getTree(Workspace.CONTEXT_TREE_NAME) || db.getDefaultContextTree();
    }

    #getPreferredDirectoryTree() {
        const db = this.#getActiveDb();
        return db.getTree(Workspace.DIRECTORY_TREE_NAME) || db.getDefaultDirectoryTree();
    }

    async #ensureContextTree() {
        if (this.#db.getTree(Workspace.CONTEXT_TREE_NAME)) {
            return this.#db.getTree(Workspace.CONTEXT_TREE_NAME);
        }

        // Migration: rename legacy names ('default', 'ContextTree') -> 'context'
        const defaultContextTree = this.#db.getDefaultContextTree();
        if (defaultContextTree?.type === Workspace.CONTEXT_TYPE && ['default', 'ContextTree'].includes(defaultContextTree.name)) {
            await this.#db.renameTree(defaultContextTree.id, Workspace.CONTEXT_TREE_NAME);
            return this.#db.getTree(Workspace.CONTEXT_TREE_NAME);
        }

        await this.#db.createTree(Workspace.CONTEXT_TREE_NAME, Workspace.CONTEXT_TYPE);
        return this.#db.getTree(Workspace.CONTEXT_TREE_NAME);
    }

    async #ensureDirectoryTree() {
        if (this.#db.getTree(Workspace.DIRECTORY_TREE_NAME)) {
            const tree = this.#db.getTree(Workspace.DIRECTORY_TREE_NAME);
            await tree.insertPath(Workspace.INCOMING_PATH);
            return tree;
        }

        // Migration: rename legacy names ('incoming', 'DirectoryTree') -> 'directory'
        const defaultDirectoryTree = this.#db.getDefaultDirectoryTree();
        if (defaultDirectoryTree?.type === Workspace.DIRECTORY_TYPE && ['incoming', 'DirectoryTree'].includes(defaultDirectoryTree.name)) {
            await this.#db.renameTree(defaultDirectoryTree.id, Workspace.DIRECTORY_TREE_NAME);
            const tree = this.#db.getTree(Workspace.DIRECTORY_TREE_NAME);
            await tree.insertPath(Workspace.INCOMING_PATH);
            return tree;
        }

        await this.#db.createTree(Workspace.DIRECTORY_TREE_NAME, Workspace.DIRECTORY_TYPE);
        const tree = this.#db.getTree(Workspace.DIRECTORY_TREE_NAME);
        await tree.insertPath(Workspace.INCOMING_PATH);
        return tree;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Runtime event forwarding
    // ─────────────────────────────────────────────────────────────────────────

    #setStatus(status) {
        if (this.#status !== status) {
            this.#status = status;
            this.emit('status.changed', { id: this.id, status });
        }
    }

    #bindRuntimeEvents() {
        this.#unbindRuntimeEvents();
        if (!this.#db) return;
        this.#runtimeListeners = [this.#createRuntimeListener(this.#db, 'db')].filter(Boolean);
    }

    #unbindRuntimeEvents() {
        for (const binding of this.#runtimeListeners) {
            binding.emitter.off('**', binding.listener);
        }
        this.#runtimeListeners = [];
    }

    #createRuntimeListener(emitter, source) {
        if (!emitter?.on) return null;

        const workspace = this;
        const listener = function (payload = {}) {
            const eventName = this.event;
            if (!eventName) return;

            const eventPayload = payload && typeof payload === 'object'
                ? { ...payload }
                : { value: payload };

            if (!eventPayload.workspaceId) eventPayload.workspaceId = workspace.id;
            if (!eventPayload.source) eventPayload.source = source;

            workspace.emit(eventName, eventPayload);
        };

        emitter.on('**', listener);
        return { emitter, listener };
    }
}

export default Workspace;
