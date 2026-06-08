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
import { isIncomingContextSpec, normalizeIncomingTreePath } from '../../utils/incoming-documents.js';

// Sub-modules
import { WorkspaceTokens } from './lib/WorkspaceTokens.js';
import { WorkspaceStoredIndex } from './lib/WorkspaceStoredIndex.js';

// Constants
import {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DIRECTORIES,
    WORKSPACE_DATA_BACKENDS,
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
    static INCOMING_LOCK_ID = 'system:incoming';

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
    get publicCanvasShares() { return this.#configStore.get('publicCanvasShares', {}); }

    get dataBackends() {
        return Workspace.#mergeConfigMap(WORKSPACE_DATA_BACKENDS, this.#configStore.get('dataBackends') || {});
    }

    get services() {
        return Workspace.#mergeConfigMap(WORKSPACE_SERVICES, this.#configStore.get('services') || {});
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

    get cachePath() {
        return path.join(this.#rootPath, WORKSPACE_DIRECTORIES.cache);
    }

    isDataBackendEnabled(backendName) {
        return this.dataBackends[backendName]?.enabled === true;
    }

    isServiceEnabled(serviceName) {
        return this.services[serviceName]?.enabled === true;
    }

    async setDataBackendConfig(backendName, patch) {
        const dataBackends = this.dataBackends;
        const next = { ...dataBackends[backendName], ...patch };
        dataBackends[backendName] = next;
        this.#configStore.set('dataBackends', dataBackends);
        this.emit('dataBackends.changed', { backend: backendName, config: next });
        if (this.#storedIndex?.isRunning) {
            await this.#storedIndex.applyBackendConfig(backendName, next, patch).catch((err) =>
                this.#logger.warn({ workspaceId: this.id, backend: backendName, error: err.message }, 'Failed to apply data-backend config'),
            );
        }
    }

    setServiceConfig(serviceName, config) {
        const services = this.services;
        services[serviceName] = { ...services[serviceName], ...config };
        this.#configStore.set('services', services);
        this.emit('services.changed', { service: serviceName, config: services[serviceName] });
    }

    setPublicCanvasShares(shares) {
        if (!shares || typeof shares !== 'object' || Array.isArray(shares)) return false;
        this.#configStore.set('publicCanvasShares', shares);
        this.emit('publicCanvasShares.changed', { id: this.id, publicCanvasShares: shares });
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
                fsPromises.mkdir(this.cachePath, { recursive: true }),
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
            if (this.isServiceEnabled('home') || this.isDataBackendEnabled(WorkspaceStoredIndex.HOME_STORED_BACKEND)) {
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

    #assertIncomingWriteAllowed(directory, allowIncomingWrite = false) {
        if (allowIncomingWrite || !directory) return;
        const paths = Array.isArray(directory.path) ? directory.path : [directory.path];
        if (paths.some((path) => isIncomingContextSpec(path))) {
            throw new Error('Incoming directory tree is read-only');
        }
    }

    async put(record, { context = '/', directory = null, features = [], attributes, emitEvent = true, allowIncomingWrite = false } = {}) {
        const db = this.#getActiveDb();
        const contextSelector = this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/');
        const directorySelector = directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/');
        this.#assertIncomingWriteAllowed(directorySelector, allowIncomingWrite);
        return await db.put(record, {
            context: contextSelector,
            directory: directorySelector,
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
        });
    }

    async link(id, { context = '/', directory = null, features = [], attributes, emitEvent = true, allowIncomingWrite = false } = {}) {
        const db = this.#getActiveDb();
        const contextSelector = this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/');
        const directorySelector = directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/');
        this.#assertIncomingWriteAllowed(directorySelector, allowIncomingWrite);
        return await db.link(id, {
            context: contextSelector,
            directory: directorySelector,
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
        });
    }

    async unlink(id, { context = null, directory = null, features = [], attributes } = {}, options = {}) {
        const db = this.#getActiveDb();
        const directorySelector = directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/');
        this.#assertIncomingWriteAllowed(directorySelector, options.allowIncomingWrite === true);
        return await db.unlink(id, {
            context: context == null ? null : this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/'),
            directory: directorySelector,
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

    async putMany(records, { context = '/', directory = null, features = [], attributes, allowIncomingWrite = false } = {}) {
        const db = this.#getActiveDb();
        const contextSelector = this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/');
        const directorySelector = directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/');
        this.#assertIncomingWriteAllowed(directorySelector, allowIncomingWrite);
        return await db.putMany(records, {
            context: contextSelector,
            directory: directorySelector,
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    async linkMany(ids, { context = '/', directory = null, features = [], attributes, emitEvent = true, allowIncomingWrite = false } = {}) {
        const db = this.#getActiveDb();
        const contextSelector = this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/');
        const directorySelector = directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/');
        this.#assertIncomingWriteAllowed(directorySelector, allowIncomingWrite);
        return await db.linkMany(parseDocumentIdArray(ids, 'Document ID array'), {
            context: contextSelector,
            directory: directorySelector,
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
        });
    }

    async unlinkMany(ids, { context = null, directory = null, features = [], attributes } = {}, options = {}) {
        const db = this.#getActiveDb();
        const directorySelector = directory == null ? null : this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, directory, '/');
        this.#assertIncomingWriteAllowed(directorySelector, options.allowIncomingWrite === true);
        return await db.unlinkMany(parseDocumentIdArray(ids, 'Document ID array'), {
            context: context == null ? null : this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/'),
            directory: directorySelector,
            features: this.#normalizeFeatureInput(features, attributes),
        }, options);
    }

    async deleteMany(ids, options = {}) {
        return await this.#getActiveDb().deleteMany(parseDocumentIdArray(ids, 'Document ID array'), options);
    }

    /**
     * Resolve a document's content by streaming/reading the first reachable
     * location (stored:// or file://{WORKSPACE_ROOT}/...).
     * @param {object} doc document with `locations[]`
     * @param {{stream?: boolean, url?: string}} [options]
     * @returns {Promise<{buffer?: Buffer, stream?: ReadStream, url: string}|null>}
     */
    async resolveDocument(doc, options = {}) {
        if (!this.#storedIndex?.isRunning) await this.#startStoredIndex();
        const locations = Array.isArray(doc?.locations) ? doc.locations : [];
        const candidates = options.url ? [{ url: options.url }] : locations;
        let lastError = null;
        for (const loc of candidates) {
            if (!loc?.url) continue;
            try {
                const data = await this.#storedIndex.resolve(loc.url, options);
                if (data != null) return { ...(options.stream ? { stream: data } : { buffer: data }), url: loc.url };
            } catch (err) {
                lastError = err;
            }
        }
        if (lastError) throw lastError;
        return null;
    }

    async getByChecksumString(checksumString, options = { parse: true }) {
        return await this.#getActiveDb().getByChecksumString(checksumString, options);
    }

    async listDocumentTreeMemberships(id, treeNameOrId) {
        return await this.#getActiveDb().listDocumentTreeMemberships(parseDocumentId(id, 'Document ID'), treeNameOrId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Timeline API (delegated to db.timeline)
    // ─────────────────────────────────────────────────────────────────────────

    async listTimelines() {
        return await this.#getActiveDb().timeline.listTimelines();
    }

    async createTimeline(name) {
        return await this.#getActiveDb().timeline.createTimeline(name);
    }

    hasTimeline(name) {
        return this.#getActiveDb().timeline.hasTimeline(name);
    }

    async deleteTimeline(name) {
        return await this.#getActiveDb().timeline.deleteTimeline(name);
    }

    async queryTimeline(timelineNames, interval, options = {}) {
        return await this.#getActiveDb().timeline.queryInterval(timelineNames, interval, null, options);
    }

    async insertTimelineEntry(timelineName, id, interval) {
        return await this.#getActiveDb().timeline.insert(timelineName, parseDocumentId(id, 'Document ID'), interval);
    }

    async removeTimelineEntry(timelineName, id) {
        return await this.#getActiveDb().timeline.remove(timelineName, parseDocumentId(id, 'Document ID'));
    }

    async hasByChecksumString(checksumString, { context = '/', features = [], attributes } = {}) {
        const db = this.#getActiveDb();
        return await db.hasByChecksumString(checksumString, {
            context: this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, context, '/'),
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    async list(spec = {}) {
        const querySpec = this.#normalizeQuerySpec(this.#composeCanvasQuerySpec(spec));
        const searchQuery = querySpec.query ?? querySpec.search ?? querySpec.q;
        if (typeof searchQuery === 'string' && searchQuery.trim()) {
            return await this.#getActiveDb().search(querySpec);
        }
        return await this.#getActiveDb().list(querySpec);
    }

    async search(spec = {}) {
        return await this.#getActiveDb().search(this.#normalizeQuerySpec(this.#composeCanvasQuerySpec(spec)));
    }

    /**
     * If the read targets a path whose leaf is a canvas layer, AND-compose the
     * canvas's stored querySpec (features + filters) into the spec before
     * delegating to the DB. Lets `GET /workspaces/:id/documents?context=/foo/bar/baz`
     * apply baz's querySpec when baz is a canvas — no separate /canvases/:id/documents
     * endpoint needed.
     *
     * Walks every path in spec.context (string, array, or {path}) and folds in
     * canvas specs found at any leaf. Multi-path context calls compose all canvases.
     */
    #composeCanvasQuerySpec(spec) {
        if (!spec || typeof spec !== 'object' || !spec.context) { return spec; }

        let treeRef = null;
        let paths = [];
        const ctx = spec.context;
        if (typeof ctx === 'string') {
            paths = [ctx];
        } else if (Array.isArray(ctx)) {
            paths = ctx.filter((p) => typeof p === 'string');
        } else if (typeof ctx === 'object') {
            treeRef = ctx.tree ?? ctx.treeId ?? null;
            const p = ctx.path ?? ctx.context;
            paths = Array.isArray(p) ? p.filter((s) => typeof s === 'string') : (typeof p === 'string' ? [p] : []);
        }
        if (paths.length === 0) { return spec; }

        let tree;
        try {
            tree = treeRef ? this.getTree(treeRef) : this.getDefaultContextTree();
        } catch (_) {
            return spec;
        }
        if (!tree || typeof tree.getLayerForPath !== 'function') { return spec; }

        let features = spec.features ?? spec.attributes ?? null;
        let filters = Array.isArray(spec.filters) ? [...spec.filters] : (spec.filters ? [spec.filters] : []);
        let query = spec.query ?? spec.search ?? spec.q ?? null;
        let nextContext = spec.context;
        let touched = false;

        for (const path of paths) {
            let leaf = null;
            try { leaf = tree.getLayerForPath(path); } catch (_) { /* ignore */ }
            if (leaf?.type !== 'canvas' || !leaf.querySpec) { continue; }
            features = Workspace.#composeCanvasFeatures(features, leaf.querySpec.features);
            filters = Workspace.#composeCanvasFilters(filters, leaf.querySpec.filters);
            query = Workspace.#composeCanvasQuery(query, leaf.querySpec.query ?? leaf.querySpec.search ?? leaf.querySpec.q);
            if (tree.type === Workspace.DIRECTORY_TYPE) {
                nextContext = Workspace.#withCanvasParentPath(nextContext, path);
            }
            touched = true;
        }

        if (!touched) { return spec; }

        return {
            ...spec,
            context: nextContext,
            ...(features !== undefined ? { features } : {}),
            filters,
            ...(query ? { query } : {}),
        };
    }

    static #composeCanvasFeatures(callerFeatures, canvasFeatures) {
        if (canvasFeatures === null || canvasFeatures === undefined) { return callerFeatures; }
        if (callerFeatures === null || callerFeatures === undefined) { return canvasFeatures; }
        const toBuckets = (f) => {
            if (Array.isArray(f)) { return { anyOf: [...f] }; }
            if (f && typeof f === 'object') {
                const out = {};
                if (Array.isArray(f.allOf))  { out.allOf  = [...f.allOf]; }
                if (Array.isArray(f.anyOf))  { out.anyOf  = [...f.anyOf]; }
                if (Array.isArray(f.noneOf)) { out.noneOf = [...f.noneOf]; }
                return out;
            }
            return {};
        };
        const a = toBuckets(callerFeatures);
        const b = toBuckets(canvasFeatures);
        const merged = {};
        for (const key of ['allOf', 'anyOf', 'noneOf']) {
            const left = a[key] || [];
            const right = b[key] || [];
            if (left.length || right.length) {
                merged[key] = [...new Set([...left, ...right])];
            }
        }
        return Object.keys(merged).length === 0 ? null : merged;
    }

    static #composeCanvasFilters(callerFilters, canvasFilters) {
        const a = Array.isArray(callerFilters) ? callerFilters : [];
        const b = Array.isArray(canvasFilters) ? canvasFilters : [];
        if (!a.length && !b.length) { return callerFilters || []; }
        return [...new Set([...a, ...b])];
    }

    static #composeCanvasQuery(callerQuery, canvasQuery) {
        const a = typeof callerQuery === 'string' ? callerQuery.trim() : '';
        const b = typeof canvasQuery === 'string' ? canvasQuery.trim() : '';
        if (a && b && a !== b) return `${b} ${a}`;
        return a || b || null;
    }

    static #withCanvasParentPath(context, canvasPath) {
        const parentPath = Workspace.#parentPath(canvasPath);
        if (typeof context === 'string') return parentPath;
        if (Array.isArray(context)) {
            return context.map((entry) => entry === canvasPath ? parentPath : entry);
        }
        if (context && typeof context === 'object') {
            const pathValue = context.path ?? context.context;
            if (Array.isArray(pathValue)) {
                return { ...context, path: pathValue.map((entry) => entry === canvasPath ? parentPath : entry) };
            }
            return { ...context, path: parentPath };
        }
        return context;
    }

    static #parentPath(value) {
        const normalized = String(value || '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
        if (normalized === '/') return '/';
        const idx = normalized.lastIndexOf('/');
        return idx <= 0 ? '/' : normalized.slice(0, idx);
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
        await this.setDataBackendConfig(WorkspaceStoredIndex.HOME_STORED_BACKEND, { enabled: true });
        await this.#startStoredIndex();
    }

    async stopHomeService() {
        await this.setDataBackendConfig(WorkspaceStoredIndex.HOME_STORED_BACKEND, { enabled: false });
        await this.#stopStoredIndex();
    }

    getDataBackendStatus() {
        const dataBackends = this.dataBackends;
        return Object.fromEntries(Object.entries(dataBackends).map(([name, config]) => {
            const runtime = this.#storedIndex?.getBackendStatus(name) || {};
            return [name, {
                ...config,
                root: Workspace.#resolveWorkspaceRoot(config.root, this.#rootPath),
                running: runtime.running || false,
                watching: runtime.watching || false,
                lastScanAt: runtime.lastScanAt || null,
                lastError: runtime.lastError || null,
                cacheStats: runtime.cacheStats || null,
            }];
        }));
    }

    async resyncDataBackend(backendName, { background = true } = {}) {
        const config = this.dataBackends[backendName];
        if (!config) throw new Error(`Unknown data backend: ${backendName}`);
        if (!config.supported) throw new Error(`Data backend "${backendName}" is not supported yet`);
        if (!config.resync) throw new Error(`Data backend "${backendName}" does not support resync`);
        if (!this.#storedIndex?.isRunning) await this.#startStoredIndex();
        // A resync is a potentially slow full scan (large/remote backends); by
        // default it runs in the background and progress is reported via the
        // backend status. Pass { background: false } to await completion.
        return background
            ? this.#storedIndex.resyncInBackground(backendName)
            : this.#storedIndex.resync(backendName);
    }

    /**
     * Describe a document's locations for a Destroy picker (which can have bytes
     * removed vs reference-dropped only).
     */
    async describeDocumentLocations(doc) {
        if (!this.#storedIndex?.isRunning) await this.#startStoredIndex();
        return this.#storedIndex.describeLocations(doc);
    }

    /**
     * Destroy a document's blobs (the "Destroy" op). `options.urls` targets
     * specific locations; default targets all. Removes the doc from the index
     * when no locations remain. See WorkspaceStoredIndex.destroy.
     */
    async destroyDocument(doc, options = {}) {
        if (!this.#storedIndex?.isRunning) await this.#startStoredIndex();
        return this.#storedIndex.destroy(doc, options);
    }

    /**
     * Resolve IMAP connection credentials for an account from config/stored.json
     * (matched by account/user), shaped for the stored ImapBackend. Returns null
     * if not found — Destroy then treats imap:// locations as reference-drop only.
     */
    async #getImapConfig(account) {
        try {
            const raw = await fsPromises.readFile(path.join(this.#rootPath, 'config', 'stored.json'), 'utf8');
            const cfg = JSON.parse(raw);
            const entry = Object.values(cfg.backends || {}).find(
                (b) => b?.driver === 'imap' && (b.account === account || b.user === account),
            );
            if (!entry) return null;
            return {
                user: entry.user,
                password: entry.password,
                host: entry.host,
                port: entry.port || 993,
                tls: entry.tls !== false,
                allowSelfSigned: entry.allowSelfSigned === true,
            };
        } catch {
            return null;
        }
    }

    #buildStoredIndex() {
        return new WorkspaceStoredIndex({
            rootPath: this.#rootPath,
            cachePath: this.cachePath,
            dataPath: this.dataPath,
            homePath: this.homePath,
            dataBackends: this.dataBackends,
            workspaceId: this.id,
            logger: this.#logger,
            put: (record, options = {}) => this.put(record, { ...options, allowIncomingWrite: true }),
            unlink: (id, options = {}, unlinkOptions = {}) => this.unlink(id, options, { ...unlinkOptions, allowIncomingWrite: true }),
            getIncomingTreeSelector: this.getIncomingTreeSelector.bind(this),
            getDb: () => this.#db,
            getImapConfig: (account) => this.#getImapConfig(account),
        });
    }

    async #startStoredIndex() {
        if (this.#storedIndex?.isRunning) return;
        this.#storedIndex = this.#buildStoredIndex();
        await this.#storedIndex.start();
    }

    async #stopStoredIndex() {
        if (!this.#storedIndex) return;
        await this.#storedIndex.stop();
        this.#storedIndex = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IMAP mailboxes — delegated to WorkspaceStoredIndex (config in
    // config/stored.json, protocol in the stored imap backend).
    // ─────────────────────────────────────────────────────────────────────────

    async #imap() {
        if (!this.#storedIndex?.isRunning) await this.#startStoredIndex();
        return this.#storedIndex;
    }

    // Read-only view that does NOT boot sources (safe for status polls).
    #imapReadonly() {
        return this.#storedIndex?.isRunning ? this.#storedIndex : this.#buildStoredIndex();
    }

    async listImapMailboxes() { return this.#imapReadonly().listMailboxes(); }
    async getImapMailbox(id) { return this.#imapReadonly().getMailbox(id); }
    async getImapStatus() { return this.#imapReadonly().getImapStatus(); }
    async saveImapMailbox(input) { return (await this.#imap()).saveMailbox(input); }
    async removeImapMailbox(id) { return (await this.#imap()).removeMailbox(id); }
    async testImapMailbox(id) { return (await this.#imap()).testMailbox(id); }
    async listImapMailboxFolders(id) { return (await this.#imap()).listMailboxFolders(id); }
    async discoverImapFolders(input) { return (await this.#imap()).discoverFolders(input); }
    async subscribeImapFolders(id, folders) { return (await this.#imap()).subscribeFolders(id, folders); }
    async syncImapMailbox(id) { return (await this.#imap()).syncMailbox(id); }
    async startImapMailbox(id) { return (await this.#imap()).startMailbox(id); }
    async stopImapMailbox(id) { return (await this.#imap()).stopMailbox(id); }

    // Service-level enable/disable for 'imap'.
    async enableImap() { await this.#startStoredIndex(); return this.getImapStatus(); }
    async disableImap() { if (this.#storedIndex?.isRunning) await this.#storedIndex.disableImap(); return true; }

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
            await this.#ensureIncomingTreeLock(tree);
            return tree;
        }

        // Migration: rename legacy names ('incoming', 'DirectoryTree') -> 'directory'
        const defaultDirectoryTree = this.#db.getDefaultDirectoryTree();
        if (defaultDirectoryTree?.type === Workspace.DIRECTORY_TYPE && ['incoming', 'DirectoryTree'].includes(defaultDirectoryTree.name)) {
            await this.#db.renameTree(defaultDirectoryTree.id, Workspace.DIRECTORY_TREE_NAME);
            const tree = this.#db.getTree(Workspace.DIRECTORY_TREE_NAME);
            await this.#ensureIncomingTreeLock(tree);
            return tree;
        }

        await this.#db.createTree(Workspace.DIRECTORY_TREE_NAME, Workspace.DIRECTORY_TYPE);
        const tree = this.#db.getTree(Workspace.DIRECTORY_TREE_NAME);
        await this.#ensureIncomingTreeLock(tree);
        return tree;
    }

    async #ensureIncomingTreeLock(tree) {
        await tree.insertPath(Workspace.INCOMING_PATH, { ignoreLocks: true });
        if (typeof tree.lockPath === 'function') {
            await tree.lockPath(Workspace.INCOMING_PATH, Workspace.INCOMING_LOCK_ID, { recursive: true });
        }
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

    static #mergeConfigMap(defaults, overrides) {
        const out = {};
        for (const [key, value] of Object.entries(defaults || {})) {
            out[key] = { ...(value || {}) };
        }
        for (const [key, value] of Object.entries(overrides || {})) {
            out[key] = { ...(out[key] || {}), ...(value || {}) };
        }
        return out;
    }

    static #resolveWorkspaceRoot(value, rootPath) {
        if (typeof value !== 'string') return value;
        return value.replaceAll('{WORKSPACE_ROOT}', rootPath);
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
