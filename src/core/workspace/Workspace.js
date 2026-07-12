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
import { BACKENDS_TREE_NAME, LEGACY_BACKENDS_PATH, normalizeBackendsTreePath, normalizeSegment } from '../../utils/backend-documents.js';
import { parseLocationUrl } from '../../services/synapsd/src/utils/path-helpers.js';

// Sub-modules
import { WorkspaceTokens } from './lib/WorkspaceTokens.js';
import { classifyDocument } from './lib/classifier.js';
import { WorkspaceStoredIndex } from './lib/WorkspaceStoredIndex.js';
import { WorkspaceMailIndex } from './services/imap/index.js';

// Constants
import {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_DIRECTORIES,
    WORKSPACE_GIT_BARE_DIR,
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
    // Dedicated backend-mirror tree (type directory, linkContextRoot:false).
    // Paths inside it are /<driver>/<resource-address>/<resource-path>.
    static BACKENDS_TREE_NAME = BACKENDS_TREE_NAME;
    // Tree types (used by the db layer)
    static CONTEXT_TYPE = 'context';
    static DIRECTORY_TYPE = 'directory';
    // Pre-backends-tree staging subtree inside the directory tree; only used by
    // the one-shot startup migration.
    static LEGACY_BACKENDS_PATH = LEGACY_BACKENDS_PATH;
    // Default cosine-distance floor for the dense side of vector/hybrid search.
    // synapsd applies no floor by default (pure mechanism); Workspace sets the
    // product policy: drop kNN neighbours past this cosine distance so the dense
    // side can't pollute results with "nearest but irrelevant" hits (kNN always
    // returns its top-K regardless of absolute similarity). 0.35 distance = 0.65
    // cosine similarity — a solid relevance bar for bge-small (normalized).
    // Empirically separates genuinely-related notes (~0.27) from degenerate
    // near-centroid embeddings of empty/trivial content (~0.40+), which match any
    // query. Callers may override via an explicit maxDistance (pass 2 to disable).
    static DEFAULT_MAX_COSINE_DISTANCE = 0.35;
    // Per-backend enable-lock holder prefix on /<driver>/<address> in the
    // backends tree
    static BACKEND_NODE_LOCK_PREFIX = 'system:backend:';

    #rootPath = null;
    #configStore = null;
    #logger;

    #db = null;
    #storedIndex = null;
    #mailIndex = null;
    // Set when the legacy /.backends subtree was dropped this start — triggers a
    // one-time backend resync/re-file to repopulate the backends tree.
    #legacyBackendsMigrated = false;
    #mailRuntimeBinding = null;
    #tokens = null;
    #status = WORKSPACE_STATUS_CODES.INACTIVE;
    #runtimeListeners = [];

    // Managers (injected)
    #storageManager = null;
    #roleManager = null;
    #embedd = null;            // shared embedding service (optional; server-managed)
    #embeddRegistered = false;

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
        this.#embedd = options.embedd || null;

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

    /**
     * Async stats superset including LanceDB FTS + dense-vector internals
     * (row counts, embedded-doc count, embedder/model state, queue backlog).
     * Used by the Workspace Settings UI. Returns null when inactive.
     */
    async getStats() {
        if (!this.isActive || !this.#db) return null;
        const stats = await this.#db.getStats();
        // Embedding progress: the embedd queue is shared across workspaces, but its
        // pending count + this workspace's per-space embeddedDocs (semantic.vectorSpaces)
        // let the UI show a re-embed in flight and how far it's got.
        if (this.#embedd?.status) {
            try {
                const es = await this.#embedd.status();
                // Actual routing (what really embeds where) from the embedd router
                // rules — notes/emails + text-file blobs → text, image/* → image.
                // Surfaced so the UI shows reality, not synapsd's note-only gap default.
                const routing = {};
                for (const r of (this.#embedd.router?.rules || [])) {
                    const m = r.match || {};
                    const desc = m.schema != null ? String(m.schema)
                        : (m.contentType != null ? `mime ${String(m.contentType)}` : 'any');
                    (routing[r.space] ||= []).push(desc);
                }
                stats.embedder = { queue: es.queue, routing };
            } catch (_) { /* best effort */ }
        }
        return stats;
    }

    /**
     * Live-tune search knobs (persisted to workspace.json `semantic`, applied to
     * the running DB without a restart). Currently the image relevance floor.
     * @param {{imageMaxDistance?: number|null}} tuning
     */
    async setSearchTuning(tuning = {}) {
        const current = this.#configStore.get('semantic', {}) || {};
        const next = { ...current };
        if (Object.prototype.hasOwnProperty.call(tuning, 'imageMaxDistance')) {
            next.imageMaxDistance = tuning.imageMaxDistance;
        }
        this.#configStore.set('semantic', next);
        const applied = this.#db?.setSearchTuning ? this.#db.setSearchTuning(tuning) : null;
        this.emit('semantic.changed', { id: this.id, semantic: next });
        return { semantic: next, applied };
    }

    get homePath() {
        return path.join(this.#rootPath, WORKSPACE_DIRECTORIES.home);
    }

    get dataPath() {
        return path.join(this.#rootPath, WORKSPACE_DIRECTORIES.data);
    }

    get gitPath() {
        return path.join(this.#rootPath, WORKSPACE_DIRECTORIES.git);
    }

    get gitBarePath() {
        return path.join(this.gitPath, WORKSPACE_GIT_BARE_DIR);
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

    // Structural local stores every workspace depends on: workspace:data is the
    // managed blob target (persistBlob/stored:// addressing), stored.cache backs
    // thumbnails/derived artifacts. Neither can be disabled, and as managed
    // (non-browseable, never exported) stores the readOnly knob is meaningless.
    static #ALWAYS_ON_BACKENDS = new Set([WorkspaceStoredIndex.DATA_BLOB_BACKEND, WorkspaceStoredIndex.CACHE_BACKEND]);

    async setDataBackendConfig(backendName, patch) {
        if (Workspace.#ALWAYS_ON_BACKENDS.has(backendName)) {
            if (patch?.enabled === false) {
                throw new Error(`Data backend "${backendName}" is structural and cannot be disabled`);
            }
            if (patch && 'readOnly' in patch) {
                throw new Error(`Data backend "${backendName}" is a managed store — read-only does not apply`);
            }
        }
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
            this.#db = new Db({
                path: dbPath,
                // synapsd owns no model; if the embedd service is present, hand it
                // the query embedder so dense/hybrid search works. Absent → FTS.
                semantic: this.#embedd
                    ? {
                        embedQuery: (text, space) => this.#embedd.embedQuery(text, space),
                        // Workspace-level search tuning (persisted in workspace.json
                        // under `semantic`). Undefined → synapsd default (0.97).
                        imageMaxDistance: (this.#configStore.get('semantic', {}) || {}).imageMaxDistance,
                    }
                    : undefined,
            });
            await this.#db.start();
            await this.#ensureContextTree();
            await this.#ensureDirectoryTree();
            await this.#ensureBackendsTree();
            await this.#migrateLegacyBackendsSubtree();
            this.#bindRuntimeEvents();
            this.#registerEmbedd();
            // Mark ACTIVE before booting stored/mail indices: their initial sync
            // (IMAP scan → ingestMessage → #put → #getActiveDb) needs isActive,
            // otherwise every fetched message rejects with "Workspace not active".
            this.#setStatus(WORKSPACE_STATUS_CODES.ACTIVE);
            if (this.isServiceEnabled('home') || this.isDataBackendEnabled(WorkspaceStoredIndex.HOME_STORED_BACKEND)) {
                await this.#startStoredIndex();
                if (this.#legacyBackendsMigrated) {
                    // Repopulate the freshly-created backends tree from the file
                    // backends (checksum-cached: no re-hash of unchanged files,
                    // no blob re-download — membership re-tick only).
                    this.#storedIndex.resyncInBackground();
                }
            }

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
            this.#unregisterEmbedd();
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

    // Extract raw path strings from a context/directory input (string | string[] |
    // { tree?, path }). The tree qualifier is dropped on purpose: a workspace has
    // exactly one context tree and one directory tree, so the db's ctx:/dir:
    // default-tree resolution always lands on them.
    static #extractPaths(value) {
        if (value == null) { return []; }
        let paths = value;
        if (typeof value === 'object' && !Array.isArray(value)) {
            paths = value.path ?? value.context ?? value.directory ?? '/';
        }
        return (Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === 'string');
    }

    static #buildPaths(context, directory) {
        return [
            ...Workspace.#extractPaths(context).map((p) => `ctx:${p}`),
            ...Workspace.#extractPaths(directory).map((p) => `dir:${p}`),
        ];
    }

    static #isTreeQualified(value) {
        return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value.tree ?? value.treeId));
    }

    // Write-target spec for db.put/link/unlink. The ctx:/dir: paths grammar can
    // only address the DEFAULT trees, so tree-qualified selectors (e.g. the
    // backends tree) must be passed through as selector objects instead.
    static #buildWriteSpec(context, directory) {
        if (Workspace.#isTreeQualified(context) || Workspace.#isTreeQualified(directory)) {
            const toSelector = (value) => {
                if (value == null) { return null; }
                if (typeof value === 'object' && !Array.isArray(value)) { return value; }
                return { path: value };
            };
            return { context: toSelector(context), directory: toSelector(directory) };
        }
        return { paths: Workspace.#buildPaths(context, directory) };
    }

    #normalizeQuerySpec(spec = {}) {
        const { attributes, features = null, context, directory, limit = 200, ...rest } = spec;
        // Tree-qualified selectors survive as selector objects (parseSpec keeps
        // the tree id per entry); the paths string grammar targets default trees.
        if (Workspace.#isTreeQualified(context) || Workspace.#isTreeQualified(directory)) {
            return {
                limit,
                ...rest,
                ...(context != null ? { context } : {}),
                ...(directory != null ? { directory } : {}),
                ...(features != null ? { features } : {}),
                ...(features == null && attributes != null ? { features: attributes } : {}),
            };
        }
        const paths = Workspace.#buildPaths(context, directory);
        return {
            limit,
            ...rest,
            ...(paths.length ? { paths } : {}),
            ...(features != null ? { features } : {}),
            ...(features == null && attributes != null ? { features: attributes } : {}),
        };
    }

    #assertBackendsWriteAllowed(directory, allowBackendsWrite = false) {
        if (allowBackendsWrite || directory == null) { return; }
        if (this.#isBackendsTreeSelector(directory)) {
            throw new Error('Backends tree is read-only through the generic document API');
        }
    }

    // Does a directory selector target the backends tree? (by tree id or name)
    #isBackendsTreeSelector(directory) {
        if (!Workspace.#isTreeQualified(directory)) { return false; }
        const backends = this.#db?.getTree(Workspace.BACKENDS_TREE_NAME);
        if (!backends) { return false; }
        const target = this.#db.getTree(directory.tree ?? directory.treeId);
        return target?.id === backends.id;
    }

    async put(record, { context = '/', directory = null, features = [], attributes, emitEvent = true, allowBackendsWrite = false, provenance = null } = {}) {
        this.#assertBackendsWriteAllowed(directory, allowBackendsWrite);
        return await this.#getActiveDb().put(record, {
            ...Workspace.#buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
            ...(provenance ? { provenance } : {}),
        });
    }

    async link(id, { context = '/', directory = null, features = [], attributes, emitEvent = true, allowBackendsWrite = false, provenance = null } = {}) {
        this.#assertBackendsWriteAllowed(directory, allowBackendsWrite);
        return await this.#getActiveDb().link(id, {
            ...Workspace.#buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
            ...(provenance ? { provenance } : {}),
        });
    }

    async unlink(id, { context = null, directory = null, features = [], attributes } = {}, options = {}) {
        this.#assertBackendsWriteAllowed(directory, options.allowBackendsWrite === true);
        return await this.#getActiveDb().unlink(id, {
            ...Workspace.#buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            ...options,
        });
    }

    async delete(id, options = {}) {
        const docId = parseDocumentId(id, 'Document ID');
        const managedBlobs = await this.#collectManagedOnlyBlobUrls([docId]);
        const result = await this.#getActiveDb().delete(docId, options);
        if (result) { await this.#cascadeManagedBlobDeletion(managedBlobs); }
        return result;
    }

    async get(id, options = { parse: true }) {
        return await this.#getActiveDb().get(parseDocumentId(id, 'Document ID'), options);
    }

    async has(id, { context = null, directory = null, features = [], attributes } = {}) {
        return await this.#getActiveDb().has(parseDocumentId(id, 'Document ID'), {
            ...Workspace.#buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    async putMany(records, { context = '/', directory = null, features = [], attributes, allowBackendsWrite = false } = {}) {
        this.#assertBackendsWriteAllowed(directory, allowBackendsWrite);
        return await this.#getActiveDb().putMany(records, {
            ...Workspace.#buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    // ── Embedding (embedd service seam) ───────────────────────────────────────
    // synapsd owns no embedding model; the embedd service computes vectors and
    // pushes them back here. These two methods are the workspace-level adapter
    // the embedd service registers with (storeVectors + resolveInput).

    /** Vector sink: persist embedd-computed chunk vectors into a synapsd space. */
    async storeDocumentEmbeddings(docId, schema, updatedAt, chunks, opts = {}) {
        return await this.#getActiveDb().storeDocumentEmbeddings(
            parseDocumentId(docId, 'Document ID'), schema, updatedAt, chunks, opts,
        );
    }

    /** Ledger read: docIds that match `schemas` but have no embedding for `space`. */
    async getUnembeddedDocIds(space = 'text', schemas = null) {
        return await this.#getActiveDb().getUnembeddedDocIds(space, schemas);
    }

    /** Wipe an embedding space (vectors + presence + seen) for a full re-embed. */
    async clearSpace(space = 'text') {
        return await this.#getActiveDb().clearSpace(space);
    }

    // ── embedd registration + live enqueue ────────────────────────────────────

    /** Register this workspace with the shared embedd service + subscribe events. */
    #registerEmbedd() {
        if (!this.#embedd || this.#embeddRegistered) { return; }
        this.#embedd.registerWorkspace(this.id, {
            resolveInput: (docId) => this.resolveEmbeddingInput(docId),
            storeVectors: (docId, schema, updatedAt, chunks, opts) =>
                this.storeDocumentEmbeddings(docId, schema, updatedAt, chunks, opts),
            getUnembedded: (space, schemas) => this.getUnembeddedDocIds(space, schemas),
            clearSpace: (space) => this.clearSpace(space),
        });
        // Live enqueue: new + content-updated docs. Blob ingestion also lands as
        // document.inserted (WorkspaceStoredIndex creates docs), so this covers
        // stored files too — no separate object:add subscription needed.
        this.on('document.inserted', this.#onDocEventForEmbed);
        this.on('document.updated', this.#onDocEventForEmbed);
        this.#embeddRegistered = true;
    }

    #unregisterEmbedd() {
        if (!this.#embedd || !this.#embeddRegistered) { return; }
        this.off('document.inserted', this.#onDocEventForEmbed);
        this.off('document.updated', this.#onDocEventForEmbed);
        this.#embedd.unregisterWorkspace(this.id);
        this.#embeddRegistered = false;
    }

    #onDocEventForEmbed = (payload) => {
        if (!this.#embedd) { return; }
        const ids = Array.isArray(payload?.ids)
            ? payload.ids
            : (payload?.id != null ? [payload.id] : []);
        for (const id of ids) { this.#embedd.enqueue(this.id, id); }
    };

    /**
     * Input source for embedding one document. Return shapes:
     *   - null                          → doc gone (do NOT record as seen)
     *   - { skip:true, schema, ... }    → exists but not embeddable (record as seen)
     *   - { modality, schema, ... }     → embeddable (text|image + text|bytes)
     *
     * A `data/abstraction/file` is a byte blob: embed it from its *content*
     * (text/* → utf8, image/* → bytes), never from generateEmbeddingsData (which
     * for File yields the location URL string — garbage to embed). Only JSON
     * abstractions (note, …) use generateEmbeddingsData.
     */
    async resolveEmbeddingInput(docId) {
        const doc = await this.#getActiveDb().getDocument(parseDocumentId(docId, 'Document ID')).catch(() => null);
        if (!doc) { return null; }

        const schema = doc.schema;
        const updatedAt = doc.updatedAt || new Date().toISOString();
        const chunkOpts = doc.indexOptions?.embeddingOptions?.chunking || {};
        const classification = classifyDocument(doc);
        // Use the classifier's mime (filename-derived when the stored contentType
        // is missing/generic) — the raw metadata.contentType can be the useless
        // 'application/json' default for fs-indexed images, which the embed router
        // (routes on image/*) would reject.
        const contentType = classification.mime || doc.metadata?.contentType || null;
        // User-authored comment rides along on every return shape (even skip/image),
        // so the embedd worker can give any commented doc a dedicated text vector.
        const comment = doc.hasComment ? doc.comment.trim() : '';

        if (classification.isFile()) {
            // Byte blob: only text/image content is embeddable; everything else
            // (pdf, octet-stream, …) is a deliberate skip until a decoder/CLIP
            // model exists. Bytes must be server-resident (device file:// throws).
            if (!classification.isBlob() || !contentType) { return { skip: true, schema, updatedAt, contentType, comment }; }
            const modality = classification.embeddingModality();
            if (!modality) { return { skip: true, schema, updatedAt, contentType, comment }; }
            let resolveError = null;
            const resolved = await this.resolveDocument(doc).catch((e) => { resolveError = e; return null; });
            if (!resolved?.buffer) {
                // We classified this as an embeddable blob but its bytes are
                // unreachable — usually stale/dead locations (e.g. a removed backend
                // like the legacy fs:home). Surface it instead of silently skipping,
                // so resync location cleanup can be triggered.
                this.#logger.warn({
                    workspaceId: this.id,
                    docId: doc.id,
                    modality,
                    contentType,
                    locations: (doc.locations || []).map((l) => l.url),
                    error: resolveError?.message,
                }, 'embed: could not resolve blob bytes (stale/unreachable locations)');
                return { skip: true, schema, updatedAt, contentType, comment };
            }
            return modality === 'image'
                ? { modality, schema, updatedAt, bytes: resolved.buffer, contentType, comment }
                : { modality, schema, updatedAt, text: resolved.buffer.toString('utf8'), contentType, chunkOpts, comment };
        }

        // JSON abstraction (note, etc.) → the text the doc exposes for embedding.
        const data = typeof doc.generateEmbeddingsData === 'function' ? doc.generateEmbeddingsData() : null;
        const text = Array.isArray(data) ? data.join('\n').trim() : (typeof data === 'string' ? data.trim() : '');
        if (!text) { return { skip: true, schema, updatedAt, contentType, comment }; }
        return { modality: 'text', schema, updatedAt, text, contentType, chunkOpts, comment };
    }

    async linkMany(ids, { context = '/', directory = null, features = [], attributes, emitEvent = true, allowBackendsWrite = false } = {}) {
        this.#assertBackendsWriteAllowed(directory, allowBackendsWrite);
        return await this.#getActiveDb().linkMany(parseDocumentIdArray(ids, 'Document ID array'), {
            ...Workspace.#buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
        });
    }

    async unlinkMany(ids, { context = null, directory = null, features = [], attributes } = {}, options = {}) {
        this.#assertBackendsWriteAllowed(directory, options.allowBackendsWrite === true);
        return await this.#getActiveDb().unlinkMany(parseDocumentIdArray(ids, 'Document ID array'), {
            ...Workspace.#buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            ...options,
        });
    }

    async deleteMany(ids, options = {}) {
        const docIds = parseDocumentIdArray(ids, 'Document ID array');
        const managedBlobs = await this.#collectManagedOnlyBlobUrls(docIds);
        const result = await this.#getActiveDb().deleteMany(docIds, options);
        const deletedIds = new Set((result?.successful ?? []).map((entry) => entry?.id ?? entry));
        await this.#cascadeManagedBlobDeletion(managedBlobs, deletedIds);
        return result;
    }

    /**
     * Plain index-delete blob cascade. A document whose EVERY location lives on
     * a managed stored backend (workspace:data — opaque, non-browseable by
     * design) would orphan its blobs on a plain delete; collect those URLs
     * before the delete and remove the bytes after it succeeds. Documents with
     * any user-owned location (workspace:home file, imap message, device) are
     * never touched — a plain delete only drops their index entry.
     */
    async #collectManagedOnlyBlobUrls(ids) {
        const managedBackends = new Set(Object.entries(this.dataBackends || {})
            .filter(([, cfg]) => cfg?.managed === true && cfg?.readOnly !== true && cfg?.enabled !== false)
            .map(([name]) => name));
        const byId = new Map();
        if (managedBackends.size === 0 || ids.length === 0) { return byId; }

        const fetched = await this.getDocumentsByIdArray(ids, { parse: false }).catch(() => null);
        const docs = Array.isArray(fetched) ? fetched : (fetched?.data ?? []);
        for (const doc of docs.filter(Boolean)) {
            const urls = (doc.locations || []).map((l) => l?.url).filter(Boolean);
            if (urls.length === 0) { continue; }
            const allManaged = urls.every((url) => {
                const parsed = parseLocationUrl(url);
                return parsed?.scheme === 'stored' && managedBackends.has(parsed.backend);
            });
            if (allManaged) { byId.set(doc.id, urls); }
        }
        return byId;
    }

    async #cascadeManagedBlobDeletion(byId, deletedIds = null) {
        if (!byId || byId.size === 0) { return; }
        if (!this.#storedIndex?.isRunning) { await this.#startStoredIndex().catch(() => null); }
        if (!this.#storedIndex?.isRunning) { return; }
        for (const [docId, urls] of byId) {
            if (deletedIds && !deletedIds.has(docId)) { continue; }
            for (const url of urls) {
                await this.#storedIndex.deleteStoredUrl(url).catch((err) =>
                    this.#logger.warn({ workspaceId: this.id, docId, url, error: err.message }, 'Blob cascade: failed to delete managed blob'));
            }
        }
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

    /**
     * Upload raw bytes into the workspace blob store (workspace:data). Returns a
     * `stored://workspace:data/<key>` location (content-addressed, deduped) that a
     * File document can then reference — making the bytes server-resident and
     * embeddable. This is the byte half of `canvas ws insert`.
     * @param {Buffer|import('stream').Readable} blob buffered or streamed (stored
     *   hashes a stream on the fly to a temp file — large blobs never buffer in RAM)
     * @returns {Promise<{url:string, key:string, checksum:string|null, size:number}>}
     */
    async persistBlob(blob) {
        if (!this.#storedIndex?.isRunning) { await this.#startStoredIndex(); }
        return await this.#storedIndex.persistBlob(blob);
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

    async hasByChecksumString(checksumString, { context = null, directory = null, features = [], attributes } = {}) {
        return await this.#getActiveDb().hasByChecksumString(checksumString, {
            paths: Workspace.#buildPaths(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
        });
    }

    // Emit a tree-scoped document event for a known selection (e.g. after a
    // scoped purge) so cross-client consumers (browser extension auto-close, web
    // UI) refresh. Selectors are { tree, path } as returned by
    // get{Context,Directory}TreeSelector; pass whichever applies.
    emitTreeDocumentEvent(eventName, { context = null, directory = null, documentIds = [] } = {}) {
        this.#getActiveDb().emitTreeDocumentEvent(eventName, { context, directory, documentIds });
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
        const querySpec = this.#normalizeQuerySpec(this.#composeCanvasQuerySpec(spec));
        if (querySpec.maxDistance === undefined) { querySpec.maxDistance = Workspace.DEFAULT_MAX_COSINE_DISTANCE; }
        return await this.#getActiveDb().search(querySpec);
    }

    // Stateless multi-query refinement: `spec` supplies the structured scope
    // (path/features/filters/canvas), `queries` is the ordered stack of text
    // queries that AND-narrow it (last ranks). Text is passed separately, so any
    // single query carried on the spec is dropped from the base scope.
    async searchRefined(queries = [], spec = {}, options = {}) {
        const baseSpec = this.#normalizeQuerySpec(this.#composeCanvasQuerySpec(spec));
        delete baseSpec.query; delete baseSpec.search; delete baseSpec.q;
        const opts = { ...options };
        if (opts.maxDistance === undefined) { opts.maxDistance = Workspace.DEFAULT_MAX_COSINE_DISTANCE; }
        return await this.#getActiveDb().searchRefined(queries, baseSpec, opts);
    }

    /**
     * If the read targets a path whose leaf is a canvas layer, AND-compose the
     * canvas's stored querySpec (features + filters) into the spec before
     * delegating to the DB. Lets `GET /workspaces/:id/documents?context=/foo/bar/baz`
     * apply baz's querySpec when baz is a canvas — no separate /canvases/:id/documents
     * endpoint needed.
     *
     * Applies to BOTH scope keys: `spec.context` (context tree) and
     * `spec.directory` (directory tree). Directory membership is node-exact, so
     * a directory-tree canvas reads its PARENT folder's documents (the canvas
     * node itself holds none) — with or without a stored querySpec.
     */
    #composeCanvasQuerySpec(spec) {
        if (!spec || typeof spec !== 'object') { return spec; }
        let out = this.#composeCanvasForScope(spec, 'context');
        out = this.#composeCanvasForScope(out, 'directory');
        return out;
    }

    #composeCanvasForScope(spec, scopeKey) {
        const scope = spec?.[scopeKey];
        if (!scope) { return spec; }

        let treeRef = null;
        let paths = [];
        if (typeof scope === 'string') {
            paths = [scope];
        } else if (Array.isArray(scope)) {
            paths = scope.filter((p) => typeof p === 'string');
        } else if (typeof scope === 'object') {
            treeRef = scope.tree ?? scope.treeId ?? null;
            const p = scope.path ?? scope.context ?? scope.directory;
            paths = Array.isArray(p) ? p.filter((s) => typeof s === 'string') : (typeof p === 'string' ? [p] : []);
        }
        if (paths.length === 0) { return spec; }

        let tree;
        try {
            tree = treeRef
                ? this.getTree(treeRef)
                : (scopeKey === 'directory' ? this.getDefaultDirectoryTree() : this.getDefaultContextTree());
        } catch (_) {
            return spec;
        }
        if (!tree || typeof tree.getLayerForPath !== 'function') { return spec; }

        let features = spec.features ?? spec.attributes ?? null;
        let filters = Array.isArray(spec.filters) ? [...spec.filters] : (spec.filters ? [spec.filters] : []);
        let query = spec.query ?? spec.search ?? spec.q ?? null;
        let nextScope = spec[scopeKey];
        let touched = false;

        for (const path of paths) {
            let leaf = null;
            try { leaf = tree.getLayerForPath(path); } catch (_) { /* ignore */ }
            if (leaf?.type !== 'canvas') { continue; }
            const qs = leaf.querySpec || {};
            features = Workspace.#composeCanvasFeatures(features, qs.features);
            filters = Workspace.#composeCanvasFilters(filters, qs.filters);
            query = Workspace.#composeCanvasQuery(query, qs.query ?? qs.search ?? qs.q);
            if (tree.type === Workspace.DIRECTORY_TYPE) {
                nextScope = Workspace.#withCanvasParentPath(nextScope, path);
            }
            touched = true;
        }

        if (!touched) { return spec; }

        return {
            ...spec,
            [scopeKey]: nextScope,
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
        this.#assertTreeNotReserved(nameOrId, 'rename');
        return await this.#getActiveDb().renameTree(nameOrId, newName);
    }

    async destroyTree(nameOrId) {
        this.#assertTreeNotReserved(nameOrId, 'delete');
        return await this.#getActiveDb().deleteTree(nameOrId);
    }

    // The three pre-created trees (and any tree flagged settings.protected) are
    // structural — services and clients address them by name.
    #assertTreeNotReserved(nameOrId, action) {
        const tree = this.#getActiveDb().getTree(nameOrId);
        if (!tree) { return; }
        const reserved = [Workspace.CONTEXT_TREE_NAME, Workspace.DIRECTORY_TREE_NAME, Workspace.BACKENDS_TREE_NAME];
        if (reserved.includes(tree.name) || tree.settings?.protected === true) {
            throw new Error(`Cannot ${action} reserved tree "${tree.name}"`);
        }
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

    /**
     * Remove a folder from the backends tree AND cascade-purge the documents
     * that lived under it from the index. Backend-ingested docs are re-synced
     * if the user re-enables the backend, so this lets a user discard the
     * leftovers of a backend they removed without orphaning index entries.
     * Bytes on the backend are NOT touched — see destroyBackendsTreePath for that.
     *
     * The backends tree root itself is protected. Doc ids are snapshotted
     * BEFORE removePath — once the folder (and its membership bitmaps) are gone
     * the subtree can no longer be resolved.
     */
    async removeBackendsTreePath(path, { recursive = false } = {}) {
        const tree = this.getBackendsTree();
        const normalizedPath = normalizeBackendsTreePath(path);
        if (normalizedPath === '/') {
            throw new Error('Cannot remove the backends root directory');
        }

        const bitmap = recursive
            ? await tree.findRecursive(normalizedPath)
            : await tree.find(normalizedPath);
        const documentIds = bitmap ? bitmap.toArray() : [];

        const result = await tree.removePath(normalizedPath, recursive);
        if (result?.error) { return { ...result, purged: 0 }; }

        let purgeResult = null;
        if (documentIds.length > 0) {
            purgeResult = await this.deleteMany(documentIds, { emitEvent: false });
        }
        return { ...result, purged: purgeResult?.successful?.length || 0, purgeResult };
    }

    /**
     * Remove a /.backends folder AND delete the mirrored resources on the
     * backend itself (rw backends only; read-only/foreign locations degrade to
     * reference-drop). The byte half of "remove from canvas AND the backend".
     *
     * Per document: locations that belong to the backend mirrored by `path` are
     * destroyed via the stored index (stored:// delete, workspace file rm, imap
     * EXPUNGE — readOnly config degrades each to a reference drop). Whatever the
     * destroy pass didn't fully delete is then purged from the index (destroy
     * implies purge). The folder is removed last so a mid-failure stays retryable.
     */
    async destroyBackendsTreePath(path, { recursive = false } = {}) {
        if (!this.#storedIndex?.isRunning) await this.#startStoredIndex();
        const tree = this.getBackendsTree();
        const normalizedPath = normalizeBackendsTreePath(path);
        const segments = normalizedPath.split('/').filter(Boolean); // [driver, address, ...rest]
        if (segments.length < 2) {
            throw new Error('destroy requires a backend resource path (/<driver>/<resource-address>/...)');
        }
        const node = tree.getLayerForPath(normalizedPath);
        if (!node) { return { data: null, count: 0, error: `Path not found: ${normalizedPath}` }; }
        if (node.locked) {
            throw new Error(`Path is locked: a backend mapped to ${normalizedPath} is enabled`);
        }

        const [driver, address, ...rest] = segments;
        const scope = driver === 'imap'
            ? { kind: 'imap', account: address.toLowerCase(), folder: rest.join('/').toLowerCase() || null }
            : { kind: 'stored', backend: this.#storedIndex.resolveBackendForTreePath(normalizedPath) };

        const bitmap = recursive ? await tree.findRecursive(normalizedPath) : await tree.find(normalizedPath);
        const documentIds = bitmap ? bitmap.toArray() : [];

        const destroyed = { docsDestroyed: 0, docsPurged: 0, deletedLocations: 0, droppedRefs: 0, failed: [] };
        const leftovers = [];
        for (const id of documentIds) {
            try {
                const doc = await this.get(id).catch(() => null);
                if (!doc) { continue; }
                const urls = (doc.locations || [])
                    .map((l) => l?.url)
                    .filter((url) => Workspace.#locationMatchesBackendScope(url, scope));
                const res = urls.length > 0
                    ? await this.destroyDocument(doc, { urls })
                    : { deleted: [], droppedRefs: [], docDeleted: false };
                destroyed.deletedLocations += res.deleted.length;
                destroyed.droppedRefs += res.droppedRefs.length;
                if (res.docDeleted) { destroyed.docsDestroyed += 1; } else { leftovers.push(id); }
            } catch (err) {
                destroyed.failed.push({ id, reason: err.message });
                leftovers.push(id);
            }
        }
        if (leftovers.length > 0) {
            const purgeResult = await this.deleteMany(leftovers, { emitEvent: false }).catch(() => null);
            destroyed.docsPurged = purgeResult?.successful?.length || 0;
        }

        const result = await tree.removePath(normalizedPath, true);
        return { ...result, destroyed };
    }

    /**
     * Does a location URL belong to the backend scope mirrored by a /.backends
     * path? Tree segments are normalized lowercase, so compares are
     * case-insensitive (IMAP folder INBOX ↔ tree node inbox).
     */
    static #locationMatchesBackendScope(url, scope) {
        if (typeof url !== 'string') { return false; }
        const parsed = parseLocationUrl(url);
        if (!parsed) { return false; }
        if (scope.kind === 'imap') {
            if (parsed.scheme !== 'imap' || parsed.backend.toLowerCase() !== scope.account) { return false; }
            if (!scope.folder) { return true; }
            const folder = parsed.key.split(';')[0].toLowerCase();
            return folder === scope.folder || folder.startsWith(`${scope.folder}/`);
        }
        return parsed.scheme === 'stored' && !!scope.backend && parsed.backend === scope.backend;
    }

    /**
     * Backend-node enable-lock: while a backend is enabled, its mirror node
     * /<driver>/<resource-address> (backends tree) is structurally locked (no
     * remove/rename/move). Holder-scoped: each backend adds its own
     * system:backend:<holder> entry, so shared nodes (two mailboxes on one
     * account) stay locked until the last holder releases.
     */
    async lockBackendTreeNode(backendPath, holder) {
        const tree = this.getBackendsTree();
        await tree.insertPath(backendPath, { ignoreLocks: true });
        await tree.lockPath(backendPath, `${Workspace.BACKEND_NODE_LOCK_PREFIX}${holder}`);
    }

    async unlockBackendTreeNode(backendPath, holder) {
        const tree = this.getBackendsTree();
        if (typeof tree.pathExists === 'function' && !tree.pathExists(backendPath)) { return; }
        await tree.unlockPath(backendPath, `${Workspace.BACKEND_NODE_LOCK_PREFIX}${holder}`, { system: true })
            .catch(() => {});
    }

    getContextTreeSelector(path = '/', treeNameOrId = null) {
        return this.#normalizeTreeSelector(Workspace.CONTEXT_TYPE, { tree: treeNameOrId, path }, '/');
    }

    getDirectoryTreeSelector(path = '/', treeNameOrId = null) {
        return this.#normalizeTreeSelector(Workspace.DIRECTORY_TYPE, { tree: treeNameOrId, path }, '/');
    }

    getBackendsTreeSelector(path = '/') {
        const normalizedPath = Array.isArray(path)
            ? path.map((value) => normalizeBackendsTreePath(value))
            : normalizeBackendsTreePath(path);
        return this.getDirectoryTreeSelector(normalizedPath, Workspace.BACKENDS_TREE_NAME);
    }

    getBackendsTree() {
        return this.getDirectoryTree(Workspace.BACKENDS_TREE_NAME);
    }

    async getDocumentsByIdArray(ids, options = { parse: true }) {
        return await this.#getActiveDb().getDocumentsByIdArray(parseDocumentIdArray(ids, 'Document ID array'), options);
    }

    async listBitmaps(prefix = '', { includeData = false, includeInternal = false } = {}) {
        const keys = await this.#getActiveDb().bitmapIndex.listBitmaps(prefix, { includeInternal });
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
        // internal/* are engine-managed (gc, timeline, lance/fts, lance/vectors).
        // Dropping them corrupts state or forces silent re-index — never via API.
        if (normalized.startsWith('internal/') || normalized === 'internal') {
            throw new Error(`Refusing to delete bitmap "${key}": internal/* bitmaps are protected (engine-managed).`);
        }
        // rel/* are typed doc<->doc relation edges (managed by the document
        // lifecycle / relations index). Dropping them silently breaks links.
        if (normalized.startsWith('rel/') || normalized === 'rel') {
            throw new Error(`Refusing to delete bitmap "${key}": rel/* bitmaps are protected (relation edges).`);
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
                // Full exclusion set applied to watch + resync (defaults ∪ user
                // `exclude`) so the settings UI can show both.
                effectiveExclusions: this.#storedIndex?.isRunning
                    ? this.#storedIndex.getEffectiveExclusions(name)
                    : undefined,
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
     * Resync a backend addressed by its /.backends mirror node path
     * (/<driver>/<address>/… in the backends tree). Dispatches by driver because
     * "backend" is overloaded: file/s3/etc. are stored data backends keyed by
     * name, while imap accounts are mailbox connectors keyed by mailbox id.
     * The context-menu resync in the tree routes through here. MVP resyncs the
     * whole backend/account; the folder segment (if any) is ignored.
     */
    // ─────────────────────────────────────────────────────────────────────────
    // Unified backend/connector facade — one surface over every "thing mounted
    // under /<driver>/<address> in the backends tree": storage backends (file/cacache/s3,
    // via WorkspaceStoredIndex) and message connectors (imap accounts, via
    // WorkspaceMailIndex). The /:id/backends routes mirror the tree; driver
    // dispatch + capabilities live here so the URL never carries an internal id.
    // Descriptor: { driver, address, kind, enabled, status, lastSyncAt,
    // lastError, capabilities, containers? }.
    // ─────────────────────────────────────────────────────────────────────────

    // Capability map the UI reads to decide which actions to expose — replaces
    // per-name special-casing. Future container mutation / object delete slot
    // onto mutableContainers / deleteObject without new URL shapes.
    #backendCapabilities(driver, config = {}) {
        if (driver === 'imap') {
            return { sync: true, test: true, containers: true, mutableContainers: false, deleteObject: true };
        }
        const supported = config.supported !== false;
        return {
            sync: Boolean(config.resync) && supported,
            test: false,
            containers: false,
            mutableContainers: driver === 'file' && config.readOnly !== true && supported,
            deleteObject: config.readOnly !== true && supported,
        };
    }

    #storageBackendDescriptor(name, status = {}) {
        const driver = status.driver || 'file';
        const state = status.lastError ? 'error' : (status.running ? (status.watching ? 'running' : 'idle') : 'stopped');
        return {
            driver,
            address: name,
            kind: 'storage',
            enabled: status.enabled !== false,
            status: state,
            lastSyncAt: status.lastScanAt || null,
            lastError: status.lastError || null,
            capabilities: this.#backendCapabilities(driver, status),
            config: {
                root: status.root || null,
                readOnly: status.readOnly === true,
                managed: status.managed === true,
                supported: status.supported !== false,
                watch: status.watch === true,
                resync: Boolean(status.resync),
                exclude: Array.isArray(status.exclude) ? status.exclude : [],
                effectiveExclusions: Array.isArray(status.effectiveExclusions) ? status.effectiveExclusions : undefined,
            },
        };
    }

    #listStorageBackends() {
        return Object.entries(this.getDataBackendStatus())
            .map(([name, status]) => this.#storageBackendDescriptor(name, status));
    }

    #imapBackendDescriptor(address, mailboxes = []) {
        const errored = mailboxes.find((m) => m.lastError);
        const anyRunning = mailboxes.some((m) => m.runtime?.active);
        const lastSyncAt = mailboxes.map((m) => m.lastSyncAt).filter(Boolean).sort().at(-1) || null;
        const primary = mailboxes[0] || {};
        return {
            driver: 'imap',
            address,
            kind: 'messages',
            enabled: mailboxes.some((m) => m.enabled !== false),
            status: errored ? 'error' : (anyRunning ? 'running' : 'idle'),
            lastSyncAt,
            lastError: errored?.lastError || null,
            capabilities: this.#backendCapabilities('imap'),
            // Connection config (from the account's primary mailbox) so the
            // settings panel can render/edit the account without a second fetch.
            config: {
                host: primary.host || '',
                port: primary.port ?? 993,
                tls: primary.tls !== false,
                allowSelfSigned: primary.allowSelfSigned !== false,
                user: primary.user || '',
                pollInterval: primary.pollInterval ?? 60000,
                initialSyncDays: primary.initialSyncDays ?? 180,
                passwordConfigured: mailboxes.some((m) => m.passwordConfigured),
            },
            containers: mailboxes.map((m) => ({
                name: m.folder || 'INBOX',
                mailboxId: m.id,
                enabled: m.enabled !== false,
                status: m.runtime?.status || (m.enabled === false ? 'stopped' : 'idle'),
                lastSyncAt: m.lastSyncAt || null,
                lastError: m.lastError || null,
            })),
        };
    }

    // Group per-folder imap mailboxes by account into one instance each. The
    // account segment matches the backends tree /imap/<account> node.
    async #listImapBackends() {
        const mailboxes = await this.listImapMailboxes();
        const byAccount = new Map();
        for (const mb of mailboxes) {
            const address = normalizeSegment(mb.account || mb.user || '');
            if (!address) continue;
            if (!byAccount.has(address)) byAccount.set(address, []);
            byAccount.get(address).push(mb);
        }
        return [...byAccount.entries()].map(([address, mbs]) => this.#imapBackendDescriptor(address, mbs));
    }

    async listBackends() {
        return [...this.#listStorageBackends(), ...(await this.#listImapBackends())];
    }

    /**
     * Documents mirrored under a backend address in the backends tree,
     * optionally filtered by linkage: linked=false → present ONLY on the
     * backend, never filed into any other tree (safe-to-purge candidates);
     * linked=true → the inverse; linked=null → everything under the address.
     */
    async listBackendDocuments(driver, address, { linked = null, limit = null, offset = 0, parse = true } = {}) {
        const path = `/${normalizeSegment(driver)}/${normalizeSegment(address)}`;
        return await this.#getActiveDb().listTreeDocuments(Workspace.BACKENDS_TREE_NAME, { path, linked, limit, offset, parse });
    }

    async listBackendsByDriver(driver) {
        return (await this.listBackends()).filter((b) => b.driver === driver);
    }

    async getBackend(driver, address) {
        const match = (await this.listBackends()).find((b) => b.driver === driver && b.address === address);
        if (!match) throw new Error(`Backend not found: ${driver}/${address}`);
        return match;
    }

    async addBackend(driver, config = {}) {
        if (driver === 'imap') return this.saveImapMailbox(config);
        const name = config.name || config.address;
        if (!name) throw new Error('Storage backend name is required');
        await this.setDataBackendConfig(name, config);
        return this.getBackend(driver, name);
    }

    async updateBackend(driver, address, patch = {}) {
        if (driver === 'imap') {
            // Account-level settings/creds are shared across the account's folder
            // mailboxes, so apply the patch to each.
            const targets = (await this.listImapMailboxes())
                .filter((m) => normalizeSegment(m.account || m.user || '') === normalizeSegment(address));
            if (!targets.length) throw new Error(`No IMAP mailbox for account "${address}"`);
            for (const m of targets) await this.saveImapMailbox({ ...patch, id: m.id });
            return this.getBackend('imap', address);
        }
        await this.setDataBackendConfig(address, patch);
        return this.getBackend(driver, address);
    }

    async removeBackend(driver, address) {
        if (driver === 'imap') {
            const targets = (await this.listImapMailboxes())
                .filter((m) => normalizeSegment(m.account || m.user || '') === normalizeSegment(address));
            if (!targets.length) return false;
            for (const m of targets) await this.removeImapMailbox(m.id);
            return true;
        }
        // Managed storage defaults can't be deleted; disabling is the remove op.
        await this.setDataBackendConfig(address, { enabled: false });
        return true;
    }

    async syncBackend(driver, address) {
        if (driver === 'imap') return (await this.#mail()).resyncAccount(address);
        // Storage: address is the (normalized, lowercase) backend name, which
        // matches the lowercase config keys (workspace:home, …).
        return this.resyncDataBackend(address);
    }

    async testBackend(driver, address) {
        if (driver !== 'imap') throw new Error(`Backend "${driver}/${address}" does not support test`);
        const target = (await this.listImapMailboxes())
            .find((m) => normalizeSegment(m.account || m.user || '') === normalizeSegment(address));
        if (!target) throw new Error(`No IMAP mailbox for account "${address}"`);
        return this.testImapMailbox(target.id);
    }

    // Mailboxes belonging to one imap account (the account's folder set).
    async #imapAccountMailboxes(address) {
        return (await this.listImapMailboxes())
            .filter((m) => normalizeSegment(m.account || m.user || '') === normalizeSegment(address));
    }

    async listBackendContainers(driver, address, { available = false } = {}) {
        if (driver !== 'imap') throw new Error(`Backend "${driver}/${address}" has no containers`);
        if (available) {
            // Folders available on the server (for subscribing more), from the
            // account's primary mailbox creds.
            const [primary] = await this.#imapAccountMailboxes(address);
            if (!primary) throw new Error(`No IMAP mailbox for account "${address}"`);
            return this.listImapMailboxFolders(primary.id);
        }
        return (await this.getBackend('imap', address)).containers || [];
    }

    async syncBackendContainer(driver, address, name) {
        if (driver !== 'imap') throw new Error(`Backend "${driver}/${address}" has no containers`);
        const container = (await this.listBackendContainers('imap', address)).find((c) => c.name === name);
        if (!container) throw new Error(`Container "${name}" not found on imap/${address}`);
        return (await this.#mail()).syncMailbox(container.mailboxId);
    }

    // Add containers: imap → subscribe folders (per-folder mailboxes); file →
    // create real directories under the backend root (each folder is a relative
    // path key like "docs" or "docs/2024").
    async addBackendContainers(driver, address, folders = []) {
        if (driver === 'imap') {
            const [primary] = await this.#imapAccountMailboxes(address);
            if (!primary) throw new Error(`No IMAP mailbox for account "${address}"`);
            return this.subscribeImapFolders(primary.id, folders);
        }
        if (driver === 'file') {
            const created = [];
            for (const folder of folders) created.push(await this.createBackendFolder(driver, address, folder));
            return created;
        }
        throw new Error(`Backend "${driver}/${address}" has no containers`);
    }

    async removeBackendContainer(driver, address, name) {
        if (driver === 'imap') {
            const target = (await this.#imapAccountMailboxes(address)).find((m) => (m.folder || 'INBOX') === name);
            if (!target) throw new Error(`Container "${name}" not found on imap/${address}`);
            return this.removeImapMailbox(target.id);
        }
        if (driver === 'file') return this.deleteBackendFolder(driver, address, name);
        throw new Error(`Backend "${driver}/${address}" has no containers`);
    }

    // ── File-backend folder ops ───────────────────────────────────────────────
    // Fs op runs on the (writable) file driver; the directory-tree mirror is
    // updated here so empty folders are visible (docs alone would never surface
    // an empty dir — the watcher only sees file events). Folder "name" is a
    // relative path key under the backend root.
    #backendFolderKey(name) {
        const key = String(name || '').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
        if (!key || key.split('/').some((seg) => seg === '..' || seg === '.')) {
            throw new Error(`Invalid folder name: ${name}`);
        }
        return key;
    }

    async #directoryTreeForBackends() {
        if (!this.#storedIndex?.isRunning) await this.#startStoredIndex();
        return this.getBackendsTree();
    }

    async createBackendFolder(driver, address, name) {
        if (driver !== 'file') throw new Error(`Driver "${driver}" has no mutable folders`);
        const key = this.#backendFolderKey(name);
        const tree = await this.#directoryTreeForBackends();
        await this.#storedIndex.createBackendContainer(address, key);
        const root = this.#storedIndex.getBackendTreeRoot(address);
        if (root) await tree.insertPath(`${root}/${key}`, { ignoreLocks: true });
        return { driver, address, folder: key };
    }

    async deleteBackendFolder(driver, address, name) {
        if (driver !== 'file') throw new Error(`Driver "${driver}" has no mutable folders`);
        const key = this.#backendFolderKey(name);
        const tree = await this.#directoryTreeForBackends();
        // rm -rf on disk removes the files → the watcher drops their docs; the
        // structural tree node is removed here (it survives empty otherwise).
        await this.#storedIndex.deleteBackendContainer(address, key);
        const root = this.#storedIndex.getBackendTreeRoot(address);
        if (root) await tree.removePath(`${root}/${key}`, true).catch(() => {});
        return { driver, address, folder: key, removed: true };
    }

    async renameBackendFolder(driver, address, fromName, toName) {
        if (driver !== 'file') throw new Error(`Driver "${driver}" has no mutable folders`);
        const fromKey = this.#backendFolderKey(fromName);
        const toKey = this.#backendFolderKey(toName);
        const tree = await this.#directoryTreeForBackends();
        // fs move relocates the bytes; the watcher re-files contained docs under
        // the new path (checksum-deduped). movePath keeps the structural node in
        // sync immediately (and carries empty folders the watcher can't see).
        await this.#storedIndex.renameBackendContainer(address, fromKey, toKey);
        const root = this.#storedIndex.getBackendTreeRoot(address);
        if (root) {
            // movePath asserts mutability with no ignoreLocks escape under the
            // locked /.backends root, so mirror the move as remove-old +
            // insert-new (same pattern as create/delete). The watcher re-files
            // the contained docs under the new path.
            await tree.removePath(`${root}/${fromKey}`, true).catch(() => {});
            await tree.insertPath(`${root}/${toKey}`, { ignoreLocks: true });
        }
        return { driver, address, from: fromKey, to: toKey };
    }

    // Pre-create folder discovery — probe a connector with candidate creds
    // before any instance exists (the "add account" flow).
    async discoverBackendFolders(driver, config = {}) {
        if (driver !== 'imap') throw new Error(`Driver "${driver}" does not support folder discovery`);
        return this.discoverImapFolders(config);
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
     * On-demand cached thumbnail for an image document (see
     * WorkspaceStoredIndex.getThumbnail). Returns {buffer, mime} or null.
     */
    async getDocumentThumbnail(doc, size = 256) {
        if (!this.#storedIndex?.isRunning) await this.#startStoredIndex();
        return this.#storedIndex.getThumbnail(doc, size);
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
            put: (record, options = {}) => this.put(record, { ...options, allowBackendsWrite: true }),
            unlink: (id, options = {}, unlinkOptions = {}) => this.unlink(id, options, { ...unlinkOptions, allowBackendsWrite: true }),
            getBackendsTreeSelector: this.getBackendsTreeSelector.bind(this),
            getDb: () => this.#db,
            // imap:// byte-ops are delegated to the mail service.
            describeImapLocation: (url) => this.#mailIndex?.describeImapLocation(url) ?? null,
            destroyImapLocation: (url) => this.#mailIndex?.destroyImapLocation(url) ?? null,
            lockBackendNode: (path, holder) => this.lockBackendTreeNode(path, holder),
            unlockBackendNode: (path, holder) => this.unlockBackendTreeNode(path, holder),
        });
    }

    async #startStoredIndex() {
        if (this.#storedIndex?.isRunning) return;
        this.#storedIndex = this.#buildStoredIndex();
        await this.#storedIndex.start();
        await this.#startMailIndex();
    }

    async #stopStoredIndex() {
        await this.#stopMailIndex();
        if (!this.#storedIndex) return;
        await this.#storedIndex.stop();
        this.#storedIndex = null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // IMAP mailboxes — delegated to the per-workspace mail service
    // (WorkspaceMailIndex). Config in config/stored.json; the mail service
    // shares the blob indexer's Stored instance to run imap backends.
    // ─────────────────────────────────────────────────────────────────────────

    #buildMailIndex() {
        return new WorkspaceMailIndex({
            rootPath: this.#rootPath,
            workspaceId: this.id,
            logger: this.#logger,
            put: (record, options = {}) => this.put(record, { ...options, allowBackendsWrite: true }),
            putMany: (records, options = {}) => this.putMany(records, { ...options, allowBackendsWrite: true }),
            getBackendsTreeSelector: this.getBackendsTreeSelector.bind(this),
            getDb: () => this.#db,
            // Persist email/attachment blobs into the local content-addressable
            // data store (workspace:data) via the blob indexer.
            persistBlob: (buffer) => this.#storedIndex.persistBlob(buffer),
            lockBackendNode: (path, holder) => this.lockBackendTreeNode(path, holder),
            unlockBackendNode: (path, holder) => this.unlockBackendTreeNode(path, holder),
            // Legacy /.backends subtree was dropped this start: re-file already
            // indexed emails into the backends tree from their metadata (no
            // network fetch).
            refileBackendsTree: this.#legacyBackendsMigrated,
        });
    }

    // Started alongside the blob indexer (and stopped before it). The mail
    // service is otherwise self-owned — it manages its own ImapBackend instances.
    async #startMailIndex() {
        if (this.#mailIndex?.isRunning) return;
        this.#mailIndex = this.#buildMailIndex();
        // Forward the mail service's object:* / source:state / error events with
        // workspaceId + source stamped (same envelope as the db runtime events).
        this.#mailRuntimeBinding = this.#createRuntimeListener(this.#mailIndex, 'imap');
        await this.#mailIndex.start();
    }

    async #stopMailIndex() {
        if (this.#mailRuntimeBinding) {
            this.#mailRuntimeBinding.emitter.off('**', this.#mailRuntimeBinding.listener);
            this.#mailRuntimeBinding = null;
        }
        if (!this.#mailIndex) return;
        await this.#mailIndex.stop();
        this.#mailIndex = null;
    }

    async #mail() {
        if (!this.#mailIndex?.isRunning) await this.#startStoredIndex();
        return this.#mailIndex;
    }

    // Read-only view that does NOT boot sources (safe for status polls).
    #mailReadonly() {
        return this.#mailIndex?.isRunning ? this.#mailIndex : this.#buildMailIndex();
    }

    // IMAP wrappers backing the unified backend facade (listBackends / addBackend
    // / syncBackend / containers). getImapStatus feeds the services status view.
    async listImapMailboxes() { return this.#mailReadonly().listMailboxes(); }
    async getImapStatus() { return this.#mailReadonly().getImapStatus(); }
    async saveImapMailbox(input) { return (await this.#mail()).saveMailbox(input); }
    async removeImapMailbox(id) { return (await this.#mail()).removeMailbox(id); }
    async testImapMailbox(id) { return (await this.#mail()).testMailbox(id); }
    async listImapMailboxFolders(id) { return (await this.#mail()).listMailboxFolders(id); }
    async discoverImapFolders(input) { return (await this.#mail()).discoverFolders(input); }
    async subscribeImapFolders(id, folders) { return (await this.#mail()).subscribeFolders(id, folders); }

    // Service-level enable/disable for 'imap'.
    async enableImap() { await this.#startStoredIndex(); return this.getImapStatus(); }
    async disableImap() { if (this.#mailIndex?.isRunning) await this.#mailIndex.disableImap(); return true; }

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
            return this.#db.getTree(Workspace.DIRECTORY_TREE_NAME);
        }

        await this.#db.createTree(Workspace.DIRECTORY_TREE_NAME, Workspace.DIRECTORY_TYPE);
        return this.#db.getTree(Workspace.DIRECTORY_TREE_NAME);
    }

    async #ensureBackendsTree() {
        const existing = this.#db.getTree(Workspace.BACKENDS_TREE_NAME);
        if (existing) {
            if (existing.type !== Workspace.DIRECTORY_TYPE) {
                throw new Error(`Tree "${Workspace.BACKENDS_TREE_NAME}" exists but is not a directory tree — rename it to free the reserved name`);
            }
            return existing;
        }

        // linkContextRoot:false keeps backend mirrors out of the user's context
        // root until explicitly filed; protected guards rename/destroy.
        await this.#db.createTree(Workspace.BACKENDS_TREE_NAME, Workspace.DIRECTORY_TYPE, {
            isDefault: false,
            settings: { linkContextRoot: false, protected: true },
        });
        return this.#db.getTree(Workspace.BACKENDS_TREE_NAME);
    }

    /**
     * One-shot migration: drop the legacy /.backends subtree from the directory
     * tree (nodes + memberships, reverse index cleaned by removePath). Documents
     * stay indexed with their context memberships and feature bitmaps intact;
     * the backends tree is repopulated by the file-backend resync and the mail
     * service re-file triggered further down in start() via the returned flag.
     */
    async #migrateLegacyBackendsSubtree() {
        const dirTree = this.#db.getTree(Workspace.DIRECTORY_TREE_NAME);
        if (!dirTree || dirTree.type !== Workspace.DIRECTORY_TYPE) return;
        if (typeof dirTree.pathExists !== 'function' || !dirTree.pathExists(Workspace.LEGACY_BACKENDS_PATH)) return;

        const bitmap = await dirTree.findRecursive(Workspace.LEGACY_BACKENDS_PATH).catch(() => null);
        const documentCount = bitmap?.size || 0;
        const result = await dirTree.removePath(Workspace.LEGACY_BACKENDS_PATH, true, { ignoreLocks: true });
        if (result?.error) {
            this.#logger.warn({ workspaceId: this.id, error: result.error }, 'Legacy /.backends migration failed; will retry next start');
            return;
        }
        this.#legacyBackendsMigrated = true;
        this.#logger.info({
            workspaceId: this.id,
            documentCount,
            removedNodes: result?.data?.removedNodeIds?.length || 0,
        }, 'Migrated legacy /.backends subtree out of the directory tree; backends tree repopulates via resync');
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
