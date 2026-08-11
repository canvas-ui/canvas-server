'use strict';

// Utils
import EventEmitter from 'eventemitter2';
import * as fsPromises from 'fs/promises';
import path from 'path';
import getFolderSize from 'get-folder-size';
import _Conf from 'conf';
import { v4 as _uuidv4 } from 'uuid';
// Logging
import { createLogger } from '../../utils/log.js';

// Includes
import Db from 'canvas-synapsd';
import { parseDocumentId, parseDocumentIdArray } from '../../utils/documentId.js';
import { BACKENDS_TREE_NAME, normalizeBackendsTreePath, normalizeSegment } from '../../utils/backend-documents.js';
import { parseLocationUrl } from 'canvas-synapsd/src/utils/path-helpers.js';

// Sub-modules
import { WorkspaceTokens } from './lib/WorkspaceTokens.js';
import { classifyDocument } from './lib/classifier.js';
import { extract as extractBlobMetadata } from 'canvas-stored/src/extractors/index.js';
import { pickGeo } from './lib/geo.js';
import { WorkspaceStoredIndex } from './lib/WorkspaceStoredIndex.js';
import { WorkspaceMailIndex } from './services/imap/index.js';
import { getServerDevice } from '../device/ServerDevice.js';

// Constants
import {
    WORKSPACE_STATUS_CODES,
    WORKSPACE_GIT_BARE_DIR,
    WORKSPACE_INTERNAL_DIRNAME,
    WORKSPACE_LAYOUTS,
    normalizeWorkspaceLayout,
    workspaceDirectories,
    workspaceInternals,
    workspaceStoredDefault,
    workspaceServices,
    WORKSPACE_STORAGE_BACKENDS,
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
    // Where a document goes when a filesystem-style delete removes its LAST
    // placement. A real path in the default directory tree — so listing,
    // restoring and emptying are ordinary tree operations — but dot-prefixed so
    // it stays out of `Trees/directory/` listings; WebDAV and canvas-fuse
    // present it as `Trash/` at the workspace root.
    static TRASH_PATH = '/.trash';
    // Tree types (used by the db layer)
    static CONTEXT_TYPE = 'context';
    static DIRECTORY_TYPE = 'directory';
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
    #mailRuntimeBinding = null;
    #tokens = null;
    #status = WORKSPACE_STATUS_CODES.INACTIVE;
    #startPromise = null;
    #runtimeListeners = [];
    #sessions = new Set();     // live QuerySessions opened over this workspace's db

    // Managers (injected)
    #inferd = null;            // shared embedding service (optional; server-managed)
    #inferdRegistered = false;
    #embedStoreCount = 0;      // storeVectors calls since the last mid-ingest compaction
    #imageSummaryRun = null;
    #imageSummaryStatus = { running: false, total: 0, described: 0, skipped: 0, failed: 0 };
    // Set by stopImageSummaries(); the run checks it between images.
    #imageSummaryCancel = false;

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
        this.#inferd = options.inferd || null;

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
    /**
     * On-disk folder structure this workspace was created with:
     *   'full' — visible runtime dirs at the root, user drive in `home/`
     *   'home' — the root IS the user's roaming drive, internals in `.workspace/`
     * Fixed at creation; only decides the DEFAULTS behind `internals`/`services`,
     * which remain the authority for every resolved path.
     */
    get layout() { return normalizeWorkspaceLayout(this.#configStore.get('layout')); }
    /** Hidden internals dir (`home` layout). Null for the `full` layout. */
    get internalsPath() {
        return this.layout === WORKSPACE_LAYOUTS.HOME
            ? path.join(this.#rootPath, WORKSPACE_INTERNAL_DIRNAME)
            : null;
    }
    get owner() { return this.#configStore.get('owner'); }
    get rootPath() { return this.#rootPath; }
    get status() { return this.#status; }
    get isActive() { return this.#status === WORKSPACE_STATUS_CODES.ACTIVE; }
    get config() { return this.#configStore.store; }
    get acl() { return this.#configStore.get('acl'); }
    get publicCanvasShares() { return this.#configStore.get('publicCanvasShares', {}); }

    // stored's config (services.stored): { root, cache, sync, backends } —
    // stored is storage only: its metadata index root, its in-workspace working
    // store (cache), sync policies, and the storage-backend map. Legacy
    // workspace.json kept a flat top-level `dataBackends` map with the cache as
    // a fake 'stored.cache' backend; #migrateConfigSchema rewrites that on
    // start, the read-side fallback here covers pre-migration reads.
    #storedConfig() {
        const defaults = workspaceStoredDefault(this.layout);
        const configured = (this.#configStore.get('services') || {}).stored;
        if (configured && typeof configured === 'object') {
            return {
                ...defaults,
                ...configured,
                // #mergeConfigMap is one level deep — materialize the nested
                // backends map explicitly against the storage defaults.
                backends: Workspace.#mergeConfigMap(defaults.backends, configured.backends || {}),
            };
        }
        const legacy = this.#configStore.get('dataBackends') || {};
        const { 'stored.cache': legacyCache, ...legacyBackends } = legacy;
        const legacyDirs = this.#configStore.get('directories', {}) || {};
        return {
            ...defaults,
            root: legacyDirs.stored ?? defaults.root,
            cache: legacyCache?.root ?? legacyDirs.cache ?? defaults.cache,
            backends: Workspace.#mergeConfigMap(defaults.backends, legacyBackends),
        };
    }

    // Storage backends only (services.stored.backends) — the cache is NOT a
    // backend, it's stored's own working store (see cachePath).
    get dataBackends() {
        return this.#storedConfig().backends;
    }

    // Single write authority for services.stored.backends. Keeps the rest of
    // the stored config (root/cache/sync) as-is; materializing the full shape
    // on write is intentional — workspace.json stays self-describing.
    #writeStoredBackends(backends) {
        const services = this.#configStore.get('services') || {};
        this.#configStore.set('services', { ...services, stored: { ...this.#storedConfig(), backends } });
    }

    get services() {
        return Workspace.#mergeConfigMap(workspaceServices(this.layout), this.#configStore.get('services') || {});
    }

    /**
     * inferd's config (`services.inferd`): `{ providers?, spaces?, rules? }`.
     *
     * This lives IN workspace.json on purpose. A workspace is meant to be
     * self-contained and movable — stop it, tar it, scp it, run it under
     * canvas-edge from a folder with no canvas-server at all — and which model
     * its vectors were built with is part of what makes it readable elsewhere.
     * Server and per-user config are *defaults* that a fresh workspace inherits;
     * once set here, this layer wins and travels with the data.
     *
     * Empty ({}) means "inherit everything", which is the normal case.
     */
    get inferdConfig() {
        const configured = (this.#configStore.get('services') || {}).inferd;
        return configured && typeof configured === 'object' ? configured : {};
    }

    get imageSummaryStatus() {
        const status = this.#imageSummaryStatus;
        return { ...status, errors: [...(status.errors || [])] };
    }

    /**
     * Single write authority for `services.inferd`. Validation happens above
     * this (the route asks inferd to resolve the candidate first) — a workspace
     * must never persist a config its own runtime would refuse.
     */
    setInferdConfig(config = {}) {
        const services = this.#configStore.get('services') || {};
        this.#configStore.set('services', { ...services, inferd: config });
        this.emit('services.changed', { service: 'inferd', config });
        return this.inferdConfig;
    }

    /**
     * Caption images into `metadata.summary` via inferd.describeImage (BLIP by
     * default). Scans `data/mime/image`, skips docs that already have a summary
     * unless `force`, then enqueues embedding so the reserved summary chunk is
     * filled. Returns immediately; poll `imageSummaryStatus`.
     */
    async startImageSummaries({ force = false } = {}) {
        if (!this.isActive) { throw new Error('Workspace is not active'); }
        if (!this.#inferd) { throw new Error('Inference service is not available'); }
        if (this.#imageSummaryStatus.running) {
            return { started: false, error: 'Image summary generation is already running', status: this.imageSummaryStatus };
        }

        const ctx = await this.#inferd.contextForWorkspace(this.id);
        if (!ctx.config.summarize?.image?.enabled) {
            throw new Error('image summaries are disabled — enable summarize.image first');
        }

        // A previous run may have been stopped by a crashed model worker, which
        // inferd refuses to respawn on its own. Starting a run by hand is the
        // deliberate retry that re-arms it.
        try { await this.#inferd.resetDescribeWorkers?.(this.id); } catch (_) { /* best effort */ }

        const bitmap = await this.getBitmap('data/mime/image', { includeData: true });
        const ids = Array.isArray(bitmap?.ids) ? bitmap.ids : [];
        this.#imageSummaryStatus = {
            running: true,
            total: ids.length,
            described: 0,
            skipped: 0,
            failed: 0,
            errors: [],
            // Set when a dead model worker cut the run short — the difference
            // between "every image failed" and "we stopped after the first".
            aborted: false,
            abortedReason: null,
            // Set when the operator stopped it on purpose.
            cancelled: false,
            force: force === true,
            startedAt: new Date().toISOString(),
            finishedAt: null,
        };

        this.#imageSummaryCancel = false;
        this.#imageSummaryRun = this.#runImageSummaries(ids, { force: force === true })
            .finally(() => {
                this.#imageSummaryRun = null;
                this.#imageSummaryStatus = {
                    ...this.#imageSummaryStatus,
                    running: false,
                    finishedAt: new Date().toISOString(),
                };
            });

        return { started: true, status: this.imageSummaryStatus };
    }

    /**
     * Ask a running caption run to stop.
     *
     * Cooperative rather than abortive: the in-flight image is allowed to
     * finish (a caption takes seconds, and killing the worker mid-generation
     * would just cost the model reload), then the loop exits at the next
     * boundary. Images not yet attempted stay untouched, so a later run picks
     * them up — nothing is half-written.
     */
    stopImageSummaries() {
        if (!this.#imageSummaryStatus.running) {
            return { stopped: false, error: 'No image summary run is in progress', status: this.imageSummaryStatus };
        }
        this.#imageSummaryCancel = true;
        return { stopped: true, status: this.imageSummaryStatus };
    }

    async #runImageSummaries(ids, { force }) {
        // A misconfiguration fails identically for every image — a model that
        // cannot load, a family the runner has no path for. Marching through
        // 1400 images to report the same sentence 1400 times is noise, so a run
        // that only ever fails gives up early and says why.
        const CONSECUTIVE_FAILURE_LIMIT = 5;
        let consecutiveFailures = 0;

        for (const id of ids) {
            if (this.#imageSummaryCancel) {
                this.#imageSummaryStatus.cancelled = true;
                return;
            }
            try {
                const input = await this.resolveEmbeddingInput(id);
                if (!input || input.skip || input.modality !== 'image' || !input.bytes) {
                    this.#imageSummaryStatus.skipped++;
                    continue;
                }
                if (!force && input.summary) {
                    this.#imageSummaryStatus.skipped++;
                    continue;
                }
                const text = await this.#inferd.describeImage(this.id, input.bytes, {
                    contentType: input.contentType || null,
                });
                await this.#getActiveDb().put({
                    id,
                    metadata: { summary: text },
                    updatedAt: new Date().toISOString(),
                });
                this.#imageSummaryStatus.described++;
                consecutiveFailures = 0;
            } catch (error) {
                this.#imageSummaryStatus.failed++;
                consecutiveFailures++;
                const errors = this.#imageSummaryStatus.errors || (this.#imageSummaryStatus.errors = []);
                if (errors.length < 20) {
                    errors.push({ id, error: error.message || String(error) });
                }
                // The model worker died (OOM, native crash) and inferd will not
                // respawn it. Carrying on would mark every remaining image
                // failed against a provider that cannot answer — so stop here
                // and say why, leaving the un-attempted images untouched for a
                // later run.
                if (error?.workerDead) {
                    this.#imageSummaryStatus.aborted = true;
                    this.#imageSummaryStatus.abortedReason = error.message || 'model worker died';
                    console.warn(`workspace ${this.id}: image summaries stopped — ${this.#imageSummaryStatus.abortedReason}`);
                    return;
                }
                if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
                    this.#imageSummaryStatus.aborted = true;
                    this.#imageSummaryStatus.abortedReason =
                        `${consecutiveFailures} images in a row failed — ${error.message || String(error)}`;
                    console.warn(`workspace ${this.id}: image summaries stopped — ${this.#imageSummaryStatus.abortedReason}`);
                    return;
                }
            }
        }
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
        // Embedding progress. The queue is this workspace's own, so the backlog
        // shown here is genuinely its work — re-indexing a 3-doc workspace no
        // longer reports the server's other 800 pending jobs. Combined with the
        // per-space embeddedDocs (semantic.vectorSpaces) the UI can show a
        // re-embed in flight and how far it's got.
        if (this.#inferd?.workspaceStatus) {
            try {
                // Actual routing (what really embeds where) from the inferd router
                // rules — notes/emails + text-file blobs → text, image/* → image.
                // Surfaced so the UI shows reality, not synapsd's note-only gap default.
                // This workspace's own router — what it actually embeds with,
                // after workspace.json overrides the user/server defaults.
                const router = (await this.#inferd.contextForWorkspace(this.id)).router;
                const routing = {};
                for (const r of (router?.rules || [])) {
                    const m = r.match || {};
                    const desc = m.schema != null ? String(m.schema)
                        : (m.contentType != null ? `mime ${String(m.contentType)}` : 'any');
                    (routing[r.space] ||= []).push(desc);
                }
                // Which provider/model fills each space — now that both are config,
                // the UI should say what is actually running rather than imply the
                // old hardcoded pair.
                const spaces = {};
                for (const sp of (router?.spaces || [])) {
                    const rule = router.spaceRule(sp);
                    if (rule) { spaces[sp] = { provider: rule.provider, model: rule.model, dim: rule.dim }; }
                }
                stats.inferd = { queue: this.#inferd.workspaceStatus(this.id), routing, spaces };
            } catch (_) { /* best effort */ }
        }
        return stats;
    }

    /**
     * Live-tune search knobs (persisted to workspace.json `semantic`, applied to
     * the running DB without a restart): image relevance floor + RRF fusion weights.
     * @param {{imageMaxDistance?: number|null, searchWeights?: {fts?:number, dense?:number, image?:number}}} tuning
     */
    async setSearchTuning(tuning = {}) {
        const current = this.#configStore.get('semantic', {}) || {};
        const next = { ...current };
        if (Object.prototype.hasOwnProperty.call(tuning, 'imageMaxDistance')) {
            next.imageMaxDistance = tuning.imageMaxDistance;
        }
        // Persisted alongside the ceiling so the mode survives a restart — the
        // db applies them live, the config store is what replays them on start.
        if (tuning.imageFloorMode === 'relative' || tuning.imageFloorMode === 'absolute') {
            next.imageFloorMode = tuning.imageFloorMode;
        }
        if (Number.isFinite(tuning.imageRelativeMargin) && tuning.imageRelativeMargin > 0) {
            next.imageRelativeMargin = tuning.imageRelativeMargin;
        }
        if (tuning.searchWeights && typeof tuning.searchWeights === 'object') {
            next.searchWeights = { ...(current.searchWeights || {}), ...tuning.searchWeights };
        }
        this.#configStore.set('semantic', next);
        const applied = this.#db?.setSearchTuning ? this.#db.setSearchTuning(tuning) : null;
        this.emit('semantic.changed', { id: this.id, semantic: next });
        return { semantic: next, applied };
    }

    // Resolve a config path value (absolute / `{WORKSPACE_ROOT}` template /
    // workspace-relative) to an absolute path.
    #resolveWorkspacePath(value) {
        if (!value) return null;
        const resolved = value.includes('{WORKSPACE_ROOT}')
            ? value.replaceAll('{WORKSPACE_ROOT}', this.#rootPath)
            : (path.isAbsolute(value) ? value : path.join(this.#rootPath, value));
        return path.resolve(resolved);
    }

    // Workspace INTERNALS (db/config/var/tmp …). The workspace.json `internals`
    // map overrides the defaults (legacy `directories` maps are still honored
    // below it). Storage locations (home/data/cache) are NOT here — those are
    // stored's config (see #storedConfig/#backendRoot); this is only the
    // non-service runtime dirs.
    #resolveDir(key) {
        const internals = this.#configStore.get('internals', {}) || {};
        const legacy = this.#configStore.get('directories', {}) || {};
        // internals uses `tmp` for what the legacy directories map called varTmp.
        const internalsKey = key === 'varTmp' ? 'tmp' : key;
        // Layout only supplies the fallback: an explicit internals/directories
        // entry always wins, so a hand-edited workspace.json stays authoritative.
        return this.#resolveWorkspacePath(internals[internalsKey] ?? legacy[key] ?? workspaceDirectories(this.layout)[key]);
    }

    // Single authority for a storage backend's byte-root: stored's backend config
    // (dataBackends). home/data/cache resolve through here so WebDAV, the /home
    // API, and stored's indexer can never point at different dirs.
    #backendRoot(backendName, fallbackDirKey) {
        return this.#resolveWorkspacePath(this.dataBackends[backendName]?.root) ?? this.#resolveDir(fallbackDirKey);
    }

    get homePath() {
        return this.#backendRoot('workspace:home', 'home');
    }

    get dataPath() {
        return this.#backendRoot('workspace:data', 'data');
    }

    /** stored's in-workspace working store (thumbnails, staging) — NOT a backend. */
    get cachePath() {
        return this.#resolveWorkspacePath(this.#storedConfig().cache) ?? this.#resolveDir('cache');
    }

    get dbPath() {
        return this.#resolveDir('db');
    }

    /** Stored's runtime root (metadata index; blob cache lives at cachePath). */
    get storedRootPath() {
        return this.#resolveWorkspacePath(this.#storedConfig().root) ?? this.#resolveDir('stored');
    }

    get gitPath() {
        return this.#resolveWorkspacePath(this.services.git?.root) ?? this.#resolveDir('git');
    }

    get gitBarePath() {
        return path.join(this.gitPath, WORKSPACE_GIT_BARE_DIR);
    }

    // Derived from gitPath, not resolved independently: hooks live INSIDE the
    // git working dir, so a remapped/relocated git root (or the `home` layout's
    // .workspace/git) must take them with it.
    get hooksPath() {
        const configured = (this.#configStore.get('internals', {}) || {}).hooks
            ?? (this.#configStore.get('directories', {}) || {}).hooks;
        return configured ? this.#resolveWorkspacePath(configured) : path.join(this.gitPath, 'hooks');
    }

    /** Git working-dir scripts (rule/hook scripts), sibling of hooks/. */
    get scriptsPath() {
        return path.join(this.gitPath, 'scripts');
    }

    /** Per-workspace service config dir (`config/*.json`). */
    get configDir() {
        return this.#resolveDir('config');
    }

    get rolesPath() {
        return this.#resolveDir('roles');
    }

    get varPath() {
        return this.#resolveDir('var');
    }

    /**
     * Every absolute path this workspace uses for its own runtime state. The
     * indexed file backends exclude anything in here that falls under their
     * root — the workspace must never index its own db/cache/git, which is what
     * would otherwise happen in the `home` layout where the home backend's root
     * IS the workspace root.
     */
    get internalPaths() {
        return [
            this.internalsPath,
            this.dbPath,
            this.storedRootPath,
            this.cachePath,
            this.dataPath,
            this.gitPath,
            this.configDir,
            this.varPath,
            this.rolesPath,
        ].filter(Boolean);
    }

    // Cheap start-time sanity check. A hand-edited (or half-migrated) config can
    // point an internal dir at a place the home backend would happily index; the
    // exclusions above already neutralise it, so this only warns — a workspace
    // must still start.
    #assertLayoutSane() {
        const home = this.homePath;
        if (this.layout !== WORKSPACE_LAYOUTS.HOME) { return; }
        if (path.resolve(home) !== path.resolve(this.#rootPath)) {
            this.#logger.warn({ workspaceId: this.id, home, root: this.#rootPath },
                'home-layout workspace: workspace:home root is not the workspace root');
        }
        const internals = this.internalsPath;
        for (const dir of this.internalPaths) {
            if (dir === internals) { continue; }
            if (!path.resolve(dir).startsWith(path.resolve(internals) + path.sep)) {
                this.#logger.warn({ workspaceId: this.id, dir },
                    'home-layout workspace: internal dir lives outside .workspace/ (excluded from indexing, but visible to the user)');
            }
        }
    }

    isDataBackendEnabled(backendName) {
        return this.dataBackends[backendName]?.enabled === true;
    }

    isServiceEnabled(serviceName) {
        return this.services[serviceName]?.enabled === true;
    }

    // Structural local stores every workspace depends on: workspace:data is the
    // managed blob target (persistBlob/stored:// addressing). It can't be
    // disabled, and as a managed (non-browseable, never exported) store the
    // readOnly knob is meaningless. (stored's cache is not a backend at all —
    // see services.stored.cache.)
    static #ALWAYS_ON_BACKENDS = new Set([WorkspaceStoredIndex.DATA_BLOB_BACKEND]);

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
        this.#writeStoredBackends(dataBackends);
        this.emit('dataBackends.changed', { backend: backendName, config: next });
        if (this.#storedIndex?.isRunning) {
            await this.#storedIndex.applyBackendConfig(backendName, next, patch).catch((err) =>
                this.#logger.warn({ workspaceId: this.id, backend: backendName, error: err.message }, 'Failed to apply data-backend config'),
            );
        }
    }

    // Database maintenance settings (Workspaces > Settings > Database).
    // orphanRetentionDays: window before GC purges data/no-location docs;
    // -1 (default) keeps orphans forever — explicit cleanup goes through the
    // data/no-location filter or gcOrphanedDocuments().
    get databaseSettings() {
        return { orphanRetentionDays: -1, ...(this.#configStore.get('database') || {}) };
    }

    setDatabaseSettings(patch = {}) {
        const next = { ...this.databaseSettings, ...patch };
        this.#configStore.set('database', next);
        this.emit('databaseSettings.changed', { workspaceId: this.id, settings: next });
        return next;
    }

    /** Purge orphaned (data/no-location) documents past the retention window. */
    async gcOrphanedDocuments(options = {}) {
        if (!this.#storedIndex?.isRunning) await this.#startStoredIndex();
        return this.#storedIndex.gcOrphanedDocuments(options);
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

    // Concurrent callers (WebDAV auto-start fires one per parallel request)
    // must share ONE in-flight start: isActive only flips near the end, so an
    // unserialized second call would re-run the whole sequence against a fresh
    // #db whose tree registry isn't loaded yet — duplicating the pre-created
    // trees ("context" et al.) in LMDB.
    async start() {
        if (this.isActive) return this;
        if (this.#startPromise) return this.#startPromise;
        this.#startPromise = this.#doStart().finally(() => { this.#startPromise = null; });
        return this.#startPromise;
    }

    // One-time workspace.json schema migration (mirrors stored's
    // #migrateLegacyStoredLayout): flat top-level `dataBackends` — with the
    // cache as a fake 'stored.cache' backend — becomes services.stored
    // { root, cache, sync, backends }, and the internals map is materialized
    // (carrying over any legacy `directories` overrides). Idempotent: the
    // legacy key is deleted after the rewrite, and every step is guarded on
    // "target absent". This is the only code that persists a normalized
    // config back to disk.
    #migrateConfigSchema() {
        try {
            const services = this.#configStore.get('services') || {};
            const legacy = this.#configStore.get('dataBackends');
            const legacyDirs = this.#configStore.get('directories', {}) || {};
            const storedDefaults = workspaceStoredDefault(this.layout);
            if (!services.stored && legacy && typeof legacy === 'object') {
                const { 'stored.cache': legacyCache, ...backends } = legacy;
                const stored = {
                    ...storedDefaults,
                    root: legacyDirs.stored ?? storedDefaults.root,
                    cache: legacyCache?.root ?? legacyDirs.cache ?? storedDefaults.cache,
                    backends,
                };
                this.#configStore.set('services', { ...services, stored });
                this.#logger.info({ workspaceId: this.id }, 'Migrated workspace.json dataBackends → services.stored');
            }
            if (this.#configStore.get('dataBackends') !== undefined && (this.#configStore.get('services') || {}).stored) {
                this.#configStore.delete('dataBackends');
            }
            if (!this.#configStore.get('internals')) {
                const internalDefaults = workspaceInternals(this.layout);
                this.#configStore.set('internals', {
                    db: legacyDirs.db ?? internalDefaults.db,
                    config: legacyDirs.config ?? internalDefaults.config,
                    var: legacyDirs.var ?? internalDefaults.var,
                    tmp: legacyDirs.varTmp ?? internalDefaults.tmp,
                });
            }
            // Pre-layout workspaces have no `layout` key; stamping the resolved
            // value (always 'full' for them) keeps the file self-describing and
            // makes the field readable without knowing the default.
            if (!this.#configStore.get('layout')) {
                this.#configStore.set('layout', this.layout);
            }
        } catch (err) {
            this.#logger.warn({ workspaceId: this.id, error: err.message }, 'workspace.json schema migration skipped');
        }
    }

    async #doStart() {
        this.#logger.debug({ workspaceId: this.id }, 'Starting workspace');
        try {
            this.#migrateConfigSchema();
            this.#assertLayoutSane();
            await Promise.all([
                // `home` layout: the internals dir must exist before anything
                // below it is created, and it is the one dir the user's drive
                // (= the root) must never surface.
                ...(this.internalsPath ? [fsPromises.mkdir(this.internalsPath, { recursive: true })] : []),
                fsPromises.mkdir(this.cachePath, { recursive: true }),
                fsPromises.mkdir(this.dataPath, { recursive: true }),
                fsPromises.mkdir(this.homePath, { recursive: true }),
                fsPromises.mkdir(this.hooksPath, { recursive: true }),
            ]);

            const dbPath = this.dbPath;
            // Resolve this workspace's embedding backends BEFORE synapsd starts:
            // the vector spaces (tables + ledger keys) are latched at Db
            // construction. workspace.json wins over the owner's defaults, so a
            // moved/standalone workspace keeps embedding as its vectors were built.
            const inferdSpaces = this.#inferd?.spaceConfigsForWorkspace
                ? await this.#inferd.spaceConfigsForWorkspace(this.id, { userId: this.owner, config: this.inferdConfig }).catch((err) => {
                    this.#logger.warn({ workspaceId: this.id, error: err.message }, 'inferd space config resolve failed; using defaults');
                    return undefined;
                })
                : undefined;
            this.#db = new Db({
                path: dbPath,
                // synapsd owns no model; if the inferd service is present, hand it
                // the query embedder so dense/hybrid search works. Absent → FTS.
                semantic: this.#inferd
                    ? {
                        // Bound to the OWNER: a query must be embedded by the same
                        // model that filled the space, or the kNN is noise.
                        embedQuery: (text, space) => this.#inferd.embedQueryForWorkspace(this.id, text, space),
                        // The inferd router owns each space's model + dim, so it also
                        // owns where those vectors live: a space on its baseline model
                        // keeps the original table, any other model gets its own table
                        // AND its own presence/seen ledger. That is what makes a model
                        // swap reversible — switch back and the previous vectors are
                        // still there, still marked embedded, nothing to redo.
                        spaces: inferdSpaces,
                        // Workspace-level search tuning (persisted in workspace.json
                        // under `semantic`). Undefined → synapsd defaults.
                        imageMaxDistance: (this.#configStore.get('semantic', {}) || {}).imageMaxDistance,
                        imageFloorMode: (this.#configStore.get('semantic', {}) || {}).imageFloorMode,
                        imageRelativeMargin: (this.#configStore.get('semantic', {}) || {}).imageRelativeMargin,
                        searchWeights: (this.#configStore.get('semantic', {}) || {}).searchWeights,
                    }
                    : undefined,
            });
            await this.#db.start();
            await this.#ensureContextTree();
            await this.#ensureDirectoryTree();
            await this.#ensureBackendsTree();
            this.#bindRuntimeEvents();
            this.#registerInferd();
            // Resume interrupted embedding: the inferd queue is in-memory, so a
            // restart mid-ingest strands docs in the durable bitmap ledger until
            // something re-drives them. Reconcile is a cheap idempotent bitmap
            // read when there is no gap — safe to fire on every start.
            if (this.#inferd?.reconcile) {
                this.#inferd.reconcile(this.id).then((r) => {
                    if (r?.enqueued > 0) {
                        this.#logger.info({ workspaceId: this.id, enqueued: r.enqueued }, 'Embedding reconcile resumed pending docs');
                    }
                }).catch((err) =>
                    this.#logger.warn({ workspaceId: this.id, error: err.message }, 'Start-time embedding reconcile failed'));
            }
            // Mark ACTIVE before booting stored/mail indices: their initial sync
            // (IMAP scan → ingestMessage → #put → #getActiveDb) needs isActive,
            // otherwise every fetched message rejects with "Workspace not active".
            this.#setStatus(WORKSPACE_STATUS_CODES.ACTIVE);
            if (this.isServiceEnabled('home') || this.isDataBackendEnabled(WorkspaceStoredIndex.HOME_STORED_BACKEND)) {
                await this.#startStoredIndex();
                for (const [name, cfg] of Object.entries(this.dataBackends)) {
                    if (!cfg?.enabled || !cfg.resync || cfg.supported === false || cfg.driver !== 'file') continue;
                    // Catch up external (device-scoped) mounts on start — a
                    // restart may have killed their initial scan mid-flight, and
                    // without a watcher nothing else would ever finish it. Cheap
                    // when already indexed: the checksum cache skips re-hashing
                    // unchanged files.
                    const isExternalMount = !!cfg.device?.id && !!cfg.root && !cfg.root.includes('{WORKSPACE_ROOT}');
                    if (!isExternalMount) continue;
                    try { this.#storedIndex.resyncInBackground(name); } catch (err) {
                        this.#logger.warn({ workspaceId: this.id, backend: name, error: err.message }, 'Start-time resync failed to start');
                    }
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
            this.#unregisterInferd();
            // Sessions subscribe to db events and hold its bitmaps — drop them
            // before the db goes away, or they keep firing against a dead handle.
            this.#closeSessions();
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
        const result = await this.#getActiveDb().put(record, {
            ...Workspace.#buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
            ...(provenance ? { provenance } : {}),
        });
        // A re-put of identical content resolves to the SAME document by
        // checksum, so this is also the path a copy-then-delete move takes.
        await this.#untrashOnLink(result).catch(() => {});
        return result;
    }

    async link(id, { context = '/', directory = null, features = [], attributes, emitEvent = true, allowBackendsWrite = false, provenance = null } = {}) {
        this.#assertBackendsWriteAllowed(directory, allowBackendsWrite);
        const result = await this.#getActiveDb().link(id, {
            ...Workspace.#buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
            ...(provenance ? { provenance } : {}),
        });
        await this.#untrashOnLink(id).catch(() => {});
        return result;
    }

    /**
     * Remove a document from a path. Non-destructive: the document survives in
     * the store and in every other path it is filed under.
     *
     * `options.trashIfOrphaned` adds the filesystem-mount rule — if this was the
     * document's LAST placement it is filed into the trash path instead of
     * becoming reachable only through the flat workspace-wide list. See
     * `docs/data-representation.md`.
     */
    async unlink(id, { context = null, directory = null, features = [], attributes } = {}, options = {}) {
        this.#assertBackendsWriteAllowed(directory, options.allowBackendsWrite === true);
        const { trashIfOrphaned = false, ...dbOptions } = options;

        // Snapshot placements BEFORE the unlink — afterwards the very paths a
        // restore would have to put the document back into are gone.
        const placementsBefore = trashIfOrphaned
            ? await this.listDocumentPlacements(id).catch(() => [])
            : null;

        const result = await this.#getActiveDb().unlink(id, {
            ...Workspace.#buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            ...dbOptions,
        });

        if (trashIfOrphaned) { await this.#trashIfOrphaned(id, placementsBefore); }
        return result;
    }

    async delete(id, options = {}) {
        const docId = parseDocumentId(id, 'Document ID');
        const { managedBlobs, checksums } = await this.#collectDeletionArtifacts([docId]);
        const result = await this.#getActiveDb().delete(docId, options);
        if (result) {
            await this.#cascadeManagedBlobDeletion(managedBlobs);
            await this.#purgeDeletedDocThumbnails(checksums);
        }
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

    // ── Embedding (inferd service seam) ───────────────────────────────────────
    // synapsd owns no embedding model; the inferd service computes vectors and
    // pushes them back here. These two methods are the workspace-level adapter
    // the inferd service registers with (storeVectors + resolveInput).

    // Mid-ingest maintenance cadence: every N vector upserts, compact the Lance
    // tables + refresh the ANN index. Each upsert is its own delete+add commit,
    // so a bulk import otherwise accumulates thousands of tiny fragments that
    // every query must brute-force scan — search latency grows with ingest
    // progress until it times out. Runs inside the (sequential) inferd queue
    // handler, so it never races other vector writes.
    static #EMBED_OPTIMIZE_EVERY = Math.max(50, Number(process.env.CANVAS_INFERD_OPTIMIZE_EVERY) || 500);

    /** Vector sink: persist inferd-computed chunk vectors into a synapsd space. */
    async storeDocumentEmbeddings(docId, schema, updatedAt, chunks, opts = {}) {
        const res = await this.#getActiveDb().storeDocumentEmbeddings(
            parseDocumentId(docId, 'Document ID'), schema, updatedAt, chunks, opts,
        );
        if (++this.#embedStoreCount >= Workspace.#EMBED_OPTIMIZE_EVERY) {
            this.#embedStoreCount = 0;
            await this.#optimizeSearchIndexes('mid-ingest');
        }
        return res;
    }

    /**
     * Compact Lance fragments, prune old versions and (re)build ANN indexes for
     * all vector spaces + the FTS table. Best-effort: FTS compaction can lose a
     * commit race against concurrent document puts (chokidar ingest) — that
     * attempt aborts harmlessly and the next cadence retries.
     */
    async #optimizeSearchIndexes(reason) {
        const db = this.#getActiveDb();
        try {
            await db.optimizeVectors();
            await db.optimizeLance();
            this.#logger.info({ workspaceId: this.id, reason }, 'Search indexes optimized');
        } catch (error) {
            this.#logger.warn({ workspaceId: this.id, reason, error: error.message }, 'Search index optimize failed');
        }
    }

    /**
     * Re-resolve this workspace's embedding backends and swap synapsd's vector
     * spaces to match — applied live, no workspace restart.
     *
     * Writes are quiesced first: the workspace's embedding queue is paused and
     * its in-flight batch allowed to finish, otherwise a batch straddling the
     * swap would scatter half its chunks into the outgoing table.
     */
    async applyInferdSpaces() {
        if (!this.#inferd || !this.isActive) { return { applied: false, reason: 'workspace not active' }; }
        const spaces = await this.#inferd.spaceConfigsForWorkspace(this.id, {
            userId: this.owner, config: this.inferdConfig,
        });
        this.#inferd.pause(this.id);
        try {
            await this.#inferd.drained(this.id);
            const result = await this.#getActiveDb().setVectorSpaces(spaces);
            this.#logger.info({ workspaceId: this.id, tables: result.tables }, 'Embedding vector spaces swapped');
            return result;
        } finally {
            this.#inferd.resume(this.id);
        }
    }

    /** Document ids under a `ctx://` / `dir://` path — scopes a partial re-embed. */
    async documentIdsUnderScope(scope) {
        return await this.#getActiveDb().documentIdsUnderScope(scope);
    }

    /** Ledger read: docIds that match `schemas` but have no embedding for `space`. */
    async getUnembeddedDocIds(space = 'text', schemas = null) {
        return await this.#getActiveDb().getUnembeddedDocIds(space, schemas);
    }

    /** Wipe an embedding space (vectors + presence + seen) for a full re-embed. */
    async clearSpace(space = 'text') {
        return await this.#getActiveDb().clearSpace(space);
    }

    /**
     * Dense-vector tables in this workspace, flagged with which are live. Tables
     * a model swap left behind report `active:false` — they still hold their
     * vectors so switching back is free, and this is how you find the ones worth
     * reclaiming.
     */
    async listVectorTables() {
        return await this.#getActiveDb().listVectorTables();
    }

    /** Drop a superseded model's vectors + ledger. Refuses live tables. */
    async dropVectorTable(name) {
        return await this.#getActiveDb().dropVectorTable(name);
    }

    // ── inferd registration + live enqueue ────────────────────────────────────

    /** Register this workspace with the shared inferd service + subscribe events. */
    #registerInferd() {
        if (!this.#inferd || this.#inferdRegistered) { return; }
        this.#inferd.registerWorkspace(this.id, {
            resolveInput: (docId) => this.resolveEmbeddingInput(docId),
            storeVectors: (docId, schema, updatedAt, chunks, opts) =>
                this.storeDocumentEmbeddings(docId, schema, updatedAt, chunks, opts),
            getUnembedded: (space, schemas) => this.getUnembeddedDocIds(space, schemas),
            documentIdsUnderScope: (scope) => this.documentIdsUnderScope(scope),
            clearSpace: (space) => this.clearSpace(space),
            onQueueDrained: () => {
                // The shared queue drains after every trickle (a single note
                // save); a full compact + HNSW rebuild per save would dwarf the
                // ingest itself. Only optimize once enough upserts accumulated —
                // queries tolerate a few dozen fragments fine.
                if (this.#embedStoreCount < 50) { return; }
                this.#embedStoreCount = 0;
                return this.#optimizeSearchIndexes('queue-drained');
            },
        }, { userId: this.owner, config: this.inferdConfig });
        // Live enqueue: new + content-updated docs. Blob ingestion also lands as
        // document.inserted (WorkspaceStoredIndex creates docs), so this covers
        // stored files too — no separate object:add subscription needed.
        //
        // Batch ops (tab ingestion, 100+ uploads, fs/directory bulk ingest) are
        // the common case — they emit `.batch` events with an id array. We
        // subscribe to both the singular and `.batch` variants: some bulk
        // emitters (putManyDirectoryPaths) fire only the singular event with
        // `ids`, regular putMany fires both, and linkMany fires only `.batch`.
        // The queue dedups by `${wsId}:${id}`, so the one overlap (putMany
        // emitting both) is a harmless no-op — no path is missed or embedded
        // twice.
        this.on('document.inserted', this.#onDocEventForEmbed);
        this.on('document.updated', this.#onDocEventForEmbed);
        this.on('document.inserted.batch', this.#onDocEventForEmbed);
        this.on('document.updated.batch', this.#onDocEventForEmbed);
        this.#inferdRegistered = true;
    }

    #unregisterInferd() {
        if (!this.#inferd || !this.#inferdRegistered) { return; }
        this.off('document.inserted', this.#onDocEventForEmbed);
        this.off('document.updated', this.#onDocEventForEmbed);
        this.off('document.inserted.batch', this.#onDocEventForEmbed);
        this.off('document.updated.batch', this.#onDocEventForEmbed);
        this.#inferd.unregisterWorkspace(this.id);
        this.#inferdRegistered = false;
    }

    // Handles both single (`{ id }`) and batch (`{ ids: [...] }`) payloads;
    // enqueueMany routes through the same deduped queue as enqueue.
    #onDocEventForEmbed = (payload) => {
        if (!this.#inferd) { return; }
        const ids = Array.isArray(payload?.ids)
            ? payload.ids
            : (payload?.id != null ? [payload.id] : []);
        if (ids.length === 0) { return; }
        this.#inferd.enqueueMany(this.id, ids);
    };

    /**
     * Input source for embedding one document. Return shapes:
     *   - null                          → doc gone (do NOT record as seen)
     *   - { skip:true, schema, ... }    → exists but not inferdable (record as seen)
     *   - { modality, schema, ... }     → inferdable (text|image + text|bytes)
     *
     * A `data/schema/file` is a byte blob: embed it from its *content*
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
        // so the inferd worker can give any commented doc a dedicated text vector.
        const comment = doc.hasComment ? doc.comment.trim() : '';
        // Generated summary (metadata.summary, captioner output) rides the same
        // rails into its own reserved text-space chunk.
        const summary = doc.hasSummary ? doc.metadata.summary.trim() : '';

        if (classification.isFile()) {
            // Byte blob: only text/image content is inferdable; everything else
            // (pdf, octet-stream, …) is a deliberate skip until a decoder/CLIP
            // model exists. Bytes must be reachable from this instance: stored://,
            // workspace files, or file://<deviceId> when the id is THIS device
            // (foreign-device locations throw and fall through to skip).
            if (!classification.isBlob() || !contentType) { return { skip: true, schema, updatedAt, contentType, comment, summary }; }
            const modality = classification.embeddingModality();
            if (!modality) { return { skip: true, schema, updatedAt, contentType, comment, summary }; }
            let resolveError = null;
            const resolved = await this.resolveDocument(doc).catch((e) => { resolveError = e; return null; });
            if (!resolved?.buffer) {
                // We classified this as an inferdable blob but its bytes are
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
                return { skip: true, schema, updatedAt, contentType, comment, summary };
            }
            if (modality === 'image') {
                const enrichedAt = await this.#enrichImageDocMetadata(doc, resolved.buffer, contentType)
                    .catch((e) => { this.#logger.warn({ workspaceId: this.id, docId: doc.id, error: e.message }, 'embed: image metadata enrichment failed'); return null; });
                return { modality, schema, updatedAt: enrichedAt || updatedAt, bytes: resolved.buffer, contentType, comment, summary };
            }
            return { modality, schema, updatedAt, text: resolved.buffer.toString('utf8'), contentType, chunkOpts, comment, summary };
        }

        // JSON abstraction (note, etc.) → the text the doc exposes for embedding.
        const data = typeof doc.generateEmbeddingsData === 'function' ? doc.generateEmbeddingsData() : null;
        const text = Array.isArray(data) ? data.join('\n').trim() : (typeof data === 'string' ? data.trim() : '');
        if (!text) { return { skip: true, schema, updatedAt, contentType, comment, summary }; }
        return { modality: 'text', schema, updatedAt, text, contentType, chunkOpts, comment, summary };
    }

    /**
     * EXIF/GPS/dimensions enrichment at embed time. Stored-backend ingest
     * extracts this inline (WorkspaceStoredIndex); photos that never pass
     * through it (file://-indexed via `ws add`, docs ingested before extraction
     * existed) hit this seam instead — the embed pipeline is the one place every
     * image's bytes already flow through. Extracted keys merge into
     * doc.metadata and an EXIF capture date lands on the 'content' timeline
     * (same convention as stored ingest), so photos are filterable by when they
     * were taken rather than when they were indexed.
     * Returns the post-update updatedAt, or null when nothing was written.
     */
    async #enrichImageDocMetadata(doc, buffer, contentType) {
        const meta = doc.metadata || {};
        // Bail only on keys that prove extraction already ran. A bare `geo` means
        // device/manual geo arrived from a client without EXIF ever being read,
        // so we still extract — the camera's fix outranks the uploader's location
        // and pickGeo below decides, rather than this guard.
        if (meta.exif || meta.dimensions) { return null; }
        const extracted = await extractBlobMetadata({ data: buffer }, { mimeType: contentType, key: `doc:${doc.id}` });
        const patch = {};
        for (const k of ['exif', 'dimensions', 'media']) {
            if (extracted[k] && typeof extracted[k] === 'object') { patch[k] = extracted[k]; }
        }
        // metadata patches shallow-merge top-level keys (Document.update), so
        // `geo` is replaced wholesale — resolve the winner first, and only write
        // when it actually changes to avoid a no-op update.
        const geo = pickGeo(meta.geo, extracted.geo, { incomingSource: 'exif' });
        if (geo && JSON.stringify(geo) !== JSON.stringify(meta.geo)) { patch.geo = geo; }
        if (Object.keys(patch).length === 0) { return null; }

        const update = { id: doc.id, metadata: patch, updatedAt: new Date().toISOString() };
        const capturedAt = extracted.exif?.capturedAt;
        const prior = Array.isArray(doc.timelines) ? doc.timelines : [];
        if (capturedAt && !prior.some((t) => (t.timeline || t.name) === 'content')) {
            update.timelines = [...prior, { timeline: 'content', start: capturedAt }];
        }
        // emitEvent:false — this runs inside the embed pipeline; a
        // document.updated event here would re-enqueue the doc and CLIP-embed
        // every photo a second time.
        await this.#getActiveDb().put(update, { emitEvent: false });
        return update.updatedAt;
    }

    async linkMany(ids, { context = '/', directory = null, features = [], attributes, emitEvent = true, allowBackendsWrite = false } = {}) {
        this.#assertBackendsWriteAllowed(directory, allowBackendsWrite);
        return await this.#getActiveDb().linkMany(parseDocumentIdArray(ids, 'Document ID array'), {
            ...Workspace.#buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            emitEvent,
        });
    }

    /** Bulk `unlink`; `options.trashIfOrphaned` applies the same rule per document. */
    async unlinkMany(ids, { context = null, directory = null, features = [], attributes } = {}, options = {}) {
        this.#assertBackendsWriteAllowed(directory, options.allowBackendsWrite === true);
        const docIds = parseDocumentIdArray(ids, 'Document ID array');
        const { trashIfOrphaned = false, ...dbOptions } = options;

        const placementsBefore = new Map();
        if (trashIfOrphaned) {
            for (const docId of docIds) {
                placementsBefore.set(docId, await this.listDocumentPlacements(docId).catch(() => []));
            }
        }

        const result = await this.#getActiveDb().unlinkMany(docIds, {
            ...Workspace.#buildWriteSpec(context, directory),
            features: this.#normalizeFeatureInput(features, attributes),
            ...dbOptions,
        });

        if (trashIfOrphaned) {
            for (const entry of (result?.successful ?? [])) {
                const docId = entry?.id ?? entry;
                await this.#trashIfOrphaned(docId, placementsBefore.get(docId) || []).catch(() => {});
            }
        }
        return result;
    }

    async deleteMany(ids, options = {}) {
        const docIds = parseDocumentIdArray(ids, 'Document ID array');
        const { managedBlobs, checksums } = await this.#collectDeletionArtifacts(docIds);
        const result = await this.#getActiveDb().deleteMany(docIds, options);
        const deletedIds = new Set((result?.successful ?? []).map((entry) => entry?.id ?? entry));
        await this.#cascadeManagedBlobDeletion(managedBlobs, deletedIds);
        await this.#purgeDeletedDocThumbnails(checksums, deletedIds);
        return result;
    }

    /**
     * Pre-delete snapshot for a plain index-delete's side effects:
     * - managedBlobs: documents whose EVERY location lives on a managed stored
     *   backend (workspace:data — opaque, non-browseable by design) would
     *   orphan their blobs; the URLs are collected so the bytes can be removed
     *   after the delete succeeds. Documents with any user-owned location
     *   (workspace:home file, imap message, device) are never touched.
     * - checksums: primary checksum per doc, so cached thumbnails (derived
     *   artifacts keyed thumb:<checksum>:<size>) can be dropped too.
     */
    async #collectDeletionArtifacts(ids) {
        const managedBackends = new Set(Object.entries(this.dataBackends || {})
            .filter(([, cfg]) => cfg?.managed === true && cfg?.readOnly !== true && cfg?.enabled !== false)
            .map(([name]) => name));
        const managedBlobs = new Map();
        const checksums = new Map();
        if (ids.length === 0) { return { managedBlobs, checksums }; }

        const fetched = await this.getDocumentsByIdArray(ids, { parse: false }).catch(() => null);
        const docs = Array.isArray(fetched) ? fetched : (fetched?.data ?? []);
        for (const doc of docs.filter(Boolean)) {
            if (Array.isArray(doc.checksumArray) && doc.checksumArray[0]) {
                checksums.set(doc.id, doc.checksumArray[0]);
            }
            const urls = (doc.locations || []).map((l) => l?.url).filter(Boolean);
            if (urls.length === 0 || managedBackends.size === 0) { continue; }
            const allManaged = urls.every((url) => {
                const parsed = parseLocationUrl(url);
                return parsed?.scheme === 'stored' && managedBackends.has(parsed.backend);
            });
            if (allManaged) { managedBlobs.set(doc.id, urls); }
        }
        return { managedBlobs, checksums };
    }

    // Cache hygiene, not correctness (thumbnails are content-addressed): drop
    // deleted docs' cached thumbnails so derived artifacts don't accumulate.
    // Skipped when the stored index isn't running — not worth booting it for.
    async #purgeDeletedDocThumbnails(checksums, deletedIds = null) {
        if (!checksums || checksums.size === 0 || !this.#storedIndex?.isRunning) { return; }
        const targets = [];
        for (const [docId, checksum] of checksums) {
            if (deletedIds && !deletedIds.has(docId)) { continue; }
            targets.push(checksum);
        }
        if (targets.length > 0) {
            await this.#storedIndex.purgeThumbnails(targets).catch(() => {});
        }
    }

    /** Wipe every cached thumbnail (regenerated on demand). */
    async clearThumbnailCache() {
        if (!this.#storedIndex?.isRunning) await this.#startStoredIndex();
        return await this.#storedIndex.clearThumbnailCache();
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
                const res = await this.#storedIndex.resolve(loc.url, options);
                const data = res?.data;
                if (data != null) return { ...(options.stream ? { stream: data } : { buffer: data }), url: loc.url, ranged: !!res.ranged };
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
     * inferdable. This is the byte half of `canvas ws insert`.
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

    /**
     * Every place this document is filed: which paths of which trees hold it.
     * The data behind the Synapses tab, and the basis of the orphan test and of
     * trash restore provenance.
     */
    async listDocumentPlacements(id) {
        const docId = parseDocumentId(id, 'Document ID');
        const placements = [];
        for (const tree of await this.listTrees()) {
            if (!tree) { continue; }
            const paths = await this.listDocumentTreeMemberships(docId, tree.id).catch(() => []);
            placements.push({ tree: tree.name, treeId: tree.id, type: tree.type, paths });
        }
        return placements;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Trash — see docs/data-representation.md
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Is this document filed anywhere a user can navigate to?
     *
     * The root of a CONTEXT tree does not count. Every insert ticks it (tree
     * setting `linkContextRoot`) and `unlink` refuses to remove it, so a `/`
     * membership there means "exists in this workspace", not "filed somewhere" —
     * counting it would make every document look filed forever and the orphan
     * test a constant false. A directory tree's `/` DOES count: it is a real
     * folder and nothing ticks it implicitly.
     */
    static #isFiled(placements) {
        return placements.some(({ type, paths }) =>
            paths.some((path) => !(type === Workspace.CONTEXT_TYPE && path === '/')));
    }

    getTrashSelector() {
        return this.getDirectoryTreeSelector(Workspace.TRASH_PATH, Workspace.DIRECTORY_TREE_NAME);
    }

    #trashProvenanceKey(docId) { return `workspace/trash/${docId}`; }

    // File an orphaned document into the trash path. `placementsBefore` is the
    // snapshot taken before the unlink that orphaned it — restore puts it back
    // exactly there.
    async #trashIfOrphaned(id, placementsBefore = null) {
        const docId = parseDocumentId(id, 'Document ID');

        // Only an unlink that ORPHANS a document trashes it. A document that was
        // already filed nowhere (never filed, or detached earlier by the plain
        // API) is left alone: this unlink changed nothing, and sweeping such
        // documents into the trash on an unrelated bulk remove would be a
        // surprise — with no provenance to restore them by, at that.
        if (placementsBefore && !Workspace.#isFiled(placementsBefore)) { return false; }

        const placements = await this.listDocumentPlacements(docId);
        if (Workspace.#isFiled(placements)) { return false; }

        const db = this.#getActiveDb();
        await db.link(docId, { context: null, directory: this.getTrashSelector() });
        await db.internalStore.put(this.#trashProvenanceKey(docId), {
            trashedAt: new Date().toISOString(),
            placements: (placementsBefore || []).map(({ tree, treeId, type, paths }) => ({
                tree, treeId, type,
                // A context root is not a place to restore to (see #isFiled).
                paths: paths.filter((path) => !(type === Workspace.CONTEXT_TYPE && path === '/')),
            })).filter((placement) => placement.paths.length > 0),
        });
        this.#trashedIds?.add(docId);
        return true;
    }

    // Ids currently in the trash, so the untrash-on-link check on the write path
    // is a Set lookup rather than an index read. Seeded lazily; kept in sync by
    // the trash operations themselves (all of which live in this class).
    #trashedIds = null;

    async #loadTrashedIds() {
        if (this.#trashedIds) { return this.#trashedIds; }
        const { ids } = await this.#getActiveDb()
            .listTreeDocuments(Workspace.DIRECTORY_TREE_NAME, { path: Workspace.TRASH_PATH, idsOnly: true })
            .catch(() => ({ ids: [] }));
        this.#trashedIds = new Set(ids || []);
        return this.#trashedIds;
    }

    /**
     * Filing a document anywhere real takes it out of the trash. This is what
     * makes a file manager's copy-then-delete move self-healing regardless of
     * which half lands first — content addressing resolves the copy to the same
     * document, and if the delete got there first, the copy un-trashes it.
     */
    async #untrashOnLink(idOrResult) {
        // put() answers with an id (or a result carrying one); link() is called
        // with the id directly.
        const raw = (idOrResult && typeof idOrResult === 'object') ? idOrResult.id : idOrResult;
        if (raw === undefined || raw === null) { return false; }
        const docId = parseDocumentId(raw, 'Document ID');

        const trashed = await this.#loadTrashedIds();
        if (!trashed.has(docId)) { return false; }

        const db = this.#getActiveDb();
        await db.unlink(docId, { context: null, directory: this.getTrashSelector() });
        await db.internalStore.remove(this.#trashProvenanceKey(docId));
        trashed.delete(docId);
        return true;
    }

    async listTrash({ limit = null, offset = 0, parse = true } = {}) {
        const db = this.#getActiveDb();
        const result = await db.listTreeDocuments(Workspace.DIRECTORY_TREE_NAME, {
            path: Workspace.TRASH_PATH, limit, offset, parse,
        });
        const documents = (result.documents || []).map((document) => ({
            ...document,
            trashed: db.internalStore.get(this.#trashProvenanceKey(document.id)) || null,
        }));
        return { ...result, documents };
    }

    /**
     * Put documents back where they were when they were trashed. Missing tree
     * paths are recreated — a restore whose folder was deleted meanwhile should
     * still land somewhere, not fail.
     */
    async restoreFromTrash(ids) {
        const docIds = parseDocumentIdArray(ids, 'Document ID array');
        const db = this.#getActiveDb();
        const restored = [];
        const failed = [];

        for (const docId of docIds) {
            try {
                const provenance = db.internalStore.get(this.#trashProvenanceKey(docId));
                let relinked = 0;
                for (const placement of (provenance?.placements || [])) {
                    for (const path of placement.paths) {
                        const tree = this.getTree(placement.treeId) || this.getTree(placement.tree);
                        if (!tree) { continue; }
                        if (!tree.pathExists(path)) { await tree.insertPath(path); }
                        const selector = placement.type === Workspace.DIRECTORY_TYPE
                            ? { context: null, directory: this.getDirectoryTreeSelector(path, tree.name) }
                            : { context: this.getContextTreeSelector(path, tree.name), directory: null };
                        await db.link(docId, selector);
                        relinked++;
                    }
                }

                // Nothing was put back (no provenance recorded, or its trees are
                // gone): leave the document IN the trash. Taking it out anyway
                // would strand it — filed nowhere and no longer listed here.
                if (relinked === 0) {
                    failed.push({ id: docId, error: 'No restore target recorded' });
                    continue;
                }
                await this.#untrashOnLink(docId);
                restored.push(docId);
            } catch (error) {
                failed.push({ id: docId, error: error.message });
            }
        }
        return { restored, failed, count: docIds.length };
    }

    /**
     * Empty the trash: the ONE place a filesystem-side delete is allowed to
     * destroy. Purges the index and cascades to canvas-owned (`stored://`)
     * blobs; foreign locations (imap, a mounted NAS) are never touched — see
     * "Storage policies" in TODO.md for the policy layer that will replace this
     * blanket rule.
     */
    async emptyTrash({ documentIds = null } = {}) {
        const db = this.#getActiveDb();
        const ids = documentIds
            ? parseDocumentIdArray(documentIds, 'Document ID array')
            : (await db.listTreeDocuments(Workspace.DIRECTORY_TREE_NAME, {
                path: Workspace.TRASH_PATH, idsOnly: true,
            })).ids;
        if (!ids.length) { return { destroyed: [], failed: [], count: 0 }; }

        const result = await this.deleteMany(ids);
        const destroyed = (result?.successful ?? []).map((entry) => entry?.id ?? entry);
        for (const docId of destroyed) {
            await db.internalStore.remove(this.#trashProvenanceKey(docId));
            this.#trashedIds?.delete(docId);
        }
        return { destroyed, failed: result?.failed ?? [], count: ids.length };
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

    // Per-bucket counts across timelines, intersected with the same candidate
    // scope as list() (context/directory path, features, filters, canvas
    // querySpec folding) — so rail densities always agree with the document list.
    async timelineHistogram(names, buckets, spec = {}) {
        const db = this.#getActiveDb();
        const querySpec = this.#normalizeQuerySpec(this.#composeCanvasQuerySpec(spec));
        const { bitmap } = await db.resolveCandidates(querySpec);
        return await db.timeline.histogram(names, buckets, bitmap);
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

    // Compound query: OR/AND of independent refinement chains ("lines"). `spec`
    // supplies the shared structured scope, each line its own query chain (+
    // optional per-line filters). See SynapsD.searchCompound for semantics.
    async searchCompound(lines = [], spec = {}, options = {}) {
        const baseSpec = this.#normalizeQuerySpec(this.#composeCanvasQuerySpec(spec));
        delete baseSpec.query; delete baseSpec.search; delete baseSpec.q;
        const opts = { ...options, baseSpec };
        if (opts.maxDistance === undefined) { opts.maxDistance = Workspace.DEFAULT_MAX_COSINE_DISTANCE; }
        return await this.#getActiveDb().searchCompound(lines, opts);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Query sessions (live, delta-emitting views)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Normalize ONE session cue spec the same way list()/search() normalize a
     * read: canvas querySpec folding + context/directory → the ctx:/dir: paths
     * grammar.
     *
     * Cues are the CANDIDATE-SET stage: bitmap algebra (paths, features,
     * filters incl. geo, literal id-sets) that can be cached, AND-ed and
     * precisely invalidated. Text and image relevance are a SCORE, not a
     * membership predicate — they have no bitmap key to invalidate and belong
     * to the ranking stage (see buildMatch + QuerySession.materialize). Any
     * text a canvas leaf folds in is therefore dropped here; the transport
     * rejects caller-supplied text outright rather than silently ignoring it.
     * `limit`/`offset` are paging concerns of the session as a whole (opts),
     * not of a cue, and are dropped too.
     */
    normalizeSessionSpec(spec = {}) {
        const cue = this.#normalizeQuerySpec(this.#composeCanvasQuerySpec(spec));
        delete cue.query; delete cue.search; delete cue.q;
        delete cue.limit; delete cue.offset; delete cue.page;
        delete cue.sortBy; delete cue.order;
        return cue;
    }

    /**
     * Open a long-running, refinable query session over this workspace's db.
     * Cue specs are workspace-normalized (see normalizeSessionSpec); everything
     * else — modes, emit shapes, invalidation — is synapsd's QuerySession.
     *
     * Sessions hold a reference to the live db, so the workspace tracks them and
     * closes them on stop(): a session surviving a shutdown would keep emitting
     * against a torn-down db. The returned session's close() is idempotent and
     * deregisters itself.
     *
     * @param {object|object[]} specs  one spec, an array of specs, or {spec,label}[]
     * @param {object} opts            { mode, emit, combinator, debounceMs, limit, offset }
     */
    async openSession(specs = [], opts = {}) {
        const db = this.#getActiveDb();
        const list = (Array.isArray(specs) ? specs : (specs ? [specs] : []))
            .filter(Boolean)
            .map((entry) => (entry && typeof entry === 'object' && 'spec' in entry)
                ? { label: entry.label, spec: this.normalizeSessionSpec(entry.spec) }
                : this.normalizeSessionSpec(entry));

        const session = await db.openSession(list, opts);
        this.#sessions.add(session);
        const close = session.close.bind(session);
        session.close = () => { this.#sessions.delete(session); close(); };
        return session;
    }

    /**
     * Build a typed match descriptor for the RANKING stage — the second half of
     * a session read, applied over the cue-narrowed candidate set.
     *
     * Text and image fuse: with both, the image rides as a vector leg on
     * synapsd's typed match and RRF-merges with the full text pipeline (FTS +
     * dense + text→image kNN), so "broken door" resurfaces the summarized NOTE
     * about the entrance next to the photos the camera frame matched. Text
     * alone stays a plain string (the classic fts/vector/hybrid path); an image
     * alone is a single kNN leg and keeps its exact distance order.
     *
     * Returns null when there is nothing to rank by — the caller then gets the
     * cheap listing path (bitmap slice, no Lance).
     *
     * @param {object} p
     * @param {string|null}  p.text        free text ("broken door")
     * @param {Buffer|null}  p.imageBytes  EPHEMERAL query image (camera frame) — embedded, never stored
     * @param {string|null}  p.contentType mime for imageBytes
     * @param {number|null}  p.similarTo   reuse an indexed document's stored image vector
     */
    async buildMatch({ text = null, imageBytes = null, contentType = null, similarTo = null, minDistance, maxDistance } = {}) {
        const db = this.#getActiveDb();
        const vectors = [];

        if (imageBytes) {
            if (!this.#inferd) { throw new Error('inferd service not available for image query embedding'); }
            const vector = await this.#inferd.embedImageQuery(this.id, imageBytes, contentType);
            if (!vector) { throw new Error('image query embedding failed (no image-capable provider for this workspace?)'); }
            vectors.push({ space: 'image', vector, minDistance, maxDistance });
        } else if (similarTo != null) {
            const docId = parseDocumentId(similarTo, 'Document ID');
            const vector = await db.getDocumentVector(docId, 'image');
            if (!vector) { throw new Error(`document ${docId} has no image-space vector`); }
            vectors.push({ space: 'image', vector, minDistance, maxDistance });
        }

        const query = typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;
        if (!query && vectors.length === 0) { return null; }
        if (query && vectors.length === 0) { return query; }
        return { text: query, vectors };
    }

    /** Close every session opened against this workspace (called from stop()). */
    #closeSessions() {
        for (const session of [...this.#sessions]) {
            try { session.close(); } catch (err) { this.#logger.debug({ err: err.message }, 'Error closing query session'); }
        }
        this.#sessions.clear();
    }

    /**
     * Search by image over the joint image space. Two query sources:
     *  - imageBytes: an EPHEMERAL query image (camera frame, upload) — embedded
     *    via the inferd service, never stored or indexed;
     *  - similarTo: an already-indexed document id ("more like this") — its
     *    stored vector is reused, no bytes cross any boundary.
     * `spec` is the usual structured scope; results come back best-first in
     * kNN order. No implicit distance floor: a frame query wants its top-K,
     * pass maxDistance to cut noise (same semantics as the text path).
     *
     * Optional `text` switches to FUSED mode: the image becomes a vector leg in
     * synapsd's typed match descriptor and RRF-fuses with the full text
     * pipeline (FTS + dense + text→image kNN) — so the image query resurfaces
     * NOTES ranked by the text, not just photos. Note: fused mode cannot
     * exclude the similarTo self-match (RRF has no excludeIds); callers pair
     * similarTo with text knowing the reference doc may rank first.
     */
    async searchByImage({ imageBytes = null, contentType = null, similarTo = null, text = null, spec = {}, limit, offset, minDistance, maxDistance, debug = false, idsOnly = false } = {}) {
        const db = this.#getActiveDb();
        let vector;
        let excludeIds = [];
        if (imageBytes) {
            if (!this.#inferd) { throw new Error('inferd service not available for image query embedding'); }
            // A text-only backend (e.g. ollama) throws from embedImage — fold it
            // into the error envelope instead of 500ing the route.
            try {
                vector = await this.#inferd.embedImageQuery(this.id, imageBytes, contentType);
            } catch (error) {
                const empty = []; empty.count = 0; empty.totalCount = 0;
                empty.error = `image query embedding failed: ${error.message}`;
                return empty;
            }
            if (!vector) {
                const empty = []; empty.count = 0; empty.totalCount = 0;
                empty.error = 'image query embedding failed (no image-capable provider for this workspace?)';
                return empty;
            }
        } else if (similarTo != null) {
            const docId = parseDocumentId(similarTo, 'Document ID');
            vector = await db.getDocumentVector(docId, 'image');
            if (!vector) {
                const empty = []; empty.count = 0; empty.totalCount = 0;
                empty.error = `document ${docId} has no image-space vector`;
                return empty;
            }
            excludeIds = [docId]; // a doc's nearest neighbour is always itself
        } else {
            throw new Error('searchByImage requires imageBytes or similarTo');
        }
        const querySpec = this.#normalizeQuerySpec(this.#composeCanvasQuerySpec(spec));

        // Fused mode: image rides as a vector leg on the typed match descriptor,
        // RRF-merged with the text legs by synapsd — notes and photos in one page.
        if (typeof text === 'string' && text.trim().length > 0) {
            delete querySpec.query; delete querySpec.search; delete querySpec.q;
            return await db.search({
                ...querySpec,
                query: {
                    text,
                    vectors: [{ space: 'image', vector, minDistance, maxDistance }],
                },
                limit, offset, idsOnly, debug,
                maxDistance: Workspace.DEFAULT_MAX_COSINE_DISTANCE, // text dense leg floor
            });
        }

        return await db.searchByVector(vector, querySpec, {
            space: 'image', limit, offset, minDistance, maxDistance,
            withDistances: !!debug, idsOnly, excludeIds,
        });
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
        // Live canvas filter preview: when the client fully drives the filters
        // (toolbox-on-canvas), it opts out of folding the canvas's STORED
        // querySpec so its edits — including REMOVING a saved filter — take
        // effect. Without this the stored spec is always AND-composed, so
        // loosening a filter would never preview until Save.
        if (spec.applyCanvasQuerySpec === false) { return spec; }
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
        let sort = null;
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
            // A canvas's saved sort is the view's default order; last canvas on
            // the path wins. The caller (request) overrides it when it sends its
            // own sortBy — see the injection guard below.
            if (qs.sort && qs.sort.sortBy) { sort = qs.sort; }
            if (tree.type === Workspace.DIRECTORY_TYPE) {
                nextScope = Workspace.#withCanvasParentPath(nextScope, path);
            }
            touched = true;
        }

        if (!touched) { return spec; }

        const callerHasSort = spec.sortBy !== undefined && spec.sortBy !== null && spec.sortBy !== '';
        return {
            ...spec,
            [scopeKey]: nextScope,
            ...(features !== undefined ? { features } : {}),
            filters,
            ...(query ? { query } : {}),
            ...(sort && !callerHasSort ? { sortBy: sort.sortBy, order: sort.order || spec.order || 'asc' } : {}),
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
        const db = this.#getActiveDb();
        const tree = db.getTree(nameOrId);
        if (!tree) { return; }
        if (tree.settings?.protected === true) {
            throw new Error(`Cannot ${action} reserved tree "${tree.name}"`);
        }
        // Reserved = the canonical instance each structural name resolves to.
        // A stray duplicate carrying a reserved name (leftover from a start
        // race) stays deletable by id — only the tree that name-resolution
        // actually lands on is load-bearing.
        for (const name of [Workspace.CONTEXT_TREE_NAME, Workspace.DIRECTORY_TREE_NAME, Workspace.BACKENDS_TREE_NAME]) {
            if (db.getTree(name)?.id === tree.id) {
                throw new Error(`Cannot ${action} reserved tree "${tree.name}"`);
            }
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
     * Remove a backends-tree folder AND delete the mirrored resources on the
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
     * Does a location URL belong to the backend scope mirrored by a backends-tree
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

    /** Datasets: path-independent ingest provenance (data/dataset/<name>). */
    async listDatasets() {
        return await this.#getActiveDb().listDatasets();
    }

    /**
     * Drop a dataset (its documents too unless dropDocuments:false). This is the
     * ONLY sanctioned way to remove a data/dataset/* bitmap — deleteBitmap
     * refuses the prefix.
     */
    async deleteDataset(name, { dropDocuments = true } = {}) {
        return await this.#getActiveDb().deleteDataset(name, { dropDocuments });
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
        // NOTE: the old rel/* guard is gone with the bitmaps it protected —
        // typed doc<->doc edges live in the dupsort edge plane (synapsd
        // indexes/edges/) since refactor-v3, and 'rel/' is no longer an allowed
        // bitmap prefix, so such a key cannot exist to be deleted.
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

    // Per-backend config + runtime status map — feeds the backend descriptors
    // (#listStorageBackends). Internal since the legacy /services/data-backends
    // routes were retired; clients consume /:id/backends.
    #getDataBackendStatus() {
        const dataBackends = this.dataBackends;
        return Object.fromEntries(Object.entries(dataBackends).map(([name, config]) => {
            const runtime = this.#storedIndex?.getBackendStatus(name) || {};
            return [name, {
                ...config,
                root: Workspace.#resolveWorkspaceRoot(config.root, this.#rootPath),
                running: runtime.running || false,
                watching: runtime.watching || false,
                resyncing: runtime.resyncing === true,
                resyncProgress: runtime.progress || null,
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

    async #resyncDataBackend(backendName, { background = true } = {}) {
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
     * Resync a backend addressed by its backends-tree mirror node path
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
        const state = status.resyncing
            ? 'syncing'
            : (status.lastError ? 'error' : (status.running ? (status.watching ? 'running' : 'idle') : 'stopped'));
        return {
            driver,
            address: name,
            kind: 'storage',
            enabled: status.enabled !== false,
            status: state,
            // Live resync state: clients render a spinner on the mirror node and
            // a progress readout ({scanned, total}) without polling deep status.
            resyncing: status.resyncing === true,
            progress: status.resyncProgress || null,
            // Mirror node in the backends tree (/device/<device>/<mount> for
            // device-scoped mounts) so clients never re-derive path grammar.
            treePath: this.#storedIndex?.getBackendTreeRoot(name) || null,
            lastSyncAt: status.lastScanAt || null,
            lastError: status.lastError || null,
            // Last on-demand disk usage ({bytes, files, computedAt}) if computed
            // this runtime — see getBackendDiskUsage.
            usage: status.diskUsage || null,
            capabilities: this.#backendCapabilities(driver, status),
            config: {
                root: status.root || null,
                // Display name of a user-added mount ("Financial Reports");
                // address stays the slug.
                label: status.label || null,
                // Authoring device snapshot for device-scoped mounts.
                device: status.device || null,
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
        return Object.entries(this.#getDataBackendStatus())
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
        // Storage backends may mirror deeper than /<driver>/<address> (device
        // segment on fs mounts) — ask the index for the canonical node first.
        const path = this.#storedIndex?.getBackendTreeRoot(address)
            || `/${normalizeSegment(driver)}/${normalizeSegment(address)}`;
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
        if (driver === 'fs') driver = 'file'; // UX alias for the local-folder driver
        if (driver === 'file') return this.#addFileBackend(config);
        const name = config.name || config.address;
        if (!name) throw new Error('Storage backend name is required');
        await this.setDataBackendConfig(name, config);
        return this.getBackend(driver, name);
    }

    /**
     * Mount an arbitrary local folder as a file data backend. The mount name
     * ("Financial Reports") is the human handle: its case-preserving slug
     * becomes the backend address (/device/<device>/Financial-Reports in the
     * backends tree); documents carry file://<deviceId>/<abs-path> locations.
     * The display label and the authoring device ({id, name}) are snapshotted
     * on the config so mirror paths stay stable across device renames.
     */
    async #addFileBackend(config = {}) {
        const label = String(config.label || config.name || config.address || '').trim();
        if (!label) throw new Error('Backend name is required (e.g. "Financial Reports")');
        // Case- and unicode-preserving slug: "Fotky" must show as "Fotky" in the
        // tree, not "fotky" (tree layer names keep case, like the home mirror's
        // real folder names). Whitespace/separators collapse to '-'; the slug is
        // the immutable backend address, the raw label stays the display name.
        const name = label.normalize('NFC')
            .replace(/[\s\\/]+/g, '-')
            .replace(/[^\p{L}\p{N}._@-]+/gu, '-')
            .replace(/-+/g, '-')
            .replace(/^-+|-+$/g, '');
        if (!name) throw new Error(`Backend name "${label}" has no usable characters`);
        const collision = Object.keys(this.dataBackends).find((existing) => existing.toLowerCase() === name.toLowerCase());
        if (collision) throw new Error(`Backend "${collision}" already exists`);

        const rawRoot = String(config.root || config.path || '').trim();
        if (!rawRoot) throw new Error('Backend root path is required');
        if (!path.isAbsolute(rawRoot)) throw new Error(`Backend root must be an absolute path: ${rawRoot}`);
        let root;
        try {
            root = await fsPromises.realpath(rawRoot);
        } catch {
            throw new Error(`Backend root does not exist or is not accessible: ${rawRoot}`);
        }
        const stat = await fsPromises.stat(root);
        if (!stat.isDirectory()) throw new Error(`Backend root is not a directory: ${root}`);
        await fsPromises.access(root, fsPromises.constants.R_OK).catch(() => {
            throw new Error(`Backend root is not readable: ${root}`);
        });
        // The workspace root is already covered by the managed backends
        // (workspace:home et al.) — a nested mount would double-index it.
        const workspaceRoot = path.resolve(this.#rootPath);
        if (root === workspaceRoot || root.startsWith(workspaceRoot + path.sep)) {
            throw new Error(`Backend root is inside the workspace root (${workspaceRoot}) — already indexed`);
        }
        for (const [existingName, existing] of Object.entries(this.dataBackends)) {
            if (existing?.driver !== 'file' || !existing.root || existing.root.includes('{WORKSPACE_ROOT}')) continue;
            const existingRoot = path.resolve(existing.root);
            if (root === existingRoot || root.startsWith(existingRoot + path.sep) || existingRoot.startsWith(root + path.sep)) {
                throw new Error(`Backend root overlaps existing backend "${existingName}" (${existingRoot})`);
            }
        }

        const device = getServerDevice();
        const exclude = Array.isArray(config.exclude)
            ? config.exclude.filter((p) => typeof p === 'string' && p.trim())
            : [];
        await this.setDataBackendConfig(name, {
            enabled: true,
            supported: true,
            driver: 'file',
            label,
            root,
            watch: config.watch === true,
            resync: true,
            exclude,
            readOnly: config.readOnly === true,
            // Authoring device snapshot: id is the file:// URL authority for
            // this mount's locations, name the mirror-path device segment.
            device: { id: device.deviceId, name: device.name },
        });
        return this.getBackend('file', name);
    }

    /** On-demand on-disk size of a local storage backend (slow walk — user-triggered). */
    async getBackendDiskUsage(driver, address) {
        if (driver === 'imap') throw new Error('IMAP backends have no local disk usage');
        if (!this.#storedIndex?.isRunning) await this.#startStoredIndex();
        return await this.#storedIndex.getBackendDiskUsage(address);
    }

    /**
     * On-demand on-disk size of the WHOLE workspace root with a per-top-level
     * directory breakdown (db, data, home, cache, …) — the number an export or
     * sync needs to plan around. Total is measured on the root in one pass
     * (hardlink/inode-aware via get-folder-size); the breakdown is per subtree,
     * so cross-directory hardlinks can make its sum slightly exceed the total.
     */
    async getDiskUsage() {
        const root = this.#rootPath;
        const [bytes, entries] = await Promise.all([
            getFolderSize.loose(root),
            fsPromises.readdir(root, { withFileTypes: true }).catch(() => []),
        ]);
        const breakdown = {};
        for (const entry of entries) {
            const target = path.join(root, entry.name);
            breakdown[entry.name] = entry.isDirectory()
                ? await getFolderSize.loose(target)
                : ((await fsPromises.stat(target).catch(() => null))?.size ?? 0);
        }
        return { workspaceId: this.id, bytes, breakdown, computedAt: new Date().toISOString() };
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
        if ('exclude' in patch) {
            if (!Array.isArray(patch.exclude) || patch.exclude.some((p) => typeof p !== 'string')) {
                throw new Error('exclude must be an array of glob pattern strings');
            }
            patch = { ...patch, exclude: patch.exclude.map((p) => p.trim()).filter(Boolean).slice(0, 200) };
        }
        await this.setDataBackendConfig(address, patch);
        // Toggling the home backend drives the stored-index lifecycle: enabling
        // it must boot the index when it isn't running (setDataBackendConfig
        // only applies config to an already-running index), disabling stops it.
        if (address === WorkspaceStoredIndex.HOME_STORED_BACKEND && typeof patch.enabled === 'boolean') {
            if (patch.enabled) await this.#startStoredIndex();
            else await this.#stopStoredIndex();
        }
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
        // Disable first either way — it stops the watcher, unregisters the live
        // backend and releases the mirror-node enable-lock.
        const existing = this.dataBackends[address];
        await this.setDataBackendConfig(address, { enabled: false });
        if (existing && existing.managed !== true && !(address in WORKSPACE_STORAGE_BACKENDS)) {
            // User-added mount: drop the config entirely. Mirrored docs keep
            // their tree nodes until purged via tree-rm or swept as
            // dead-backend locations on the next resync.
            const dataBackends = this.dataBackends;
            delete dataBackends[address];
            this.#writeStoredBackends(dataBackends);
            this.emit('dataBackends.changed', { backend: address, config: null });
        }
        return true;
    }

    /**
     * Resync a backend. Storage resyncs run in the background by default (a full
     * scan of a large mount is slow, and progress is reported via the backend
     * status); pass `{ background: false }` to await the reconcile — what a
     * caller that needs to act on the result wants.
     */
    async syncBackend(driver, address, { background = true } = {}) {
        if (driver === 'imap') return (await this.#mail()).resyncAccount(address);
        // Storage: address is the backend name / config key verbatim
        // (workspace:home, or a user mount's case-preserving slug).
        return this.#resyncDataBackend(address, { background });
    }

    // Cancel an in-flight storage resync. The walk stops at the next file;
    // nothing is orphaned from the partial snapshot and a later sync resumes
    // via the checksum cache (see WorkspaceStoredIndex.cancelResync).
    async cancelSyncBackend(driver, address) {
        if (driver === 'imap') throw new Error('IMAP sync does not support cancellation');
        if (!this.#storedIndex?.isRunning) return { backend: address, resyncing: false, cancelled: false };
        return this.#storedIndex.cancelResync(address);
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
            // locked backends-tree root, so mirror the move as remove-old +
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
            storedRootPath: this.storedRootPath,
            dataBackends: this.dataBackends,
            // Never index ourselves: any of the workspace's own runtime dirs
            // that happens to live inside an indexed backend root is excluded
            // structurally. Load-bearing for the `home` layout (home backend
            // root == workspace root), harmless for `full`.
            internalPaths: this.internalPaths,
            workspaceId: this.id,
            // This server's device identity — authority for the device-scoped
            // file:// locations of external fs mounts.
            device: getServerDevice(),
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
            // Skeleton mirroring: bare directory nodes under the backend's
            // mirror root (documents insert their own paths as they stream in).
            insertBackendPath: (treePath) => this.getBackendsTree().insertPath(treePath, { ignoreLocks: true }),
            // Resync lifecycle/progress → ws clients (tree spinner, settings).
            onResyncStateChange: (state) => this.emit('backend.resync.changed', { ...state, workspaceId: this.id }),
            // Quiet config persist (mount fsid snapshot on first successful
            // liveness check) — must NOT re-enter applyBackendConfig.
            persistBackendConfig: (name, patch) => {
                const dataBackends = this.dataBackends;
                dataBackends[name] = { ...dataBackends[name], ...patch };
                this.#writeStoredBackends(dataBackends);
            },
            // Orphan-GC retention (Settings > Database), -1 = keep forever.
            getOrphanRetentionDays: () => Number(this.databaseSettings.orphanRetentionDays ?? -1),
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
