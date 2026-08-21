'use strict';

import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import getFolderSize from 'get-folder-size';
import Stored from 'canvas-stored';
import { extract as extractBlobMetadata } from 'canvas-stored/src/extractors/index.js';
import { parseLocationUrl, deviceFileUrl } from 'canvas-synapsd/src/utils/path-helpers.js';
import { mimeFromLocations } from './classifier.js';
import { pickGeo } from './geo.js';
import { BACKENDS_TREE_NAME, normalizeSegment } from '../../../utils/backend-documents.js';
import { DEFAULT_SYNC_EXCLUSIONS, WORKSPACE_INTERNAL_EXCLUSIONS } from './constants.js';

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
// The default local content-addressable blob store. Connectors persist blobs
// here (persistBlob) and address them by stored://workspace:data/<key>.
const DATA_BLOB_BACKEND = 'workspace:data';
// Drivers this index registers into Stored and toggles live by config. Local
// ones write bytes in-process; remote ones (gdrive) go cache → SyncQueue and
// are registered the same way — the driver, not this index, owns the transport.
const STORED_DRIVERS = new Set(['file', 'cacache', 'gdrive']);
// Subset with on-disk roots this server can walk (disk usage, fs liveness).
const LOCAL_DRIVERS = new Set(['file', 'cacache']);
// Drivers with a real hierarchical namespace — folder create/rename/delete.
const CONTAINER_DRIVERS = new Set(['file', 'gdrive']);
// Remote-driver config keys the live instance reads at construction: a patch
// touching one re-registers the backend (credentials/root/poll cadence).
const REMOTE_RESTART_KEYS = ['clientId', 'clientSecret', 'refreshToken', 'folderId', 'pollInterval', 'permanentDelete'];
const CHECKSUM_PRIORITY = ['sha256', 'sha1', 'md5'];
// Orphan lifecycle: a doc whose last resolvable location vanished keeps its
// row, checksums and curated placements, gains this feature bitmap (plus
// orphanedAt on the doc), and is only purged by retention GC or explicit user
// action. If its bytes reappear anywhere, the checksum index re-binds the new
// location to the same doc and curation survives the round trip.
const NO_LOCATION_FEATURE = 'data/no-location';

export class WorkspaceStoredIndex {
    static HOME_STORED_BACKEND = HOME_STORED_BACKEND;
    static DATA_BLOB_BACKEND = DATA_BLOB_BACKEND;

    #rootPath;
    #cachePath;
    #dataPath;
    #homePath;
    #storedRootPath;
    // Absolute paths of the workspace's own runtime dirs. Any that fall under
    // an indexed backend's root are excluded from watch/list/scan — see
    // #structuralExclusions.
    #internalPaths;
    #dataBackends;
    #workspaceId;
    // Current server device ({deviceId, name}) — the file://<deviceId>/<path>
    // authority for external fs mounts. Optional: without it, external mounts
    // fall back to server-local stored:// addressing only.
    #device;
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
    #resyncCancels = new Set();

    // Optional hooks: mirror a bare directory path into the backends tree
    // (skeleton mirroring — docs create their paths themselves), and observe
    // resync lifecycle/progress (Workspace re-emits it as a ws event).
    #insertBackendPath;
    #onResyncStateChange;
    // Optional: quietly persist a backend-config patch (fsid snapshot on first
    // successful liveness check) without re-triggering applyBackendConfig.
    #persistBackendConfig;
    // Optional: orphan-GC retention in days (-1 = keep forever). Read after
    // each successful resync; also used by explicit gcOrphanedDocuments calls.
    #getOrphanRetentionDays;

    constructor({ rootPath, cachePath, dataPath, homePath, storedRootPath, internalPaths = [], dataBackends = {}, workspaceId, device = null, logger, put, unlink, getBackendsTreeSelector, getDb, describeImapLocation = null, destroyImapLocation = null, lockBackendNode = null, unlockBackendNode = null, insertBackendPath = null, onResyncStateChange = null, persistBackendConfig = null, getOrphanRetentionDays = null }) {
        if (!dataPath || !homePath) throw new Error('dataPath and homePath are required');
        if (!put || !unlink || !getBackendsTreeSelector || !getDb) throw new Error('put, unlink, getBackendsTreeSelector, getDb are required');

        this.#rootPath = rootPath || path.dirname(dataPath);
        this.#cachePath = cachePath || path.join(this.#rootPath, 'cache');
        this.#dataPath = dataPath;
        this.#homePath = homePath;
        this.#storedRootPath = storedRootPath || path.join(this.#rootPath, 'db', 'stored');
        this.#internalPaths = [
            ...new Set([this.#cachePath, this.#dataPath, this.#storedRootPath, ...internalPaths]
                .filter(Boolean).map((p) => path.resolve(p))),
        ];
        this.#dataBackends = dataBackends;
        this.#workspaceId = workspaceId;
        this.#device = device;
        this.#logger = logger || console;
        this.#put = put;
        this.#unlink = unlink;
        this.#getBackendsTreeSelector = getBackendsTreeSelector;
        this.#getDb = getDb;
        this.#describeImapLocation = describeImapLocation;
        this.#destroyImapLocation = destroyImapLocation;
        this.#lockBackendNode = lockBackendNode;
        this.#unlockBackendNode = unlockBackendNode;
        this.#insertBackendPath = insertBackendPath;
        this.#onResyncStateChange = onResyncStateChange;
        this.#persistBackendConfig = persistBackendConfig;
        this.#getOrphanRetentionDays = getOrphanRetentionDays;
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
            running: !!backend,
            watching: backend?.watching || false,
            // Network mount (NFS/CIFS/sshfs/…) detected from the kernel mount
            // table by the file driver, or declared in config. The UI badges it
            // and clients can warn before triggering an expensive full resync.
            remote: backend?.remote === true,
            transport: backend?.transport || null,
        };
    }

    /**
     * Shared preflight for copy/move. Both ends must be LIVE backends, not
     * transiently registered ones: dropping a transient registration afterwards
     * prunes that backend's locations from stored's index, which would undo the
     * transfer we just made. "Enable the backend first" is the honest answer.
     */
    #transferEndpoints(url, target) {
        if (!this.#stored) throw new Error('Stored index is not running');
        const parsed = parseLocationUrl(url);
        if (!parsed || parsed.scheme !== 'stored') throw new Error(`Not a stored:// URL: ${url}`);
        if (!target) throw new Error('A target backend is required');
        if (!this.#stored.getBackend(parsed.backend)) {
            throw new Error(`Source backend "${parsed.backend}" is not enabled`);
        }
        if (!this.#stored.getBackend(target)) {
            throw new Error(`Target backend "${target}" is not enabled`);
        }
        if (this.#dataBackends[target]?.readOnly === true) {
            throw new Error(`Target backend "${target}" is read-only`);
        }
        return `${parsed.backend}:${parsed.key}`;
    }

    /**
     * Map a document location back to the (backend, key) pair that addresses its
     * bytes. Both address forms resolve: `stored://<backend>/<key>` directly,
     * and a device-scoped `file://<deviceId>/<abs>` through its owning mount
     * (external mounts carry ONLY the file:// form, so without this a NAS mount
     * would have nothing to transfer from). Null for anything not ours —
     * imap://, https://, foreign devices.
     */
    #locationEndpoint(location) {
        const parsed = parseLocationUrl(location?.url);
        if (!parsed) return null;
        if (parsed.scheme === 'stored') return { backend: parsed.backend, key: parsed.key, url: location.url };
        if (parsed.scheme === 'file' && location?.metadata?.backend) {
            const key = this.#backendLocationKey(location.metadata.backend, location);
            return key ? { backend: location.metadata.backend, key, url: location.url } : null;
        }
        return null;
    }

    /**
     * Every location of this document that addresses bytes we can transfer,
     * as (backend, key) pairs. Used by rules to pick a source and to build a
     * destination key from the current filename.
     */
    locationEndpoints(doc) {
        return (doc?.locations || []).map((l) => this.#locationEndpoint(l)).filter(Boolean);
    }

    /**
     * Copy or move one document's bytes onto `to`. The source is whichever of
     * its locations is not already on the target (or `from`, when the caller
     * has already picked one); being already there is reported rather than
     * silently succeeding, so a batch result says what actually happened per
     * document.
     *
     * `key` renames on arrival — a rule filing photos as YYYY/MM/…jpg passes
     * one — and `onConflict` decides what happens when that key is taken.
     */
    async transferDocument(doc, { to, mode = 'copy', key = undefined, onConflict = undefined, from = null } = {}) {
        const endpoints = this.locationEndpoints(doc);
        if (endpoints.length === 0) throw new Error('Document has no transferable byte location');
        const source = from
            ? endpoints.find((e) => e.backend === from.backend && e.key === from.key)
            : endpoints.find((e) => e.backend !== to);
        if (!source) throw new Error(from ? `No location on "${from.backend}"` : `Already on "${to}"`);

        const url = `stored://${source.backend}/${source.key}`;
        const options = { to, key, onConflict };
        return mode === 'move' ? this.moveObject(url, options) : this.copyObject(url, options);
    }

    /** This document's location URLs that live on any of `backends`. */
    locationUrlsOnBackends(doc, backends = []) {
        const wanted = new Set(backends);
        return (doc?.locations || [])
            .filter((l) => { const e = this.#locationEndpoint(l); return e && wanted.has(e.backend); })
            .map((l) => l.url);
    }

    /**
     * Copy the object behind a `stored://` URL onto another backend. Content
     * identity is preserved: the document gains a location, and the resulting
     * `object:location:add` patches it in place.
     */
    async copyObject(url, { to, key, onConflict } = {}) {
        const idOrKey = this.#transferEndpoints(url, to);
        return this.#stored.copy(idOrKey, { to, key, onConflict, from: url });
    }

    /**
     * Move the object behind a `stored://` URL to another backend. The source is
     * only released once the destination write is durable; a move onto a
     * `type:'remote'` backend returns `state:'pending'` and completes on sync.
     */
    async moveObject(url, { to, key, onConflict } = {}) {
        const idOrKey = this.#transferEndpoints(url, to);
        if (this.#dataBackends[parseLocationUrl(url).backend]?.readOnly === true) {
            throw new Error('Source backend is read-only — copy instead of move');
        }
        return this.#stored.move(idOrKey, { to, key, onConflict, from: url });
    }

    async start() {
        if (this.#stored) return;

        try {
            this.#stored = new Stored({
                // Configured runtime root (default db/stored) — NOT a hidden
                // .stored/. Holds Stored's metadata index; the blob cache is
                // redirected to the workspace cache dir (services.stored.cache).
                root: this.#storedRootPath,
                cache: { path: this.#cachePath },
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
            // operation via the backend sync API — a potentially slow scan that
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
        if (!CONTAINER_DRIVERS.has(config.driver)) throw new Error(`Backend "${backendName}" has no mutable folders`);
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

    /**
     * Request cancellation of an in-flight resync. The walk stops at the next
     * file boundary. Nothing is reconciled from the partial snapshot (no
     * orphaning), and already-indexed files stay indexed — a later resync
     * resumes cheaply via the checksum cache, so cancel + re-run ≈ pause.
     */
    cancelResync(backendName = HOME_STORED_BACKEND) {
        if (!this.#resyncing.has(backendName)) {
            return { backend: backendName, resyncing: false, cancelled: false };
        }
        this.#resyncCancels.add(backendName);
        return { backend: backendName, cancelRequested: true };
    }

    async resync(backendName = HOME_STORED_BACKEND) {
        this.#assertResyncable(backendName);

        // Re-entrancy guard: a resync of the same backend already in flight must
        // not be duplicated (the scan is expensive and writes are not idempotent
        // under concurrency).
        if (this.#resyncing.has(backendName)) {
            return { backend: backendName, count: null, alreadyRunning: true };
        }
        this.#resyncCancels.delete(backendName);
        this.#resyncing.add(backendName);
        this.#patchResyncState(backendName, {
            resyncing: true,
            resyncStartedAt: new Date().toISOString(),
            progress: { scanned: 0, total: null },
        });

        try {
            // Liveness gate: an absent mountpoint or a different filesystem at
            // the root scans as "empty", which a differ would read as "all
            // deleted". Verify the root (and its fsid snapshot from mount
            // creation) BEFORE touching anything; on failure the backend goes
            // offline and nothing is removed — stale is a state, not a deletion.
            const backend = this.#stored.getBackend(backendName);
            const config = this.#dataBackends[backendName] || {};
            if (typeof backend?.verifyRoot === 'function') {
                const liveness = await backend.verifyRoot(config.fsid || null);
                if (!liveness.ok) {
                    this.#patchResyncState(backendName, {
                        offline: true,
                        lastError: `mount unavailable (${liveness.reason})`,
                    });
                    this.#logger.warn({ workspaceId: this.#workspaceId, backend: backendName, reason: liveness.reason }, 'Resync skipped: backend root failed liveness check');
                    return { backend: backendName, ok: false, offline: true, reason: liveness.reason };
                }
                this.#patchResyncState(backendName, { offline: false }, { quiet: true });
                // First successful verify: snapshot the filesystem identity into
                // the mount config so later resyncs can tell "unmounted" from
                // "emptied".
                if (!config.fsid && liveness.fsid && typeof this.#persistBackendConfig === 'function') {
                    this.#dataBackends = { ...this.#dataBackends, [backendName]: { ...config, fsid: liveness.fsid } };
                    await Promise.resolve(this.#persistBackendConfig(backendName, { fsid: liveness.fsid })).catch((err) =>
                        this.#logger.warn({ workspaceId: this.#workspaceId, backend: backendName, error: err.message }, 'Failed to persist mount fsid snapshot'));
                }
            }

            // Structural pre-pass: mirror the folder skeleton into the backends
            // tree and size the progress bar — readdir only, so even a large
            // network mount shows its subtree within seconds while checksums
            // stream in behind it.
            const total = await this.#mirrorBackendShape(backendName);
            if (total !== null) this.#patchResyncState(backendName, { progress: { scanned: 0, total } });

            // Stream: each hashed file is upserted (doc + tree path) as the walk
            // runs. A single bad file must not kill an hours-long scan — upsert
            // failures are logged and counted, not thrown.
            let scanned = 0;
            let failed = 0;
            const upserted = new Set();
            const consume = async (file) => {
                // Cancellation: throwing here aborts the backend's walk at the
                // current file (onFile is awaited inline by the scan loop).
                if (this.#resyncCancels.has(backendName)) {
                    const err = new Error('resync cancelled');
                    err.code = 'RESYNC_CANCELLED';
                    throw err;
                }
                if (file?.key == null || upserted.has(file.key)) return;
                upserted.add(file.key);
                try {
                    await this.#upsertDocument(file);
                } catch (error) {
                    failed += 1;
                    this.#logger.warn({ workspaceId: this.#workspaceId, backend: backendName, key: file.key, error: error.message }, 'Resync document upsert failed');
                }
                scanned += 1;
                if (scanned % 25 === 0) {
                    this.#patchResyncState(backendName, { progress: { scanned, total } }, { quiet: scanned % 100 !== 0 });
                }
            };

            let scanResult;
            try {
                scanResult = await this.#stored.scan(backendName, { onFile: consume });
                // Backends whose scan() does not stream still get their rows here.
                for (const file of scanResult.files || []) await consume(file);
            } catch (error) {
                if (error?.code !== 'RESYNC_CANCELLED') throw error;
                // Cancelled: the snapshot is partial, so NOTHING may be
                // reconciled from it (a differ would read the unwalked rest as
                // "all deleted"). Indexed rows stay; a later resync resumes via
                // the checksum cache.
                this.#logger.info({ workspaceId: this.#workspaceId, backend: backendName, scanned }, 'Resync cancelled by user');
                this.#patchResyncState(backendName, { lastError: null, cancelledAt: new Date().toISOString() });
                return { backend: backendName, cancelled: true, scanned };
            }
            const { files = [] } = scanResult;
            const scanErrors = scanResult.errors?.[backendName] || null;

            // Reconcile absences only against a usable snapshot: a dead root
            // means the walk never happened (double-guard behind the liveness
            // gate above — the mount can vanish mid-resync too).
            if (scanErrors?.root) {
                this.#patchResyncState(backendName, { offline: true, lastError: `mount unavailable (${scanErrors.root})` });
                return { backend: backendName, ok: false, offline: true, reason: scanErrors.root };
            }
            const orphaned = await this.#purgeOrphanedPaths(backendName, files, scanErrors);
            // Global stale-local-path cleanup: drop locations whose backend was
            // renamed/removed (dead-backend refs like the legacy fs:home). Gated to
            // the home resync so the all-file-docs scan runs once, not per backend.
            if (backendName === HOME_STORED_BACKEND) {
                await this.#purgeDeadBackendLocations().catch((error) =>
                    this.#logger.warn({ workspaceId: this.#workspaceId, error: error.message }, 'Dead-backend location purge failed'));
            }
            this.#patchResyncState(backendName, {
                lastScanAt: new Date().toISOString(),
                lastError: failed > 0 ? `${failed} of ${files.length} files failed to index` : null,
                fileCount: files.length,
                orphaned,
                progress: { scanned, total: files.length },
            }, { quiet: true });

            // Retention GC: purge orphans past the window. Default retention is
            // -1 (keep forever) — explicit cleanup goes through the data/no-location
            // filter or gcOrphanedDocuments().
            const retentionDays = typeof this.#getOrphanRetentionDays === 'function' ? this.#getOrphanRetentionDays() : -1;
            if (Number.isFinite(retentionDays) && retentionDays >= 0) {
                await this.gcOrphanedDocuments({ retentionDays }).catch((error) =>
                    this.#logger.warn({ workspaceId: this.#workspaceId, error: error.message }, 'Orphan GC failed'));
            }

            return { backend: backendName, count: files.length, failed, orphaned };
        } finally {
            this.#resyncing.delete(backendName);
            this.#resyncCancels.delete(backendName);
            this.#patchResyncState(backendName, { resyncing: false });
        }
    }

    // Merge a status patch + notify the resync observer (Workspace re-emits it
    // to clients). `quiet` skips the observer for high-frequency updates.
    #patchResyncState(backendName, patch = {}, { quiet = false } = {}) {
        const next = { ...(this.#backendStatus.get(backendName) || {}), ...patch };
        this.#backendStatus.set(backendName, next);
        if (quiet || typeof this.#onResyncStateChange !== 'function') return;
        try {
            this.#onResyncStateChange({
                backend: backendName,
                // Mirror node the client should badge (null for unmirrored backends).
                treePath: this.#getBackendRootPath(backendName),
                resyncing: next.resyncing === true,
                progress: next.progress || null,
                lastScanAt: next.lastScanAt || null,
                lastError: next.lastError || null,
            });
        } catch { /* observer must never break a resync */ }
    }

    // Mirror the mount's directory skeleton under its backends-tree root and
    // return the file count for progress totals (null when unsupported).
    async #mirrorBackendShape(backendName) {
        try {
            const root = this.#getBackendRootPath(backendName);
            if (!root || typeof this.#insertBackendPath !== 'function') return null;
            const shape = await this.#stored.shape?.(backendName);
            if (!shape?.ok) return null;
            for (const dir of shape.dirs) {
                await this.#insertBackendPath(`${root}/${dir}`);
            }
            return shape.files;
        } catch (error) {
            this.#logger.warn({ workspaceId: this.#workspaceId, backend: backendName, error: error.message }, 'Backend skeleton mirror failed');
            return null;
        }
    }

    /**
     * On-demand disk usage for a local backend. Uses get-folder-size (cross-
     * platform, hardlink/inode-aware — stored's commit() hardlinks, so a naive
     * walk double-counts; `loose` skips unreadable entries). Potentially slow on
     * large trees (a whole home dir), which is why it only runs when explicitly
     * requested; the result is cached on the backend status so list/status
     * reads can show the last computed value.
     */
    async getBackendDiskUsage(backendName) {
        const config = this.#dataBackends[backendName];
        const isLocal = !!config && LOCAL_DRIVERS.has(config.driver);
        if (!isLocal) throw new Error(`Backend "${backendName}" has no local disk usage`);

        const root = this.#resolveBackendRoot(backendName, config);
        const bytes = await getFolderSize.loose(root);
        const usage = { backend: backendName, bytes, computedAt: new Date().toISOString() };
        this.#backendStatus.set(backendName, {
            ...(this.#backendStatus.get(backendName) || {}),
            diskUsage: usage,
        });
        return usage;
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

        const isLocal = STORED_DRIVERS.has(fullConfig.driver) && fullConfig.supported !== false;

        if ('enabled' in patch) {
            const live = this.#stored.getBackend(name);
            if (patch.enabled && !live && isLocal) {
                this.#stored.addBackend(name, this.#backendRegistrationConfig(name, fullConfig));
                this.#backendStatus.set(name, { lastScanAt: null, lastError: null });
                await this.#applyBackendNodeLock(name, true);
                if (fullConfig.resync) {
                    // Initial/catch-up scan can be slow (a whole external
                    // folder) — never block the enable/add call on it.
                    try { this.resyncInBackground(name); } catch (err) { this.#setBackendError(name, err); }
                }
            } else if (!patch.enabled && live) {
                await live.stop?.().catch(() => {});
                // removeBackend is async (awaits watcher stop before dropping
                // the registry entry) — must be awaited or a re-add races it.
                await this.#stored.removeBackend?.(name);
                this.#backendStatus.delete(name);
                await this.#applyBackendNodeLock(name, false);
            }
        }

        // Remote drivers: credentials/root live on the instance — swap it out
        // when they change (stop → remove → add, watcher restored from config).
        if (!LOCAL_DRIVERS.has(fullConfig.driver) && REMOTE_RESTART_KEYS.some((k) => k in patch) && !('enabled' in patch)) {
            const live = this.#stored.getBackend(name);
            if (live && fullConfig.enabled && fullConfig.supported !== false) {
                await live.stop?.().catch(() => {});
                await this.#stored.removeBackend?.(name);
                this.#stored.addBackend(name, this.#backendRegistrationConfig(name, fullConfig));
            }
        }

        if ('watch' in patch) {
            const live = this.#stored.getBackend(name);
            if (live) {
                if (patch.watch && !live.watching) {
                    await live.watch?.();
                    // Catch up on anything that landed while watch was off —
                    // in the background, the toggle must not block on a scan.
                    if (fullConfig.resync) {
                        try { this.resyncInBackground(name); } catch (err) { this.#setBackendError(name, err); }
                    }
                } else if (!patch.watch && live.watching) {
                    await live.stop?.();
                }
            }
        }

        // New exclusion patterns require rebuilding the backend's matcher
        // (chokidar + list/scan share it): re-register the live backend. A
        // follow-up resync applies exclusions retroactively (unlink-only).
        // Skip when 'enabled' just (re)registered the backend above — the fresh
        // registration already carries the full config, exclusions included.
        if ('exclude' in patch && !('enabled' in patch && patch.enabled)) {
            const live = this.#stored.getBackend(name);
            if (live && isLocal && fullConfig.enabled) {
                await live.stop?.().catch(() => {});
                // Async remove must complete before the re-add or it collides.
                await this.#stored.removeBackend?.(name);
                this.#stored.addBackend(name, this.#backendRegistrationConfig(name, fullConfig));
            }
        }
    }

    async #registerConfiguredBackends() {
        for (const [backendName, config] of Object.entries(this.#dataBackends || {})) {
            if (!config?.enabled || config.supported === false || !STORED_DRIVERS.has(config.driver)) continue;

            this.#stored.addBackend(backendName, this.#backendRegistrationConfig(backendName, config));
            this.#backendStatus.set(backendName, { lastScanAt: null, lastError: null });
            await this.#applyBackendNodeLock(backendName, true);
        }
    }

    // Shared registration config: resolved root + effective exclusions (defaults
    // ∪ per-backend user patterns) wired into the driver's shared ignore matcher.
    #backendRegistrationConfig(backendName, config = {}) {
        if (!LOCAL_DRIVERS.has(config.driver)) return this.#remoteRegistrationConfig(backendName, config);
        const root = this.#resolveBackendRoot(backendName, config);
        return {
            ...config,
            root,
            ignored: this.#effectiveExclusions(config, root),
            // External (device-anchored) mounts must never auto-create their
            // mountpoint: a created-empty dir at an unmounted path would make
            // "absent" scan as "empty". Managed workspace stores may create.
            createRoot: config.device?.id ? false : config.createRoot !== false,
            provider: config.provider || 'fs',
            account: config.account || 'workspace',
            container: config.container || (backendName === HOME_STORED_BACKEND ? 'home' : 'data'),
        };
    }

    // Remote drivers have no on-disk root and no exclusion matcher: the config
    // goes to the driver as-is (credentials included — the driver is the only
    // consumer), plus the source descriptor stored stamps on every location.
    #remoteRegistrationConfig(backendName, config = {}) {
        const { root: _root, exclude: _exclude, ...rest } = config;
        return {
            ...rest,
            provider: config.provider || config.driver,
            account: config.account || backendName,
            container: config.container || config.folderId || 'root',
            algorithms: ['sha256'],
        };
    }

    #effectiveExclusions(config = {}, backendRoot = null) {
        if (config.driver !== 'file') return undefined;
        const user = Array.isArray(config.exclude) ? config.exclude.filter((p) => typeof p === 'string' && p.trim()) : [];
        return [...this.#structuralExclusions(backendRoot), ...DEFAULT_SYNC_EXCLUSIONS, ...user];
    }

    /**
     * Root-anchored patterns for the workspace's own runtime dirs that live
     * inside this backend's root. The `home` layout puts the home backend's
     * root AT the workspace root, so `.workspace/` (and anything a config
     * remapped out of it) has to be pruned explicitly — dotfiles are excluded
     * by default too, but that rule is user-facing policy while this one is
     * structural: without it the workspace indexes its own database.
     */
    #structuralExclusions(backendRoot) {
        const patterns = [...WORKSPACE_INTERNAL_EXCLUSIONS];
        if (!backendRoot) return patterns;
        const root = path.resolve(backendRoot);
        for (const internal of this.#internalPaths) {
            if (internal === root || !internal.startsWith(root + path.sep)) continue;
            const rel = path.relative(root, internal).split(path.sep).join('/');
            if (!rel || rel.startsWith('..')) continue;
            patterns.push(rel, `${rel}/**`);
        }
        return [...new Set(patterns)];
    }

    /** Effective exclusion patterns for a backend (structural + defaults + user), for the API. */
    getEffectiveExclusions(backendName) {
        const config = this.#dataBackends[backendName];
        if (!config) return [];
        return this.#effectiveExclusions(config, this.#resolveBackendRoot(backendName, config)) ?? [];
    }

    #isConfiguredLocalBackend(backendName) {
        const config = this.#dataBackends[backendName];
        return !!config && config.supported !== false && STORED_DRIVERS.has(config.driver);
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
            if (transient) await this.#stored.removeBackend?.(parsed.backend);
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
            // Location mutations that preserve content identity (copy/move
            // between backends, cache eviction). These MUST be patched in
            // place: routing them through unlink+add would drop the document's
            // curated tree placements and rebuild it under a new id.
            'object:move': (payload) => this.#applyLocationChange(payload),
            'object:location:add': (payload) => this.#applyLocationChange(payload),
            'object:location:remove': (payload) => this.#applyLocationChange(payload),
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

    /**
     * Reconcile absences after a COMPLETED scan of one backend. Scoped strictly
     * to that backend's locations (stored://<backend>/…, plus the device file://
     * twins tied via metadata.backend) — s3://, imap:// etc. on the same doc are
     * never touched. Per-entry semantics:
     *   - checksum present in scan        → unchanged, skip
     *   - path present, new checksum      → in-place edit: migrate curated
     *     placements to the successor doc (derivedFrom breadcrumb), then orphan
     *   - path under an unreadable subtree→ carry forward (stale, not deleted)
     *   - path hashed-failed              → present-but-unverified, carry forward
     *   - path gone                       → drop this backend's locations; doc
     *     orphans (never deletes) if none survive
     * Returns the number of docs that lost locations here.
     */
    async #purgeOrphanedPaths(backendName, presentFiles = [], scanErrors = null) {
        const db = this.#getDb();
        const nfc = (k) => String(k).normalize('NFC');
        const presentChecksums = new Set(
            presentFiles.flatMap((f) => this.#buildChecksumArray(f.checksums))
        );
        // ALL scanned keys count as present — a row that failed to hash is
        // present-but-unverified, not deleted.
        const fileByKey = new Map(presentFiles.map((f) => [nfc(f.key), f]));
        const erroredPrefixes = (scanErrors?.dirs || []).map((d) => d.prefix).filter(Boolean);
        const underErroredPrefix = (key) => erroredPrefixes.some((prefix) =>
            key === prefix || key.startsWith(`${prefix}/`));

        const backendRoot = this.#getBackendRootPath(backendName);
        if (!backendRoot) return 0;
        // RECURSIVE: the mirror nests one node per folder, so a plain list of the
        // backend's root node only sees files sitting directly in it. Absences
        // in every subfolder — i.e. almost every real file — would go
        // unreconciled, leaving documents pointing at bytes that are gone.
        const { documents: docsInTree = [] } = await db
            .listTreeDocuments(BACKENDS_TREE_NAME, { path: backendRoot, limit: null })
            .catch(() => ({ documents: [] }));

        let reconciled = 0;
        for (const doc of docsInTree) {
            const primaryChecksum = doc.checksumArray?.[0];
            if (!primaryChecksum) continue;

            const ownedLocations = (doc.locations || [])
                .filter((l) => parseLocationUrl(l.url)?.backend === backendName || l.metadata?.backend === backendName);
            if (ownedLocations.length === 0) continue;

            const located = ownedLocations.map((l) => {
                const key = this.#backendLocationKey(backendName, l);
                return { location: l, key: key != null ? nfc(key) : null };
            });
            const keys = located.map((e) => e.key).filter((k) => k != null);

            // Content still present in the snapshot: the doc survives, but any
            // owned location whose path vanished (the old path of a moved file,
            // upserted mid-scan before the walk completed) is trimmed — scoped
            // to this backend, carried forward under errored prefixes.
            if (presentChecksums.has(primaryChecksum)) {
                const staleUrls = located
                    .filter(({ key }) => key != null && !fileByKey.has(key) && !underErroredPrefix(key))
                    .map(({ location }) => location.url);
                if (staleUrls.length > 0) {
                    await this.#reconcileRemovedLocations(doc, staleUrls);
                    reconciled += 1;
                }
                continue;
            }

            // Unreadable subtree — prior entries carry forward as stale.
            if (keys.some(underErroredPrefix)) continue;
            // Path still exists but failed to hash — present, not deleted.
            const survivorFiles = keys.map((k) => fileByKey.get(k)).filter(Boolean);
            if (survivorFiles.some((f) => !f.checksums)) continue;

            // Same path, new bytes: content identity made a new doc — migrate
            // the predecessor's curated placements to it before orphaning.
            const successorFile = survivorFiles.find((f) => f.checksums);
            if (successorFile) {
                await this.#migrateToSuccessor(doc, successorFile).catch((error) =>
                    this.#logger.warn({ workspaceId: this.#workspaceId, docId: doc.id, key: successorFile.key, error: error.message }, 'Placement migration to successor failed'));
            }

            const removedUrls = ownedLocations.map((l) => l.url);
            await this.#reconcileRemovedLocations(doc, removedUrls);
            reconciled += 1;
        }
        if (reconciled > 0) {
            this.#logger.info({ workspaceId: this.#workspaceId, backend: backendName, docs: reconciled }, 'Resync: reconciled removed locations (orphan-not-delete)');
        }
        return reconciled;
    }

    // Rel key of a location on `backendName` — stored://<backend>/<key> directly,
    // file://<deviceId>/<abs> via the mount root. Null when not this backend's.
    #backendLocationKey(backendName, location) {
        const parsed = parseLocationUrl(location?.url);
        if (!parsed) return null;
        if (parsed.scheme === 'stored' && parsed.backend === backendName) return parsed.key;
        if (parsed.scheme === 'file' && location.metadata?.backend === backendName) {
            const mount = this.#externalMountInfo(backendName);
            if (!mount) return null;
            const abs = path.resolve('/', String(parsed.key || ''));
            const root = path.resolve(mount.root);
            if (abs === root || abs.startsWith(root + path.sep)) return path.relative(root, abs);
        }
        return null;
    }

    // In-place edit succession: copy curated placements (all trees except the
    // backends mirror, which the successor writes itself) onto the successor
    // doc and stamp a derivedFrom breadcrumb (predecessor's primary checksum) —
    // convertible into a first-class relation edge once edge indexes land.
    async #migrateToSuccessor(oldDoc, successorFile) {
        const db = this.#getDb();
        const successorChecksum = this.#buildChecksumArray(successorFile.checksums)[0];
        if (!successorChecksum) return;
        const successor = await db.getByChecksumString(successorChecksum).catch(() => null);
        if (!successor?.id || successor.id === oldDoc.id) return;

        if (typeof db.migrateDocumentMemberships === 'function') {
            await db.migrateDocumentMemberships(oldDoc.id, successor.id, { excludeTrees: [BACKENDS_TREE_NAME] });
        }
        await this.#put({
            id: successor.id,
            metadata: { derivedFrom: oldDoc.checksumArray?.[0] || null },
        }, { context: null });
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
     * last location, #reconcileRemovedLocations orphans it (data/no-location).
     */
    async #purgeDeadBackendLocations() {
        const db = this.#getDb();
        const fileDocs = await db.list({ features: { allOf: ['data/schema/file'] } }).catch(() => []);
        let swept = 0;
        for (const doc of fileDocs) {
            if (!Array.isArray(doc.locations) || doc.locations.length === 0) { continue; }
            const deadUrls = [];
            for (const loc of doc.locations) {
                const parsed = parseLocationUrl(loc.url);
                if (!parsed) { continue; }
                let backend;
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
        // Stale-path cleanup is scoped to the backends tree: user-filed
        // placements live in other trees and must never be unlinked here.
        const currentBackendPaths = existingDocument?.id
            ? await db.listDocumentTreePaths(existingDocument.id, BACKENDS_TREE_NAME).catch(() => [])
            : [];

        const docId = await this.#put(
            existingDocument?.id ? { ...documentData, id: existingDocument.id } : documentData,
            // context:null keeps backend mirrors out of the context root — they
            // surface there only when a user files them explicitly.
            // No feature assertion: data/backend/* is DERIVED by synapsd from
            // locations[] (URL scheme+authority, or location.metadata.backend).
            { context: null, directory: this.#getBackendsTreeSelector(backendPaths) },
        );

        await this.#removeStalePaths(docId, currentBackendPaths, backendPaths);

        // In-place edit (same path, new bytes): the stored layer stamps the
        // predecessor's identity on the add event — migrate its curated
        // placements to this successor doc so a save never silently evicts a
        // promoted file from the curated tree.
        const prevChecksum = storedFile.previous?.checksums
            ? this.#buildChecksumArray(storedFile.previous.checksums)[0]
            : null;
        if (prevChecksum && prevChecksum !== primaryChecksum) {
            const predecessor = await db.getByChecksumString(prevChecksum).catch(() => null);
            if (predecessor?.id && predecessor.id !== docId && typeof db.migrateDocumentMemberships === 'function') {
                await db.migrateDocumentMemberships(predecessor.id, docId, { excludeTrees: [BACKENDS_TREE_NAME] }).catch((error) =>
                    this.#logger.warn({ workspaceId: this.#workspaceId, docId, predecessorId: predecessor.id, error: error.message }, 'Placement migration from predecessor failed'));
            }
        }
        return docId;
    }

    /**
     * Apply a location-set change (`object:move`, `object:location:add|remove`)
     * to the document behind the content. Identity is unchanged by definition —
     * the same bytes simply live somewhere else — so the document keeps its id,
     * its checksums and every curated placement it has been given.
     *
     * The stored layer suppresses its own watcher echoes for the keys it writes
     * and deletes during a transfer, so a move never also arrives here as an
     * unlink of the source path.
     *
     * `#upsertDocument` already rebuilds locations from stored's canonical list
     * and prunes stale backends-tree paths, which is exactly the required work.
     * It bails out when the target has no mirrored tree path (the managed blob
     * store is opaque by design) — in that case the locations are patched
     * directly, because a document must never keep pointing at a location the
     * object no longer has.
     */
    async #applyLocationChange(payload = {}) {
        const docId = await this.#upsertDocument(payload);
        if (docId) return docId;
        return this.#patchDocumentLocations(payload);
    }

    async #patchDocumentLocations(payload = {}) {
        const checksumArray = this.#buildChecksumArray(payload.checksums);
        if (checksumArray.length === 0) return null;

        const db = this.#getDb();
        const doc = await db.getByChecksumString(checksumArray[0]).catch(() => null);
        if (!doc?.id) return null;

        const locations = this.#buildDocumentLocations(Array.isArray(payload.locations) ? payload.locations : []);
        if (locations.length === 0) {
            // Nothing left to point at — hand over to the orphan path so the
            // no-location marker and retention semantics stay in one place.
            return this.#reconcileRemovedLocations(doc, (doc.locations || []).map((l) => l.url));
        }
        await this.#put({ id: doc.id, locations }, { context: null });
        return doc.id;
    }

    async #unlinkDocument(storedFile = {}) {
        const checksumArray = this.#buildChecksumArray(storedFile.checksums);
        if (checksumArray.length === 0) return null;
        if (!storedFile.backend || !storedFile.key) return null;

        const db = this.#getDb();
        const existingDocument = await db.getByChecksumString(checksumArray[0]).catch(() => null);
        if (!existingDocument?.id) return null;

        // Reconcile both address forms for this backend/key: mounts carry the
        // device-scoped file:// URL, workspace stores the stored:// one (and
        // docs written before the single-location switch may carry both).
        const removedUrls = [`stored://${storedFile.backend}/${storedFile.key}`];
        const twin = this.#deviceFileLocationUrl(storedFile.backend, storedFile.key);
        if (twin) removedUrls.push(twin);
        return this.#reconcileRemovedLocations(existingDocument, removedUrls);
    }

    /**
     * Public entry for other services (connector deletion-sync): drop the
     * given location URLs from a document, with the full orphan-not-delete
     * semantics of #reconcileRemovedLocations below.
     */
    async reconcileRemovedLocations(doc, removedUrls = []) {
        return this.#reconcileRemovedLocations(doc, removedUrls);
    }

    /**
     * A backing blob vanished from one or more locations. Drop those locations;
     * the doc keeps its survivors and unticks only the backends-tree path(s) the
     * dead locations backed. When NO locations survive the doc is ORPHANED,
     * never deleted: it keeps its row, checksums and curated placements, gains
     * the data/no-location feature + orphanedAt, and is purged only by
     * retention GC or explicit user action (destroy). Orphaning is what makes a
     * resync bug survivable — promotions are user intent and outrank backend
     * liveness, and an orphan-with-checksum re-binds if the bytes reappear.
     */
    async #reconcileRemovedLocations(doc, removedUrls = []) {
        const db = this.#getDb();
        const removed = new Set(removedUrls);
        const remaining = (Array.isArray(doc.locations) ? doc.locations : []).filter((l) => !removed.has(l.url));
        const currentBackendPaths = await db.listDocumentTreePaths(doc.id, BACKENDS_TREE_NAME).catch(() => []);

        if (remaining.length === 0) {
            // v3: asserted features live at the document ROOT, not under metadata.
            const features = Array.from(new Set([
                ...(Array.isArray(doc.features) ? doc.features : []),
                NO_LOCATION_FEATURE,
            ]));
            await this.#put({
                id: doc.id,
                locations: [],
                orphanedAt: doc.orphanedAt || new Date().toISOString(),
                features,
                metadata: { ...(doc.metadata || {}) },
            }, { context: null });
            // Backend-mirror paths untick (the file is no longer there); curated
            // placements in every other tree stay untouched. Thumbnails stay too
            // (checksum-keyed) — the GC purges them with the doc.
            await this.#removeStalePaths(doc.id, currentBackendPaths, []);
            return doc.id;
        }

        const survivors = remaining
            .map((l) => parseLocationUrl(l.url))
            .filter(Boolean)
            .map((p) => ({ backend: p.backend, key: p.key }));

        await this.#put({ id: doc.id, locations: remaining }, { context: null });
        await this.#removeStalePaths(doc.id, currentBackendPaths, this.#buildBackendPaths(survivors));
        return doc.id;
    }

    /**
     * Purge orphaned documents (data/no-location) whose orphanedAt exceeds the
     * retention window. retentionDays 0 purges all current orphans; negative
     * retention never purges (the default). Explicit user cleanup can also just
     * bulk-delete via the data/no-location filter.
     */
    async gcOrphanedDocuments({ retentionDays } = {}) {
        const db = this.#getDb();
        const days = Number.isFinite(retentionDays)
            ? retentionDays
            : (typeof this.#getOrphanRetentionDays === 'function' ? this.#getOrphanRetentionDays() : -1);
        if (!Number.isFinite(days) || days < 0) return { purged: 0 };

        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const orphans = await db.list({ features: { allOf: [NO_LOCATION_FEATURE] } }).catch(() => []);
        let purged = 0;
        for (const doc of orphans) {
            const orphanedAt = doc.orphanedAt ? Date.parse(doc.orphanedAt) : NaN;
            if (!Number.isFinite(orphanedAt) || orphanedAt > cutoff) continue;
            // Belt-and-braces: never GC a doc that somehow regained locations.
            if (Array.isArray(doc.locations) && doc.locations.length > 0) continue;
            await db.delete(doc.id);
            await this.purgeThumbnails([doc]).catch(() => {});
            purged += 1;
        }
        if (purged > 0) {
            this.#logger.info({ workspaceId: this.#workspaceId, purged, retentionDays: days }, 'Orphan GC: purged expired no-location documents');
        }
        return { purged };
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
    // Returns `{ data, ranged }`: `data` is a Buffer (non-stream), a Readable
    // (stream), or null on a miss; `ranged` is true only when a requested byte
    // window (`options.range = { start, end }`, inclusive end) was actually
    // served — so the HTTP layer only sends 206 when the bytes really are partial.
    async resolve(url, options = {}) {
        const parsed = parseLocationUrl(url);
        if (!parsed) throw new Error(`Unparseable location URL: ${url}`);
        const { scheme, backend, key } = parsed;

        if (scheme === 'stored') {
            if (!this.#stored) throw new Error('WorkspaceStoredIndex is not running');
            if (!options.stream) return { data: await this.#stored.getByUrl(url), ranged: false };
            if (options.range) {
                const r = await this.#stored.getRangeStreamByUrl(url, options.range);
                return { data: r?.stream ?? null, ranged: !!r?.ranged };
            }
            return { data: await this.#stored.getStreamByUrl(url), ranged: false };
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
                if (!options.stream) return { data: await fs.readFile(abs), ranged: false };
                if (options.range) {
                    return { data: createReadStream(abs, { start: options.range.start, end: options.range.end }), ranged: true };
                }
                return { data: createReadStream(abs), ranged: false };
            }
            // file://<deviceId>/<abs-path>: locally resolvable when the
            // authority is THIS server's device AND the path sits under a
            // configured external mount (never arbitrary host paths). Other
            // devices stay reference-only until a device proxy exists.
            const local = this.#resolveLocalDevicePath(backend, key);
            if (local) {
                if (!options.stream) return { data: await fs.readFile(local.abs), ranged: false };
                if (options.range) {
                    return { data: createReadStream(local.abs, { start: options.range.start, end: options.range.end }), ranged: true };
                }
                return { data: createReadStream(local.abs), ranged: false };
            }
            // Bytes live on another device (or an unconfigured mount) — an
            // expected miss, not a server fault. The code lets resolveDocument
            // treat it as "location unreachable" (404) instead of a 500.
            const err = new Error(`Device-proxy resolution not implemented for ${url}`);
            err.code = 'DEVICE_NOT_REACHABLE';
            throw err;
        }

        throw new Error(`No resolver for scheme: ${scheme}`);
    }

    // Allowed thumbnail edge sizes — a fixed set keeps the derived-artifact
    // cache bounded (no per-pixel-size explosion).
    static THUMBNAIL_SIZES = [128, 256, 512, 1024];

    /**
     * On-demand thumbnail for an image document, cached in Stored's internal
     * cacache store ({WORKSPACE_ROOT}/cache — services.stored.cache)
     * keyed `thumb:<checksum>:<size>` — derived artifacts never touch the main
     * index and the cache is purgeable at any time (purgeThumbnails on
     * delete/destroy, clearThumbnailCache for a full wipe).
     * @param {object} doc File document (metadata.contentType image/* or
     *   application/pdf — PDFs thumbnail as a raster of page 1)
     * @param {number} [size] longest-edge px, clamped to THUMBNAIL_SIZES
     * @returns {Promise<{buffer: Buffer, mime: string}|null>} null when not
     *   thumbnailable / no checksum / no reachable bytes
     */
    async getThumbnail(doc, size = 256) {
        if (!this.#stored) throw new Error('WorkspaceStoredIndex is not running');
        const contentType = String(doc?.metadata?.contentType || '');
        const isPdf = contentType === 'application/pdf';
        if (!contentType.startsWith('image/') && !isPdf) return null;
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
        // resolve() returns { data, ranged }, not the raw buffer — pass the
        // bytes to sharp, not the wrapper object (else sharp throws and the
        // thumbnail 500s for every not-yet-cached image).
        let original = null;
        for (const loc of (doc.locations || [])) {
            if (!loc?.url) continue;
            try { const res = await this.resolve(loc.url); if (res?.data) { original = res.data; break; } } catch { /* next */ }
        }
        if (!original) return null;

        const source = isPdf ? await this.#renderPdfFirstPage(original, edge) : original;
        if (!source) return null;

        const { default: sharp } = await import('sharp');
        const buffer = await sharp(source)
            .rotate() // honor EXIF orientation
            .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 80 })
            .toBuffer();
        await cache.put(cacheKey, buffer, { source: checksum, size: edge }).catch((err) =>
            this.#logger.warn({ workspaceId: this.#workspaceId, error: err.message }, 'Thumbnail cache write failed'));
        return { buffer, mime: 'image/webp' };
    }

    // Bounds for PDF first-page rasterization — a hostile or degenerate PDF
    // must not stall the request path or balloon memory.
    static PDF_THUMBNAIL_MAX_BYTES = 50 * 1024 * 1024;
    static PDF_THUMBNAIL_TIMEOUT_MS = 20_000;

    /**
     * Rasterize page 1 of a PDF to a PNG buffer using pdfjs-dist +
     * @napi-rs/canvas — a pure-JS parse (no native PDF library), with
     * embedded-script eval disabled.
     * @param {Buffer} bytes the whole PDF
     * @param {number} edge longest-edge px of the target render
     * @returns {Promise<Buffer|null>} null when oversized, unparsable, or the
     *   render exceeds the timeout
     */
    async #renderPdfFirstPage(bytes, edge) {
        if (!Buffer.isBuffer(bytes) || bytes.length === 0
            || bytes.length > WorkspaceStoredIndex.PDF_THUMBNAIL_MAX_BYTES) return null;
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), WorkspaceStoredIndex.PDF_THUMBNAIL_TIMEOUT_MS);
            timer.unref?.();
        });
        const render = (async () => {
            const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
            const { createCanvas } = await import('@napi-rs/canvas');
            const { createRequire } = await import('node:module');
            // Built-in Type1 fonts (Helvetica etc.) ship with pdfjs — without
            // this, text set in a standard font renders blank.
            const standardFontDataUrl = path.join(
                path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
                'standard_fonts',
            ) + path.sep;
            const task = getDocument({
                data: new Uint8Array(bytes),
                isEvalSupported: false,
                useSystemFonts: false,
                standardFontDataUrl,
            });
            try {
                const pdf = await task.promise;
                const page = await pdf.getPage(1);
                const base = page.getViewport({ scale: 1 });
                const scale = edge / Math.max(base.width, base.height, 1);
                const viewport = page.getViewport({ scale });
                const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
                const ctx = canvas.getContext('2d');
                // PDFs have no intrinsic background — paint the page white.
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                await page.render({ canvasContext: ctx, viewport }).promise;
                return canvas.toBuffer('image/png');
            } finally {
                task.destroy().catch(() => {});
            }
        })().catch((err) => {
            this.#logger.warn({ workspaceId: this.#workspaceId, error: err.message }, 'PDF thumbnail render failed');
            return null;
        });
        try { return await Promise.race([render, timeout]); }
        finally { clearTimeout(timer); }
    }

    /**
     * Drop cached thumbnails (all sizes) for the given documents or primary
     * checksum strings. Called from the delete/destroy paths so derived
     * artifacts never outlive their source blobs — otherwise a stale entry
     * lingers in the stored cache forever. Best-effort: cacache.rm.entry on a
     * missing key is a no-op.
     */
    async purgeThumbnails(docsOrChecksums = []) {
        if (!this.#stored) return;
        const cache = this.#stored.cache;
        for (const item of docsOrChecksums) {
            const checksum = typeof item === 'string'
                ? item
                : (Array.isArray(item?.checksumArray) ? item.checksumArray[0] : null);
            if (!checksum) continue;
            for (const edge of WorkspaceStoredIndex.THUMBNAIL_SIZES) {
                await cache.delete(`thumb:${checksum}:${edge}`).catch(() => {});
            }
        }
    }

    /**
     * Remove EVERY cached thumbnail (thumb:* entries in the stored cache). The
     * cache is a derived artifact store — thumbnails regenerate on demand, so
     * clearing is always safe. Other cache content (non-thumb keys) is left
     * untouched.
     */
    async clearThumbnailCache() {
        if (!this.#stored) throw new Error('WorkspaceStoredIndex is not running');
        const cache = this.#stored.cache;
        let removed = 0;
        for await (const entry of cache.listStream()) {
            if (typeof entry?.key === 'string' && entry.key.startsWith('thumb:')) {
                await cache.delete(entry.key).catch(() => {});
                removed++;
            }
        }
        return { removed };
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
            } else if (p?.scheme === 'file') {
                // Device-scoped path: deletable only when it's THIS device and
                // the owning mount is not read-only; foreign devices are
                // reference-drop only.
                const local = this.#resolveLocalDevicePath(p.backend, p.key);
                kind = 'device-file';
                deletable = !!local && this.#dataBackends[local.backendName]?.readOnly !== true;
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
                    if (transient) await this.#stored.removeBackend?.(p.backend);
                } else if (p?.scheme === 'file' && p.backend === '{WORKSPACE_ROOT}') {
                    await fs.rm(path.join(this.#rootPath, p.key), { force: true });
                    result.deleted.push(loc.url);
                } else if (p?.scheme === 'file' && this.#resolveLocalDevicePath(p.backend, p.key)) {
                    // Local device-scoped path on a RW external mount → wipe the
                    // bytes; read-only mount → reference drop.
                    const local = this.#resolveLocalDevicePath(p.backend, p.key);
                    if (this.#dataBackends[local.backendName]?.readOnly !== true) {
                        await fs.rm(local.abs, { force: true });
                        result.deleted.push(loc.url);
                    } else {
                        result.droppedRefs.push(loc.url);
                    }
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

        // Bytes were removed (or the doc is about to go) — the cached thumbnails
        // derive from those bytes and must not outlive them.
        if (result.deleted.length > 0 || kept.length === 0) {
            await this.purgeThumbnails([doc]).catch(() => {});
        }

        if (kept.length === 0 && doc?.id != null) {
            if (options.keepDocument === true) {
                // Caller chose to keep the index entry with no retrievable bytes
                // (locations: []) — metadata/checksums stay searchable. Marked
                // as orphaned so it's filterable and subject to retention GC.
                doc.orphanedAt = doc.orphanedAt || new Date().toISOString();
                doc.features = Array.from(new Set([...(doc.features || []), NO_LOCATION_FEATURE]));
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

        // Edit-succession breadcrumb (predecessor's primary checksum) — becomes
        // a first-class relation edge once edge indexes land.
        const prevChecksum = storedFile.previous?.checksums
            ? this.#buildChecksumArray(storedFile.previous.checksums)[0]
            : null;
        if (prevChecksum) metadata.derivedFrom = prevChecksum;

        // Inline-extracted metadata (EXIF/GPS/dimensions/media) lives on the stored
        // index entry's `custom` (surfaced via stat → meta). Merge the known keys
        // onto the doc (metadata is .catchall(z.any()) so nested objects are fine).
        const extracted = meta?.custom && typeof meta.custom === 'object' ? meta.custom : null;
        if (extracted) {
            for (const k of ['exif', 'dimensions', 'media']) {
                if (extracted[k] && typeof extracted[k] === 'object') { metadata[k] = extracted[k]; }
            }
        }
        // Geo is provenance-ranked rather than overwritten: re-upserting a file
        // whose pin a human fixed by hand must not silently revert it to the
        // camera's fix. Runs even without `extracted` so sentinel coordinates
        // ({lat:null,lon:null} -> Null Island) get dropped instead of indexed.
        const geo = pickGeo(metadata.geo, extracted?.geo, { incomingSource: 'exif' });
        if (geo) { metadata.geo = geo; } else { delete metadata.geo; }

        const doc = {
            schema: 'data/schema/file',
            checksumArray: checksumArray.length > 0 ? checksumArray : (existingDocument?.checksumArray || []),
            data: {},
            locations,
            metadata,
            // Locations exist by construction here — clear any orphan marker.
            orphanedAt: null,
            // Re-bind: this upsert carries locations, so a previously orphaned doc
            // loses its no-location marker (the feature drop unticks the bitmap).
            // v3: asserted features live at the document ROOT, so the marker is
            // dropped here rather than out of metadata.features.
            features: (Array.isArray(existingDocument?.features) ? existingDocument.features : [])
                .filter((feature) => feature !== NO_LOCATION_FEATURE),
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
            // Device-anchored fs mounts get file://<deviceId>/<abs-path> as their
            // ONLY location: it survives a workspace move (a stored:// address is
            // meaningful only on this server instance) and feeds the device/id/*
            // presence bitmaps. metadata.backend ties it to its owning backend
            // for orphan/dead-backend sweeps. stored:// stays reserved for
            // workspace-anchored stores (workspace:home, workspace:data).
            const deviceUrl = this.#deviceFileLocationUrl(backend.backend, backend.key);
            if (deviceUrl) {
                if (!seen.has(deviceUrl)) {
                    seen.add(deviceUrl);
                    locations.push({ url: deviceUrl, metadata: { backend: backend.backend } });
                }
                continue;
            }
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
     * stores (workspace:data) are opaque by design — their
     * documents are filed by the connector that persisted them (e.g. mail under
     * /imap/...). Config presence, not `enabled`, gates the path so the
     * disable-then-destroy flow can still resolve a disabled backend's subtree.
     */
    #getBackendRootPath(backendName) {
        const config = this.#dataBackends[backendName];
        if (!config || config.supported === false) return null;
        if (config.managed === true) return null;
        const driver = String(config.driver || 'file').toLowerCase();
        const live = this.#stored?.getBackend(backendName);
        // Offline/disabled backends fall back to the driver's static answer so
        // the disable-then-destroy flow still resolves the mirror subtree.
        const canEnumerate = live ? live.capabilities?.canEnumerate === true : CONTAINER_DRIVERS.has(driver);
        if (!canEnumerate) return null;
        // Case/unicode-preserving: the mount slug is user-facing ("Fotky" must
        // not become "fotky" in the tree). Only path-hostile chars are squashed.
        const address = String(backendName || '').replace(/[^\p{L}\p{N}._:@-]+/gu, '-');
        // Anchor-first mirror grammar — the first segment names what the data is
        // anchored to, not the driver (driver stays a config/API concept):
        //   /workspace/<store>        workspace-anchored (workspace:home → /workspace/home)
        //   /device/<device>/<mount>  device-anchored fs mounts (device segment is
        //                             the config snapshot — stable across renames)
        //   /<driver>/<address>       connectors/remotes (imap, s3, …)
        const deviceSegment = config.device?.name
            ? String(config.device.name).replace(/[^\p{L}\p{N}._@-]+/gu, '-')
            : null;
        if (deviceSegment) return `/device/${deviceSegment}/${address}`;
        if (backendName.startsWith('workspace:')) {
            const store = normalizeSegment(backendName.slice('workspace:'.length)).replace(/\//g, '-');
            return `/workspace/${store}`;
        }
        return `/${driver}/${address}`;
    }

    /**
     * External (device-scoped) mount info for a backend: a user-added file
     * backend rooted outside the workspace (config.device snapshot present).
     * These get a portable file://<deviceId>/<abs-path> location alongside the
     * server-local stored:// one. Returns { deviceId, root } or null.
     */
    #externalMountInfo(backendName) {
        const config = this.#dataBackends[backendName];
        if (!config || config.driver !== 'file' || !config.device?.id) return null;
        const root = config.root || '';
        if (!root || root.includes('{WORKSPACE_ROOT}')) return null;
        return { deviceId: config.device.id, root };
    }

    /** file://<deviceId>/<abs-path> twin URL for a key on an external mount (or null). */
    #deviceFileLocationUrl(backendName, key) {
        const mount = this.#externalMountInfo(backendName);
        if (!mount || !key) return null;
        return deviceFileUrl(mount.deviceId, path.join(mount.root, key));
    }

    /**
     * Map a file://<deviceId>/<path> location to a local absolute path — only
     * when the authority is this server's device and the path lies under a
     * configured external mount root (a crafted location must never read
     * arbitrary server files). Returns { abs, backendName } or null.
     */
    #resolveLocalDevicePath(deviceId, key) {
        if (!this.#device?.deviceId || deviceId !== this.#device.deviceId) return null;
        const abs = path.resolve('/', String(key || ''));
        for (const backendName of Object.keys(this.#dataBackends || {})) {
            const mount = this.#externalMountInfo(backendName);
            if (!mount) continue;
            const root = path.resolve(mount.root);
            if (abs === root || abs.startsWith(root + path.sep)) return { abs, backendName };
        }
        return null;
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
