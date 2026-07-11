'use strict';

import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import Stored from '../../../services/stored/src/index.js';
import { extract as extractBlobMetadata } from '../../../services/stored/src/extractors/index.js';
import { parseLocationUrl } from '../../../services/synapsd/src/utils/path-helpers.js';
import { mimeFromLocations } from './classifier.js';
import { BACKENDS_TREE_NAME, legacyBitmapKey } from '../../../utils/backend-documents.js';
import { DEFAULT_SYNC_EXCLUSIONS } from './constants.js';

/*
 * WorkspaceStoredIndex — watches a workspace home directory and syncs file
 * metadata into the workspace DB as backend mirrors in the dedicated backends
 * tree (/<driver>/<address>/<source-dirs>).
 *
 * Fully decoupled from Workspace: takes explicit dependencies so it can be
 * instantiated standalone in any bun/node runtime.
 *
 * Blob/file indexing only. IMAP/email ingestion + mailbox management live in
 * the per-workspace mail service (services/imap). This index owns the shared
 * Stored instance and orchestrates the cross-scheme resolve/destroy/describe
 * paths; imap:// byte-ops are delegated to the mail service via the injected
 * describeImapLocation/destroyImapLocation callbacks.
 */

const HOME_STORED_BACKEND = 'workspace:home';
const HOME_BACKEND_FEATURE = 'data/backend/home';
const CACHE_BACKEND = 'stored.cache';
// The default local content-addressable blob store. Connectors persist blobs
// here (persistBlob) and address them by stored://workspace:data/<key>.
const DATA_BLOB_BACKEND = 'workspace:data';
const DATA_BLOB_FEATURE = 'data/backend/data';
// Local drivers whose bytes are written in-process (no remote SyncQueue): they
// are registered eagerly and toggled live by config.
const LOCAL_DRIVERS = new Set(['file', 'cacache']);
const CHECKSUM_PRIORITY = ['sha256', 'sha1', 'md5'];

export class WorkspaceStoredIndex {
    static HOME_STORED_BACKEND = HOME_STORED_BACKEND;
    static HOME_BACKEND_FEATURE = HOME_BACKEND_FEATURE;
    static CACHE_BACKEND = CACHE_BACKEND;
    static DATA_BLOB_BACKEND = DATA_BLOB_BACKEND;

    #rootPath;
    #cachePath;
    #dataPath;
    #homePath;
    #dataBackends;
    #workspaceId;
    #logger;

    // Injected workspace operations
    #put;
    #unlink;
    #getBackendsTreeSelector;
    #getDb;
    // Optional backend-node enable-lock hooks (lock /<driver>/<addr> in the backends tree
    // while the backend is enabled; see Workspace.lockBackendTreeNode).
    #lockBackendNode;
    #unlockBackendNode;
    // imap:// byte-ops are delegated to the mail service (the blob indexer is
    // the Destroy orchestrator but does not own the imap protocol).
    #describeImapLocation;
    #destroyImapLocation;

    #stored = null;
    #listeners = [];
    #backendStatus = new Map();
    #resyncing = new Set();

    constructor({ rootPath, cachePath, dataPath, homePath, dataBackends = {}, workspaceId, logger, put, unlink, getBackendsTreeSelector, getDb, describeImapLocation = null, destroyImapLocation = null, lockBackendNode = null, unlockBackendNode = null }) {
        if (!dataPath || !homePath) throw new Error('dataPath and homePath are required');
        if (!put || !unlink || !getBackendsTreeSelector || !getDb) throw new Error('put, unlink, getBackendsTreeSelector, getDb are required');

        this.#rootPath = rootPath || path.dirname(dataPath);
        this.#cachePath = cachePath || path.join(this.#rootPath, 'cache');
        this.#dataPath = dataPath;
        this.#homePath = homePath;
        this.#dataBackends = dataBackends;
        this.#workspaceId = workspaceId;
        this.#logger = logger || console;
        this.#put = put;
        this.#unlink = unlink;
        this.#getBackendsTreeSelector = getBackendsTreeSelector;
        this.#getDb = getDb;
        this.#describeImapLocation = describeImapLocation;
        this.#destroyImapLocation = destroyImapLocation;
        this.#lockBackendNode = lockBackendNode;
        this.#unlockBackendNode = unlockBackendNode;
    }

    get isRunning() {
        return this.#stored !== null;
    }

    // Shared Stored instance — consumed by the per-workspace mail service to
    // register/run imap backends and bind their object:* events.
    get stored() {
        return this.#stored;
    }

    getBackendStatus(backendName) {
        const backend = this.#stored?.getBackend(backendName);
        const status = this.#backendStatus.get(backendName) || {};
        return {
            ...status,
            running: backendName === CACHE_BACKEND ? this.isRunning : !!backend,
            watching: backend?.watching || false,
        };
    }

    async start() {
        if (this.#stored) return;

        try {
            this.#stored = new Stored({
                root: path.join(this.#rootPath, '.stored'),
                checksums: ['sha256'],
                primaryChecksum: 'sha256',
                // Inline metadata extraction at ingest (EXIF/GPS/dimensions/media).
                // Graceful + optional: no-ops if parser deps are absent. Disable
                // with CANVAS_EXTRACT_DISABLED=true.
                extract: process.env.CANVAS_EXTRACT_DISABLED === 'true' ? null : extractBlobMetadata,
            });

            await this.#registerConfiguredBackends();

            this.#bindEvents();
            // No full resync on start: the synapsd document index is durable
            // across restarts and the file watcher (ignoreInitial) picks up live
            // changes. Reconciling drift (files changed while the server was
            // down, or a remote/large backend) is an explicit, user-triggered
            // operation via resyncDataBackend() — a potentially slow scan that
            // must not block workspace/server startup.
        } catch (error) {
            this.#logger.warn({ workspaceId: this.#workspaceId, error: error.message }, 'Stored home indexing unavailable');
            await this.stop();
        }
    }

    async stop() {
        this.#unbindEvents();
        if (!this.#stored) return;

        try {
            await this.#stored.stop();
        } catch (error) {
            this.#logger.warn({ workspaceId: this.#workspaceId, error: error.message }, 'Failed to stop stored home indexing');
        } finally {
            this.#stored = null;
            this.#backendStatus.clear();
        }
    }

    #assertResyncable(backendName) {
        if (!this.#stored) throw new Error('WorkspaceStoredIndex is not running');
        const config = this.#dataBackends[backendName];
        if (!config?.enabled) throw new Error(`Data backend "${backendName}" is disabled`);
        if (!config?.resync) throw new Error(`Data backend "${backendName}" does not support resync`);
        if (!this.#stored.getBackend(backendName)) throw new Error(`Data backend "${backendName}" is not registered`);
    }

    // ── Container (folder) mutation on a writable file backend ────────────────
    // The backend does the fs op; the Workspace facade updates the tree mirror.
    // The mirror tree root for a backend (/<driver>/<address> in the backends tree).
    getBackendTreeRoot(backendName) {
        return this.#getBackendRootPath(backendName);
    }

    #mutableFileBackend(backendName) {
        const config = this.#dataBackends[backendName];
        if (!config) throw new Error(`Unknown data backend: ${backendName}`);
        if (config.driver !== 'file') throw new Error(`Backend "${backendName}" has no mutable folders`);
        if (config.readOnly === true) throw new Error(`Backend "${backendName}" is read-only`);
        if (!this.#stored) throw new Error('WorkspaceStoredIndex is not running');
        const backend = this.#stored.getBackend(backendName);
        if (!backend) throw new Error(`Data backend "${backendName}" is not registered`);
        return backend;
    }

    async createBackendContainer(backendName, key) {
        return this.#mutableFileBackend(backendName).createContainer(key);
    }

    async deleteBackendContainer(backendName, key) {
        return this.#mutableFileBackend(backendName).deleteContainer(key);
    }

    async renameBackendContainer(backendName, fromKey, toKey) {
        return this.#mutableFileBackend(backendName).renameContainer(fromKey, toKey);
    }

    /**
     * Launch a resync without blocking the caller. Validation errors are thrown
     * synchronously; the (potentially slow) scan runs in the background and its
     * outcome is recorded in the backend status (queryable via getBackendStatus).
     */
    resyncInBackground(backendName = HOME_STORED_BACKEND) {
        this.#assertResyncable(backendName);
        if (this.#resyncing.has(backendName)) {
            return { backend: backendName, started: false, alreadyRunning: true };
        }
        this.resync(backendName).catch((error) => {
            this.#setBackendError(backendName, error);
            this.#logger.warn({ workspaceId: this.#workspaceId, backend: backendName, error: error.message }, 'Background resync failed');
        });
        return { backend: backendName, started: true, resyncing: true };
    }

    async resync(backendName = HOME_STORED_BACKEND) {
        this.#assertResyncable(backendName);

        // Re-entrancy guard: a resync of the same backend already in flight must
        // not be duplicated (the scan is expensive and writes are not idempotent
        // under concurrency).
        if (this.#resyncing.has(backendName)) {
            return { backend: backendName, count: null, alreadyRunning: true };
        }
        this.#resyncing.add(backendName);
        this.#backendStatus.set(backendName, {
            ...(this.#backendStatus.get(backendName) || {}),
            resyncing: true,
            resyncStartedAt: new Date().toISOString(),
        });

        try {
            const { files = [] } = await this.#stored.scan(backendName);
            for (const file of files) {
                await this.#upsertDocument(file);
            }
            await this.#purgeOrphanedPaths(backendName, files);
            // Global stale-local-path cleanup: drop locations whose backend was
            // renamed/removed (dead-backend refs like the legacy fs:home). Gated to
            // the home resync so the all-file-docs scan runs once, not per backend.
            if (backendName === HOME_STORED_BACKEND) {
                await this.#purgeDeadBackendLocations().catch((error) =>
                    this.#logger.warn({ workspaceId: this.#workspaceId, error: error.message }, 'Dead-backend location purge failed'));
            }
            this.#backendStatus.set(backendName, {
                ...(this.#backendStatus.get(backendName) || {}),
                lastScanAt: new Date().toISOString(),
                lastError: null,
                fileCount: files.length,
            });
            return { backend: backendName, count: files.length };
        } finally {
            this.#resyncing.delete(backendName);
            this.#backendStatus.set(backendName, {
                ...(this.#backendStatus.get(backendName) || {}),
                resyncing: false,
            });
        }
    }

    /**
     * Persist a blob into the local content-addressable data store
     * (workspace:data). The connector seam for non-file sources (mail, future
     * offline-website download, …): dump bytes, get back a resolvable
     * stored://workspace:data/<key> URL — keys are checksum-derived and deduped;
     * on-disk layout is opaque (the synapsd tree is the navigation).
     *
     * @param {Buffer|string} blob
     * @returns {Promise<{ url: string, key: string, checksum: string|null, size: number }>}
     */
    async persistBlob(blob) {
        if (!this.#stored) throw new Error('WorkspaceStoredIndex is not running');
        const res = await this.#stored.put(blob, { backends: [DATA_BLOB_BACKEND] });
        if (!res?.ok) throw new Error(`Blob persist failed: ${res?.reason || 'unknown'}`);
        return {
            url: `stored://${DATA_BLOB_BACKEND}/${res.key}`,
            key: res.key,
            checksum: res.checksums?.sha256 || null,
            size: res.size,
            mimeType: res.mimeType || null,
            // Inline-extracted EXIF/GPS/dimensions/media (may be {}). The caller
            // (blob-upload route → CLI) merges this onto the File document.
            metadata: res.custom && Object.keys(res.custom).length ? res.custom : undefined,
        };
    }

    /**
     * Apply a data-backend config change to the running stored runtime. Lets
     * the UI flip `enabled` / `watch` without a workspace restart.
     *   - enabled: register & start (and resync if supported) / unregister
     *   - watch: start/stop chokidar on the live backend
     * Other fields just update the cached config (read by #getBackendRootPath
     * et al.) and take effect on the next event.
     */
    async applyBackendConfig(name, fullConfig = {}, patch = {}) {
        if (!this.#stored) return;
        this.#dataBackends = { ...this.#dataBackends, [name]: fullConfig };

        if (name === CACHE_BACKEND) return;

        const isLocal = LOCAL_DRIVERS.has(fullConfig.driver) && fullConfig.supported !== false;

        if ('enabled' in patch) {
            const live = this.#stored.getBackend(name);
            if (patch.enabled && !live && isLocal) {
                this.#stored.addBackend(name, this.#backendRegistrationConfig(name, fullConfig));
                this.#backendStatus.set(name, { lastScanAt: null, lastError: null });
                await this.#applyBackendNodeLock(name, true);
                if (fullConfig.resync) {
                    await this.resync(name).catch((err) => this.#setBackendError(name, err));
                }
            } else if (!patch.enabled && live) {
                await live.stop?.().catch(() => {});
                this.#stored.removeBackend?.(name);
                this.#backendStatus.delete(name);
                await this.#applyBackendNodeLock(name, false);
            }
        }

        if ('watch' in patch) {
            const live = this.#stored.getBackend(name);
            if (live) {
                if (patch.watch && !live.watching) {
                    await live.watch?.();
                    // Catch up on anything that landed while watch was off
                    if (fullConfig.resync) {
                        await this.resync(name).catch((err) => this.#setBackendError(name, err));
                    }
                } else if (!patch.watch && live.watching) {
                    await live.stop?.();
                }
            }
        }

        // New exclusion patterns require rebuilding the backend's matcher
        // (chokidar + list/scan share it): re-register the live backend. A
        // follow-up resync applies exclusions retroactively (unlink-only).
        if ('exclude' in patch) {
            const live = this.#stored.getBackend(name);
            if (live && isLocal && fullConfig.enabled) {
                await live.stop?.().catch(() => {});
                this.#stored.removeBackend?.(name);
                this.#stored.addBackend(name, this.#backendRegistrationConfig(name, fullConfig));
            }
        }
    }

    async #registerConfiguredBackends() {
        for (const [backendName, config] of Object.entries(this.#dataBackends || {})) {
            if (!config?.enabled || config.supported === false || !LOCAL_DRIVERS.has(config.driver)) continue;
            if (backendName === CACHE_BACKEND) continue;

            this.#stored.addBackend(backendName, this.#backendRegistrationConfig(backendName, config));
            this.#backendStatus.set(backendName, { lastScanAt: null, lastError: null });
            await this.#applyBackendNodeLock(backendName, true);
            await this.#migrateLegacyBackendBitmap(backendName);
        }
    }

    // Shared registration config: resolved root + effective exclusions (defaults
    // ∪ per-backend user patterns) wired into the driver's shared ignore matcher.
    #backendRegistrationConfig(backendName, config = {}) {
        return {
            ...config,
            root: this.#resolveBackendRoot(backendName, config),
            ignored: this.#effectiveExclusions(config),
            provider: config.provider || 'fs',
            account: config.account || 'workspace',
            container: config.container || (backendName === HOME_STORED_BACKEND ? 'home' : 'data'),
        };
    }

    #effectiveExclusions(config = {}) {
        if (config.driver !== 'file') return undefined;
        const user = Array.isArray(config.exclude) ? config.exclude.filter((p) => typeof p === 'string' && p.trim()) : [];
        return [...DEFAULT_SYNC_EXCLUSIONS, ...user];
    }

    /** Effective exclusion patterns for a backend (defaults + user), for the API. */
    getEffectiveExclusions(backendName) {
        const config = this.#dataBackends[backendName];
        return config ? (this.#effectiveExclusions(config) ?? []) : [];
    }

    // Bitmap keys squashed ':' (and '@') to '_' before synapsd widened its
    // allowed charset — data/backend/workspace:home lived as
    // data/backend/workspace_home. Merge the legacy bitmap into the canonical
    // key; idempotent no-op once migrated.
    async #migrateLegacyBackendBitmap(backendName) {
        const db = this.#getDb?.();
        if (typeof db?.migrateBitmapKey !== 'function') return;
        const tag = `data/backend/${backendName}`;
        try {
            await db.migrateBitmapKey(legacyBitmapKey(tag), tag);
        } catch (error) {
            this.#logger.warn({ workspaceId: this.#workspaceId, backend: backendName, error: error.message }, 'Legacy backend bitmap key migration failed');
        }
    }

    #isConfiguredLocalBackend(backendName) {
        const config = this.#dataBackends[backendName];
        return !!config && config.supported !== false && LOCAL_DRIVERS.has(config.driver);
    }

    /**
     * Resolve a backend for byte-level ops (delete). A disabled-but-configured
     * LOCAL backend is registered transiently: the enable-lock forbids
     * destroying an active backend's whole subtree, so "disable, then destroy"
     * is the designed flow — the bytes must still be reachable afterwards.
     */
    #ensureByteOpsBackend(backendName) {
        const live = this.#stored.getBackend(backendName);
        if (live) return { backend: live, transient: false };
        if (!this.#isConfiguredLocalBackend(backendName)) return { backend: null, transient: false };
        const config = this.#dataBackends[backendName];
        this.#stored.addBackend(backendName, {
            ...this.#backendRegistrationConfig(backendName, config),
            // Byte-ops only — never start a watcher on a transiently-registered
            // (disabled) backend.
            watch: false,
        });
        return { backend: this.#stored.getBackend(backendName), transient: true };
    }

    /**
     * Delete the bytes behind a single stored:// URL (blob-cascade seam for
     * plain index-deletes of managed-store-only documents). Refuses read-only
     * and unknown backends; registers a disabled local backend transiently.
     */
    async deleteStoredUrl(url) {
        if (!this.#stored) throw new Error('WorkspaceStoredIndex is not running');
        const parsed = parseLocationUrl(url);
        if (parsed?.scheme !== 'stored') throw new Error(`Not a stored:// URL: ${url}`);
        const { backend, transient } = this.#ensureByteOpsBackend(parsed.backend);
        try {
            if (!backend || !backend.canDelete || this.#dataBackends[parsed.backend]?.readOnly === true) {
                return { ok: false, reason: 'backend is read-only or not configured' };
            }
            return await this.#stored.deleteByUrl(url);
        } finally {
            if (transient) this.#stored.removeBackend?.(parsed.backend);
        }
    }

    // Enable-lock: while a backend is enabled its /<driver>/<address> mirror
    // node in the backends tree is structurally locked (can't be removed/
    // renamed). Released on disable/remove — NOT on stop() (the config still
    // says enabled).
    async #applyBackendNodeLock(backendName, enabled) {
        const root = this.#getBackendRootPath(backendName);
        if (!root) return;
        const hook = enabled ? this.#lockBackendNode : this.#unlockBackendNode;
        if (!hook) return;
        await Promise.resolve(hook(root, backendName)).catch((err) =>
            this.#logger.warn({ workspaceId: this.#workspaceId, backend: backendName, error: err.message }, 'Backend node lock update failed'));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Event binding
    // ─────────────────────────────────────────────────────────────────────────

    #bindEvents() {
        this.#unbindEvents();
        if (!this.#stored?.on) return;

        // Generic object:* events from all backends; this index handles file
        // objects only — imap messages (kind:'message') + backend:state are
        // consumed by the mail service, which binds its own listeners.
        const dispatch = (payload) => {
            if (payload?.kind === 'message') return; // handled by the mail service
            return this.#upsertDocument(payload); // kind 'file' (or legacy)
        };
        const eventMap = {
            'object:add': dispatch,
            'object:change': dispatch,
            'object:unlink': (payload) => this.#unlinkDocument(payload),
        };

        this.#listeners = Object.entries(eventMap).map(([eventName, handler]) => {
            const listener = async (payload = {}) => {
                try {
                    await handler(payload);
                } catch (error) {
                    this.#logger.warn({ workspaceId: this.#workspaceId, eventName, error: error.message }, 'Stored file sync failed');
                }
            };
            this.#stored.on(eventName, listener);
            return { eventName, listener };
        });
    }

    #unbindEvents() {
        if (!this.#stored?.off) {
            this.#listeners = [];
            return;
        }
        for (const { eventName, listener } of this.#listeners) {
            this.#stored.off(eventName, listener);
        }
        this.#listeners = [];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sync
    // ─────────────────────────────────────────────────────────────────────────

    async #purgeOrphanedPaths(backendName, presentFiles = []) {
        const db = this.#getDb();
        const presentChecksums = new Set(
            presentFiles.flatMap((f) => this.#buildChecksumArray(f.checksums))
        );

        const backendRoot = this.#getBackendRootPath(backendName);
        if (!backendRoot) return;
        const treeSelector = this.#getBackendsTreeSelector(backendRoot);
        const docsInTree = await db.list({ directory: treeSelector }).catch(() => []);

        for (const doc of docsInTree) {
            const primaryChecksum = doc.checksumArray?.[0];
            if (!primaryChecksum || presentChecksums.has(primaryChecksum)) continue;

            // Gone from this backend — drop its locations; the helper purges the
            // doc if nothing else holds the content, else keeps it on survivors.
            const removedUrls = (doc.locations || [])
                .filter((l) => parseLocationUrl(l.url)?.backend === backendName)
                .map((l) => l.url);
            await this.#reconcileRemovedLocations(doc, removedUrls);
        }
    }

    /**
     * Remove locations that point at a backend which no longer exists in config —
     * e.g. a renamed/removed local backend (the legacy `fs:home`, now
     * `workspace:home`). Per-backend orphan purge (#purgeOrphanedPaths) only ever
     * visits LIVE backends, so a doc referencing ONLY a dead backend is never
     * swept — its stale local paths linger and get fed to consumers (the embedder
     * skipped such a `fs:home` .jpg). This global sweep catches them.
     *
     * Safety: only local-grammar URLs are considered — `stored://` (authority IS
     * the backend) and `file://` (authority is a path placeholder, so we trust the
     * explicit metadata.backend). Remote copies (s3://, imap://, http://) are left
     * untouched. A backend that is merely DISABLED keeps its config, so
     * #isConfiguredLocalBackend stays true and its paths are preserved — only a
     * fully-removed backend (config gone) is treated as dead. If a doc loses its
     * last location, #reconcileRemovedLocations purges the doc.
     */
    async #purgeDeadBackendLocations() {
        const db = this.#getDb();
        const fileDocs = await db.list({ features: { allOf: ['data/abstraction/file'] } }).catch(() => []);
        let swept = 0;
        for (const doc of fileDocs) {
            if (!Array.isArray(doc.locations) || doc.locations.length === 0) { continue; }
            const deadUrls = [];
            for (const loc of doc.locations) {
                const parsed = parseLocationUrl(loc.url);
                if (!parsed) { continue; }
                let backend = null;
                if (parsed.scheme === 'stored') { backend = parsed.backend; }
                else if (parsed.scheme === 'file') { backend = loc.metadata?.backend || null; }
                else { continue; } // remote scheme — not a local path, leave alone
                if (backend && !this.#isConfiguredLocalBackend(backend)) { deadUrls.push(loc.url); }
            }
            if (deadUrls.length > 0) {
                await this.#reconcileRemovedLocations(doc, deadUrls);
                swept++;
            }
        }
        if (swept > 0) {
            this.#logger.info({ workspaceId: this.#workspaceId, docs: swept }, 'Resync: purged dead-backend locations');
        }
        return swept;
    }

    async #upsertDocument(storedFile = {}) {
        const checksumArray = this.#buildChecksumArray(storedFile.checksums);
        if (checksumArray.length === 0) return null;

        const meta = await this.#getMeta(storedFile);
        // Prefer Stored's canonical location list (single source of truth for the
        // stored:// grammar + native URLs); fall back to local synthesis only for
        // not-yet-indexed inputs.
        let backends = this.#resolveLocations(storedFile, meta, true);
        if (meta?.id) {
            const canonical = await this.#stored.locations(meta.id);
            if (canonical.length) backends = canonical;
        }
        const backendPaths = this.#buildBackendPaths(backends);
        if (backendPaths.length === 0) return null;

        const db = this.#getDb();
        const primaryChecksum = checksumArray[0];
        const existingDocument = await db.getByChecksumString(primaryChecksum).catch(() => null);
        const documentData = this.#buildDocument(storedFile, checksumArray, backends, existingDocument, meta);
        const features = this.#buildFeatures(backends);
        // Stale-path cleanup is scoped to the backends tree: user-filed
        // placements live in other trees and must never be unlinked here.
        const currentBackendPaths = existingDocument?.id
            ? await db.listDocumentTreePaths(existingDocument.id, BACKENDS_TREE_NAME).catch(() => [])
            : [];

        const docId = await this.#put(
            existingDocument?.id ? { ...documentData, id: existingDocument.id } : documentData,
            // context:null keeps backend mirrors out of the context root — they
            // surface there only when a user files them explicitly.
            { context: null, directory: this.#getBackendsTreeSelector(backendPaths), features },
        );

        await this.#removeStalePaths(docId, currentBackendPaths, backendPaths);
        return docId;
    }

    async #unlinkDocument(storedFile = {}) {
        const checksumArray = this.#buildChecksumArray(storedFile.checksums);
        if (checksumArray.length === 0) return null;
        if (!storedFile.backend || !storedFile.key) return null;

        const db = this.#getDb();
        const existingDocument = await db.getByChecksumString(checksumArray[0]).catch(() => null);
        if (!existingDocument?.id) return null;

        return this.#reconcileRemovedLocations(existingDocument, [`stored://${storedFile.backend}/${storedFile.key}`]);
    }

    /**
     * A backing blob vanished from one or more locations. Drop those locations;
     * if none survive, the doc has no retrievable content → purge it from the DB
     * (cascades unlink from every tree). Otherwise keep it on its survivors and
     * untick only the /.backends path(s) the dead locations backed.
     */
    async #reconcileRemovedLocations(doc, removedUrls = []) {
        const db = this.#getDb();
        const removed = new Set(removedUrls);
        const remaining = (Array.isArray(doc.locations) ? doc.locations : []).filter((l) => !removed.has(l.url));

        if (remaining.length === 0) {
            await db.delete(doc.id);
            return null;
        }

        const survivors = remaining
            .map((l) => parseLocationUrl(l.url))
            .filter(Boolean)
            .map((p) => ({ backend: p.backend, key: p.key }));
        const currentBackendPaths = await db.listDocumentTreePaths(doc.id, BACKENDS_TREE_NAME).catch(() => []);

        await this.#put({ id: doc.id, locations: remaining }, { context: null });
        await this.#removeStalePaths(doc.id, currentBackendPaths, this.#buildBackendPaths(survivors));
        return doc.id;
    }

    async #removeStalePaths(docId, currentPaths = [], nextPaths = []) {
        const stalePaths = currentPaths.filter((p) => !nextPaths.includes(p));
        for (const directory of stalePaths) {
            await this.#unlink(docId, { directory: this.#getBackendsTreeSelector(directory) });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Builders
    // ─────────────────────────────────────────────────────────────────────────

    async #getMeta(storedFile = {}) {
        if (!this.#stored) return null;
        if (storedFile.id && await this.#stored.has(storedFile.id)) return this.#stored.stat(storedFile.id);
        if (storedFile.backend && storedFile.key) return this.#stored.stat(`${storedFile.backend}:${storedFile.key}`);
        return null;
    }

    #resolveLocations(storedFile = {}, meta = null, allowFallback = true) {
        if (Array.isArray(storedFile.locations) && storedFile.locations.length > 0) return storedFile.locations;
        if (Array.isArray(meta?.locations) && meta.locations.length > 0) return meta.locations;
        return allowFallback && storedFile.backend && storedFile.key
            ? [this.#buildLocation(storedFile.backend, storedFile.key)]
            : [];
    }

    /**
     * Resolve a `locations[].url` to its bytes (Buffer, or a stream with
     * { stream: true }). Single entry point for the unified URL grammar.
     *
     *   stored://<backend>/<key>      → Stored backend (data backends are
     *                                   registered on demand)
     *   file://{WORKSPACE_ROOT}/<p>   → workspace FS (substitutes rootPath)
     *   file://<deviceId>/<p>         → NOT IMPLEMENTED (device-proxy stub)
     *
     * @param {string} url
     * @param {{stream?: boolean}} [options]
     * @returns {Promise<Buffer|ReadStream|null>}
     */
    async resolve(url, options = {}) {
        const parsed = parseLocationUrl(url);
        if (!parsed) throw new Error(`Unparseable location URL: ${url}`);
        const { scheme, backend, key } = parsed;

        if (scheme === 'stored') {
            if (!this.#stored) throw new Error('WorkspaceStoredIndex is not running');
            return options.stream ? this.#stored.getStreamByUrl(url) : this.#stored.getByUrl(url);
        }

        if (scheme === 'file') {
            if (backend === '{WORKSPACE_ROOT}') {
                const root = path.resolve(this.#rootPath);
                const abs = path.resolve(root, key);
                // Keys come from stored URLs; a crafted '..' key must never
                // escape the workspace root.
                if (abs !== root && !abs.startsWith(root + path.sep)) {
                    throw new Error(`Location escapes workspace root: ${url}`);
                }
                return options.stream ? createReadStream(abs) : fs.readFile(abs);
            }
            throw new Error(`Device-proxy resolution not implemented for ${url}`);
        }

        throw new Error(`No resolver for scheme: ${scheme}`);
    }

    // Allowed thumbnail edge sizes — a fixed set keeps the derived-artifact
    // cache bounded (no per-pixel-size explosion).
    static THUMBNAIL_SIZES = [128, 256, 512, 1024];

    /**
     * On-demand thumbnail for an image document, cached in the stored.cache
     * cacache store keyed `thumb:<checksum>:<size>` — derived artifacts never
     * touch the main index and the cache is purgeable at any time.
     * @param {object} doc image File document (metadata.contentType image/*)
     * @param {number} [size] longest-edge px, clamped to THUMBNAIL_SIZES
     * @returns {Promise<{buffer: Buffer, mime: string}|null>} null when not an
     *   image / no checksum / no reachable bytes
     */
    async getThumbnail(doc, size = 256) {
        if (!this.#stored) throw new Error('WorkspaceStoredIndex is not running');
        const contentType = String(doc?.metadata?.contentType || '');
        if (!contentType.startsWith('image/')) return null;
        const checksum = Array.isArray(doc?.checksumArray) ? doc.checksumArray[0] : null;
        if (!checksum) return null;

        const edge = WorkspaceStoredIndex.THUMBNAIL_SIZES.reduce(
            (best, s) => (Math.abs(s - size) < Math.abs(best - size) ? s : best),
            WorkspaceStoredIndex.THUMBNAIL_SIZES[0],
        );
        const cacheKey = `thumb:${checksum}:${edge}`;
        const cache = this.#stored.cache;

        const hit = await cache.get(cacheKey).catch(() => null);
        if (hit?.data) return { buffer: hit.data, mime: 'image/webp' };

        // Miss → resolve original bytes from the first reachable location.
        let original = null;
        for (const loc of (doc.locations || [])) {
            if (!loc?.url) continue;
            try { original = await this.resolve(loc.url); if (original) break; } catch { /* next */ }
        }
        if (!original) return null;

        const { default: sharp } = await import('sharp');
        const buffer = await sharp(original)
            .rotate() // honor EXIF orientation
            .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
        await cache.put(cacheKey, buffer, { source: checksum, size: edge }).catch((err) =>
            this.#logger.warn({ workspaceId: this.#workspaceId, error: err.message }, 'Thumbnail cache write failed'));
        return { buffer, mime: 'image/webp' };
    }

    /**
     * Describe each of a document's locations for a Destroy picker: whether its
     * bytes can actually be removed (RW backend / workspace file) or only its
     * reference dropped (read-only http, unregistered/foreign backends).
     * @returns {Promise<Array<{url, scheme, backend, kind, deletable}>>}
     */
    async describeLocations(doc) {
        const out = [];
        for (const loc of (doc?.locations || [])) {
            const p = parseLocationUrl(loc?.url);
            let kind = p?.scheme || 'unknown';
            let deletable = false;
            if (p?.scheme === 'stored') {
                const be = this.#stored ? this.#stored.getBackend(p.backend) : null;
                kind = 'stored';
                // Config-level readOnly overrides the driver capability: the
                // backend CAN delete but the user declared it hands-off. A
                // disabled-but-configured local backend still counts as
                // deletable — destroy registers it transiently (the enable-lock
                // forces disable-before-destroy for whole-backend subtrees).
                const configuredLocal = this.#isConfiguredLocalBackend(p.backend);
                deletable = (be ? be.canDelete : configuredLocal) && this.#dataBackends[p.backend]?.readOnly !== true;
            } else if (p?.scheme === 'file' && p.backend === '{WORKSPACE_ROOT}') {
                kind = 'workspace-file';
                deletable = true;
            } else if (p?.scheme === 'imap') {
                // Delegated to the mail service (deletable only if imap creds wired).
                const described = this.#describeImapLocation ? await this.#describeImapLocation(loc.url) : null;
                kind = 'imap';
                deletable = described?.deletable === true;
            } else if (p?.scheme === 'http' || p?.scheme === 'https') {
                kind = 'readonly';
                deletable = false;
            }
            out.push({ url: loc.url, scheme: p?.scheme, backend: p?.backend, kind, deletable });
        }
        return out;
    }

    /**
     * Destroy a document's blobs from backends (the "Destroy" op).
     *
     * For each targeted location: RW backend → delete bytes; read-only / foreign
     * → drop the reference only (no remote mutation). Then trim `locations[]`.
     * When no locations remain, the document carries no retrievable content, so
     * it is removed from the index (cascades unlink from all contexts).
     *
     * NOTE: imap:// EXPUNGE is delegated to the mail service (reference-dropped
     * when no credentials are wired). file://<deviceId> is reference-drop only.
     *
     * @param {object} doc                document instance/object with id + locations
     * @param {{urls?: string[]}} [options]  specific location URLs to target (default: all)
     * @returns {Promise<{deleted:string[], droppedRefs:string[], kept:string[], docDeleted:boolean}>}
     */
    async destroy(doc, options = {}) {
        if (!this.#stored) throw new Error('WorkspaceStoredIndex is not running');
        const db = this.#getDb();
        const locations = Array.isArray(doc?.locations) ? [...doc.locations] : [];
        const targets = Array.isArray(options.urls) ? new Set(options.urls) : new Set(locations.map((l) => l.url));

        const result = { deleted: [], droppedRefs: [], kept: [], docDeleted: false };
        const kept = [];

        for (const loc of locations) {
            if (!targets.has(loc.url)) { kept.push(loc); continue; }
            const p = parseLocationUrl(loc.url);
            try {
                if (p?.scheme === 'stored') {
                    const { backend: be, transient } = this.#ensureByteOpsBackend(p.backend);
                    if (be && be.canDelete && this.#dataBackends[p.backend]?.readOnly !== true) {
                        const res = await this.#stored.deleteByUrl(loc.url);
                        if (res.ok) result.deleted.push(loc.url);
                        else result.droppedRefs.push(loc.url);
                    } else {
                        // read-only (driver or config) / unknown backend → reference drop only
                        result.droppedRefs.push(loc.url);
                    }
                    if (transient) this.#stored.removeBackend?.(p.backend);
                } else if (p?.scheme === 'file' && p.backend === '{WORKSPACE_ROOT}') {
                    await fs.rm(path.join(this.#rootPath, p.key), { force: true });
                    result.deleted.push(loc.url);
                } else if (p?.scheme === 'imap') {
                    const res = this.#destroyImapLocation ? await this.#destroyImapLocation(loc.url) : null;
                    if (res?.ok) result.deleted.push(loc.url); // STORE \Deleted + EXPUNGE by UID
                    else result.droppedRefs.push(loc.url); // no credentials wired → drop reference only
                } else {
                    // http(s) RO, file://<device>, etc. → reference drop only
                    result.droppedRefs.push(loc.url);
                }
            } catch (error) {
                this.#logger.warn({ workspaceId: this.#workspaceId, url: loc.url, error: error.message }, 'Destroy: location wipe failed; keeping reference');
                kept.push(loc);
            }
        }

        doc.locations = kept;
        result.kept = kept.map((l) => l.url);

        if (kept.length === 0 && doc?.id != null) {
            if (options.keepDocument === true) {
                // Caller chose to keep the index entry with no retrievable bytes
                // (locations: []) — metadata/checksums stay searchable.
                await this.#put(doc, { context: null });
            } else {
                await db.delete(doc.id);
                result.docDeleted = true;
            }
        } else if (doc?.id != null) {
            await this.#put(doc, { context: null }); // persist trimmed locations (update in place)
        }
        return result;
    }

    #buildLocation(backendName, key) {
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

    #buildChecksumArray(checksums = {}) {
        return Object.entries(checksums || {})
            .filter(([, value]) => typeof value === 'string' && value.length > 0)
            .sort(([a], [b]) => {
                const ia = CHECKSUM_PRIORITY.indexOf(a);
                const ib = CHECKSUM_PRIORITY.indexOf(b);
                return (ia === -1 ? CHECKSUM_PRIORITY.length : ia) - (ib === -1 ? CHECKSUM_PRIORITY.length : ib) || a.localeCompare(b);
            })
            .map(([algorithm, hash]) => `${algorithm}/${hash}`);
    }

    #buildBackendPaths(backends = []) {
        return Array.from(new Set(
            backends
                .filter(Boolean)
                .map((backend) => {
                    const root = this.#getBackendRootPath(backend.backend);
                    if (!root) return null;
                    const filePath = backend?.source?.path || backend?.key || '';
                    const dir = filePath ? path.dirname(filePath) : null;
                    const suffix = (dir && dir !== '.') ? `/${dir}` : '';
                    return `${root}${suffix}`;
                })
                .filter(Boolean)
        ));
    }

    #buildFeatures(backends = []) {
        const features = [];
        for (const backend of backends) {
            if (backend.backend === HOME_STORED_BACKEND) {
                features.push(HOME_BACKEND_FEATURE);
            } else if (backend.backend === DATA_BLOB_BACKEND) {
                features.push(DATA_BLOB_FEATURE);
            }
            // Canonical source-backend tag on every ingested doc. Lets the UI
            // count/select "everything from backend X" independent of where the
            // doc now lives in the tree. Observability/selection only — purge stays
            // scoped to the /.backends subtree path, never this bitmap.
            if (backend.backend) features.push(`data/backend/${backend.backend}`);
            if (backend?.source?.provider) features.push(`data/source/${backend.source.provider}`);
        }
        return Array.from(new Set(features));
    }

    // A file doc is a pure blob: identity is the checksum, bytes live in
    // `stored` (referenced by canonical stored:// URLs), and size/mime are
    // doc-level invariants. No inline `data`, no duplicated backend descriptors —
    // anything else is derivable from the URL via `stored`.
    #buildDocument(storedFile = {}, checksumArray = [], backends = [], existingDocument = null, meta = null) {
        const size = Number.isFinite(storedFile.size) ? storedFile.size : existingDocument?.metadata?.size;
        const locations = this.#buildDocumentLocations(backends);
        // Fall back to a filename-derived mime when `stored` didn't detect one
        // (filesystem-indexed files often have no sniffed mime) — otherwise the
        // File doc defaults to 'application/json' and images never get classified
        // or embedded.
        const mime = storedFile.mimeType || existingDocument?.metadata?.contentType || mimeFromLocations(locations);

        const metadata = { ...(existingDocument?.metadata || {}) };
        if (Number.isFinite(size)) metadata.size = size; else delete metadata.size;
        if (typeof mime === 'string' && mime.length > 0) metadata.contentType = mime;

        // Inline-extracted metadata (EXIF/GPS/dimensions/media) lives on the stored
        // index entry's `custom` (surfaced via stat → meta). Merge the known keys
        // onto the doc (metadata is .catchall(z.any()) so nested objects are fine).
        const extracted = meta?.custom && typeof meta.custom === 'object' ? meta.custom : null;
        if (extracted) {
            for (const k of ['geo', 'exif', 'dimensions', 'media']) {
                if (extracted[k] && typeof extracted[k] === 'object') { metadata[k] = extracted[k]; }
            }
        }

        const doc = {
            schema: 'data/abstraction/file',
            checksumArray: checksumArray.length > 0 ? checksumArray : (existingDocument?.checksumArray || []),
            data: {},
            locations,
            metadata,
        };

        // Content-derived date (EXIF capture time) → the default 'content' timeline
        // (distinct from crud lifecycle). Preserve any existing timelines.
        const capturedAt = extracted?.exif?.capturedAt;
        if (capturedAt) {
            const prior = Array.isArray(existingDocument?.timelines) ? existingDocument.timelines : [];
            const hasContent = prior.some(t => (t.timeline || t.name) === 'content');
            doc.timelines = hasContent ? prior : [...prior, { timeline: 'content', start: capturedAt }];
        } else if (Array.isArray(existingDocument?.timelines) && existingDocument.timelines.length) {
            doc.timelines = existingDocument.timelines;
        }

        return doc;
    }

    #buildDocumentLocations(backends = []) {
        const seen = new Set();
        const locations = [];
        for (const backend of backends) {
            if (!backend?.key) continue;
            const url = backend.url || `stored://${backend.backend}/${backend.key}`;
            if (seen.has(url)) continue;
            seen.add(url);
            // Surface the real protocol URL for remote backends (https/smb/s3/imap).
            // Local fs paths are kept server-side only (stored:// is the address).
            locations.push(backend.nativeUrl && backend.driver !== 'file'
                ? { url, nativeUrl: backend.nativeUrl }
                : { url });
        }
        return locations;
    }

    #resolveBackendRoot(backendName, config = {}) {
        const configuredRoot = config.root || '';
        if (configuredRoot.includes('{WORKSPACE_ROOT}')) {
            return configuredRoot.replaceAll('{WORKSPACE_ROOT}', this.#rootPath);
        }
        if (backendName === HOME_STORED_BACKEND) return this.#homePath;
        if (backendName === DATA_BLOB_BACKEND) return this.#dataPath;
        return configuredRoot || this.#dataPath;
    }

    /**
     * Stable tree node for a backend under the strict mirror schema:
     *   /<driver>/<resource-address> (in the dedicated backends tree)
     * The resource address is the backend name (e.g. 'workspace:home'); remote
     * drivers (s3, …) may extend this with container/bucket segments later.
     *
     * Mirrored backends are the enumerable, non-managed ones: managed blob
     * stores (workspace:data, stored.cache) are opaque by design — their
     * documents are filed by the connector that persisted them (e.g. mail under
     * /imap/...). Config presence, not `enabled`, gates the path so the
     * disable-then-destroy flow can still resolve a disabled backend's subtree.
     */
    #getBackendRootPath(backendName) {
        const config = this.#dataBackends[backendName];
        if (!config || config.supported === false) return null;
        if (config.managed === true || backendName === CACHE_BACKEND) return null;
        const driver = String(config.driver || 'file').toLowerCase();
        const live = this.#stored?.getBackend(backendName);
        const canEnumerate = live ? live.capabilities?.canEnumerate === true : driver === 'file';
        if (!canEnumerate) return null;
        const address = String(backendName || '').replace(/[^a-z0-9._:@-]+/gi, '-').toLowerCase();
        return `/${driver}/${address}`;
    }

    /**
     * Inverse of #getBackendRootPath: map a backends-tree path back to the
     * configured backend it mirrors (prefix match). Returns the backend name or
     * null when no configured backend owns the path (e.g. imap subtrees — those
     * are the mail service's, resolved separately).
     */
    resolveBackendForTreePath(treePath) {
        const normalized = String(treePath || '').replace(/\/+/g, '/').replace(/\/$/, '');
        for (const backendName of Object.keys(this.#dataBackends || {})) {
            const root = this.#getBackendRootPath(backendName);
            if (root && (normalized === root || normalized.startsWith(`${root}/`))) return backendName;
        }
        return null;
    }

    /** Public accessor for the mirror node of a backend (Workspace lock wiring). */
    getBackendRootPath(backendName) {
        return this.#getBackendRootPath(backendName);
    }

    #setBackendError(backendName, error) {
        this.#backendStatus.set(backendName, {
            ...(this.#backendStatus.get(backendName) || {}),
            lastError: error?.message || String(error),
        });
    }
}
