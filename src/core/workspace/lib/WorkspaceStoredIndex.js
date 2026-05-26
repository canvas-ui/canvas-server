'use strict';

import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import Stored from '../../../services/stored/src/index.js';
import { parseLocationUrl } from '../../../services/synapsd/src/utils/path-helpers.js';
import { INCOMING_ROOT_CONTEXT } from '../../../utils/incoming-documents.js';

/*
 * WorkspaceStoredIndex — watches a workspace home directory and syncs file
 * metadata into the workspace DB as incoming documents.
 *
 * Fully decoupled from Workspace: takes explicit dependencies so it can be
 * instantiated standalone in any bun/node runtime.
 */

const HOME_STORED_BACKEND = 'fs:home';
const HOME_BACKEND_FEATURE = 'data/backend/home';
const CACHE_BACKEND = 'stored.cache';
const DATA_STORED_BACKEND_PREFIX = 'fs:data';
const CHECKSUM_PRIORITY = ['sha256', 'sha1', 'md5'];

export class WorkspaceStoredIndex {
    static HOME_STORED_BACKEND = HOME_STORED_BACKEND;
    static HOME_BACKEND_FEATURE = HOME_BACKEND_FEATURE;
    static CACHE_BACKEND = CACHE_BACKEND;
    static DATA_STORED_BACKEND_PREFIX = DATA_STORED_BACKEND_PREFIX;

    static dataBackendName(abstraction) {
        return `${DATA_STORED_BACKEND_PREFIX}:${abstraction}`;
    }

    static dataBackendRoot(dataPath, abstraction) {
        // Email uses an RFC-aligned layout rooted directly at data/email/<account>/<folder>/…
        // (RFC 5322 bodies) instead of the generic data/abstraction/<x> tree.
        if (abstraction === 'email') return path.join(dataPath, 'email');
        return path.join(dataPath, 'abstraction', abstraction);
    }

    static dataBackendFeature(abstraction) {
        return `data/backend/data:${abstraction}`;
    }

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
    #getIncomingTreeSelector;
    #getDb;

    #stored = null;
    #listeners = [];
    #registeredDataBackends = new Set();
    #backendStatus = new Map();

    constructor({ rootPath, cachePath, dataPath, homePath, dataBackends = {}, workspaceId, logger, put, unlink, getIncomingTreeSelector, getDb }) {
        if (!dataPath || !homePath) throw new Error('dataPath and homePath are required');
        if (!put || !unlink || !getIncomingTreeSelector || !getDb) throw new Error('put, unlink, getIncomingTreeSelector, getDb are required');

        this.#rootPath = rootPath || path.dirname(dataPath);
        this.#cachePath = cachePath || path.join(this.#rootPath, 'cache');
        this.#dataPath = dataPath;
        this.#homePath = homePath;
        this.#dataBackends = dataBackends;
        this.#workspaceId = workspaceId;
        this.#logger = logger || console;
        this.#put = put;
        this.#unlink = unlink;
        this.#getIncomingTreeSelector = getIncomingTreeSelector;
        this.#getDb = getDb;
    }

    get isRunning() {
        return this.#stored !== null;
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

    /**
     * Evict a file from one or more storage backends.
     * checksumString: DB-format primary checksum e.g. "sha256/abc123"
     * targetBackends: optional array of backend names; if omitted, evicts from all
     * Returns { deleted: string[], remainingBackends: string[] }
     */
    async evict(checksumString, targetBackends = null) {
        if (!this.#stored) return { deleted: [], remainingBackends: [] };

        // Stored uses colon-separated keys: "sha256:hash"
        const storedKey = checksumString.replace('/', ':');

        if (!this.#stored.has(storedKey)) return { deleted: [], remainingBackends: [] };

        const options = targetBackends ? { backends: targetBackends } : {};
        const result = await this.#stored.delete(storedKey, options);

        const updatedMeta = this.#stored.stat(storedKey);
        return {
            deleted: result.deleted,
            remainingBackends: updatedMeta?.locations?.map(l => l.backend) || [],
        };
    }

    async start() {
        if (this.#stored) return;

        try {
            this.#stored = new Stored({
                index: { path: path.join(this.#dataPath, 'stored-index') },
                cache: { path: this.#cachePath },
                checksums: ['sha256', 'md5'],
                primaryChecksum: 'sha256',
            });

            await this.#registerConfiguredBackends();

            this.#bindEvents();
            await this.resync(HOME_STORED_BACKEND).catch((error) => {
                this.#setBackendError(HOME_STORED_BACKEND, error);
                this.#logger.warn({ workspaceId: this.#workspaceId, error: error.message }, 'Stored home resync failed');
            });
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
            this.#registeredDataBackends.clear();
            this.#backendStatus.clear();
        }
    }

    async resync(backendName = HOME_STORED_BACKEND) {
        if (!this.#stored) throw new Error('WorkspaceStoredIndex is not running');
        const config = this.#dataBackends[backendName];
        if (!config?.enabled) throw new Error(`Data backend "${backendName}" is disabled`);
        if (!config?.resync) throw new Error(`Data backend "${backendName}" does not support resync`);
        if (!this.#stored.getBackend(backendName)) throw new Error(`Data backend "${backendName}" is not registered`);

        const files = await this.#stored.scan(backendName);
        for (const file of files) {
            await this.#upsertDocument(file);
        }
        await this.#purgeOrphanedPaths(backendName, files);
        this.#backendStatus.set(backendName, {
            ...(this.#backendStatus.get(backendName) || {}),
            lastScanAt: new Date().toISOString(),
            lastError: null,
            fileCount: files.length,
        });
        return { backend: backendName, count: files.length };
    }

    /**
     * Ensure a per-abstraction data backend is registered and its root directory exists.
     * Returns the backend name (e.g. 'fs:data:file').
     * Upstream is responsible for writing files and calling the DB indexing APIs.
     */
    async ensureDataBackend(abstraction) {
        if (!this.#stored) throw new Error('WorkspaceStoredIndex is not running');

        const backendName = WorkspaceStoredIndex.dataBackendName(abstraction);
        if (this.#registeredDataBackends.has(backendName)) return backendName;

        const root = WorkspaceStoredIndex.dataBackendRoot(this.#dataPath, abstraction);
        await fs.mkdir(root, { recursive: true });

        this.#stored.addBackend(backendName, {
            driver: 'file',
            root,
            watch: false,
            provider: 'fs',
            account: 'workspace',
            container: abstraction,
        });

        this.#registeredDataBackends.add(backendName);
        return backendName;
    }

    async #registerConfiguredBackends() {
        for (const [backendName, config] of Object.entries(this.#dataBackends || {})) {
            if (!config?.enabled || config.supported === false || config.driver !== 'file') continue;
            if (backendName === CACHE_BACKEND) continue;

            this.#stored.addBackend(backendName, {
                ...config,
                root: this.#resolveBackendRoot(backendName, config),
                provider: config.provider || 'fs',
                account: config.account || 'workspace',
                container: config.container || (backendName === HOME_STORED_BACKEND ? 'home' : 'data'),
            });
            this.#backendStatus.set(backendName, { lastScanAt: null, lastError: null });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Event binding
    // ─────────────────────────────────────────────────────────────────────────

    #bindEvents() {
        this.#unbindEvents();
        if (!this.#stored?.on) return;

        const eventMap = {
            'file:add': (payload) => this.#upsertDocument(payload),
            'file:change': (payload) => this.#upsertDocument(payload),
            'file:unlink': (payload) => this.#unlinkDocument(payload),
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

        const incomingRoot = this.#getIncomingRootForBackend(backendName);
        if (!incomingRoot) return;
        const treeSelector = this.#getIncomingTreeSelector(incomingRoot);
        const docsInTree = await db.list({ directory: treeSelector }).catch(() => []);

        for (const doc of docsInTree) {
            const primaryChecksum = doc.checksumArray?.[0];
            if (!primaryChecksum || presentChecksums.has(primaryChecksum)) continue;

            const currentPaths = await db.listDocumentTreePaths(doc.id, 'incoming').catch(() => []);
            await this.#removeStalePaths(doc.id, currentPaths, []);
        }
    }

    async #upsertDocument(storedFile = {}) {
        const checksumArray = this.#buildChecksumArray(storedFile.checksums);
        if (checksumArray.length === 0) return null;

        const meta = this.#getMeta(storedFile);
        const backends = this.#resolveLocations(storedFile, meta, true);
        const incomingPaths = this.#buildIncomingPaths(backends);
        if (incomingPaths.length === 0) return null;

        const db = this.#getDb();
        const primaryChecksum = checksumArray[0];
        const existingDocument = await db.getByChecksumString(primaryChecksum).catch(() => null);
        const documentData = this.#buildDocument(storedFile, checksumArray, backends, existingDocument);
        const features = this.#buildFeatures(backends);
        const currentIncomingPaths = existingDocument?.id
            ? await db.listDocumentTreePaths(existingDocument.id, 'incoming').catch(() => [])
            : [];

        const docId = await this.#put(
            existingDocument?.id ? { ...documentData, id: existingDocument.id } : documentData,
            { directory: this.#getIncomingTreeSelector(incomingPaths), features },
        );

        await this.#removeStalePaths(docId, currentIncomingPaths, incomingPaths);
        return docId;
    }

    async #unlinkDocument(storedFile = {}) {
        const checksumArray = this.#buildChecksumArray(storedFile.checksums);
        if (checksumArray.length === 0) return null;

        const db = this.#getDb();
        const existingDocument = await db.getByChecksumString(checksumArray[0]).catch(() => null);
        if (!existingDocument?.id) return null;

        const meta = this.#getMeta(storedFile);
        const backends = this.#resolveLocations(storedFile, meta, false);
        const incomingPaths = this.#buildIncomingPaths(backends);
        const currentIncomingPaths = await db.listDocumentTreePaths(existingDocument.id, 'incoming').catch(() => []);
        const documentData = this.#buildDocument(storedFile, checksumArray, backends, existingDocument);
        const features = this.#buildFeatures(backends);

        await this.#put({ ...documentData, id: existingDocument.id }, { features });
        await this.#removeStalePaths(existingDocument.id, currentIncomingPaths, incomingPaths);
        return existingDocument.id;
    }

    async #removeStalePaths(docId, currentPaths = [], nextPaths = []) {
        const stalePaths = currentPaths.filter((p) => !nextPaths.includes(p));
        for (const directory of stalePaths) {
            await this.#unlink(docId, { directory: this.#getIncomingTreeSelector(directory) });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Builders
    // ─────────────────────────────────────────────────────────────────────────

    #getMeta(storedFile = {}) {
        if (!this.#stored) return null;
        if (storedFile.id && this.#stored.has(storedFile.id)) return this.#stored.stat(storedFile.id);
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
            // A data backend (e.g. fs:data:email) may not be registered yet —
            // register it lazily so reads work after a fresh start.
            if (!this.#stored.getBackend(backend) && this.#isDataBackend(backend)) {
                const abstraction = backend.slice(`${DATA_STORED_BACKEND_PREFIX}:`.length);
                if (abstraction) await this.ensureDataBackend(abstraction);
            }
            return this.#stored.getByUrl(url, options);
        }

        if (scheme === 'file') {
            if (backend === '{WORKSPACE_ROOT}') {
                const abs = path.join(this.#rootPath, key);
                return options.stream ? createReadStream(abs) : fs.readFile(abs);
            }
            throw new Error(`Device-proxy resolution not implemented for ${url}`);
        }

        throw new Error(`No resolver for scheme: ${scheme}`);
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

    #buildIncomingPaths(backends = []) {
        return Array.from(new Set(
            backends
                .filter(Boolean)
                .filter((backend) => this.#shouldIndexIncoming(backend.backend))
                .map((backend) => {
                    const root = this.#getIncomingRootForBackend(backend.backend);
                    if (!root) return null;
                    const filePath = backend?.source?.path || backend?.key || '';
                    const mode = this.#dataBackends[backend.backend]?.incomingPathMode || 'sourceDirectories';
                    if (mode !== 'sourceDirectories') return root;
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
            } else if (this.#isDataBackend(backend.backend)) {
                const abstraction = backend.backend.slice(`${DATA_STORED_BACKEND_PREFIX}:`.length);
                features.push(abstraction ? WorkspaceStoredIndex.dataBackendFeature(abstraction) : 'data/backend/data');
            }
            if (backend?.source?.provider) features.push(`data/source/${backend.source.provider}`);
        }
        return Array.from(new Set(features));
    }

    #buildDocument(storedFile = {}, checksumArray = [], backends = [], existingDocument = null) {
        const key = storedFile.key || existingDocument?.data?.path || '';
        const filename = key ? path.basename(key) : (existingDocument?.data?.filename || 'file');
        const size = Number.isFinite(storedFile.size) ? storedFile.size : existingDocument?.data?.size;
        const mimeType = storedFile.mimeType || existingDocument?.data?.mime;

        const data = {
            ...(existingDocument?.data || {}),
            filename,
            path: key,
            backend: storedFile.backend || existingDocument?.data?.backend || HOME_STORED_BACKEND,
        };

        if (Number.isFinite(size)) data.size = size; else delete data.size;
        if (typeof mimeType === 'string' && mimeType.length > 0) data.mime = mimeType; else delete data.mime;

        return {
            schema: 'data/abstraction/file',
            checksumArray: checksumArray.length > 0 ? checksumArray : (existingDocument?.checksumArray || []),
            data,
            locations: this.#buildDocumentLocations(backends),
            metadata: {
                ...(existingDocument?.metadata || {}),
                backends,
            },
        };
    }

    #buildDocumentLocations(backends = []) {
        return Array.from(
            new Map(
                backends.flatMap((backend) => {
                    if (!backend?.key) return [];
                    const entries = [];
                    if (backend.backend === HOME_STORED_BACKEND) {
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

    #isDataBackend(backendName) {
        return backendName === DATA_STORED_BACKEND_PREFIX || (typeof backendName === 'string' && backendName.startsWith(`${DATA_STORED_BACKEND_PREFIX}:`));
    }

    #resolveBackendRoot(backendName, config = {}) {
        const configuredRoot = config.root || '';
        if (configuredRoot.includes('{WORKSPACE_ROOT}')) {
            return configuredRoot.replaceAll('{WORKSPACE_ROOT}', this.#rootPath);
        }
        if (backendName === HOME_STORED_BACKEND) return this.#homePath;
        if (backendName === DATA_STORED_BACKEND_PREFIX) return this.#dataPath;
        return configuredRoot || this.#dataPath;
    }

    #shouldIndexIncoming(backendName) {
        return this.#dataBackends[backendName]?.indexIncoming === true;
    }

    #getIncomingRootForBackend(backendName) {
        const config = this.#dataBackends[backendName];
        if (!config?.indexIncoming) return null;
        if (backendName === HOME_STORED_BACKEND) return `${INCOMING_ROOT_CONTEXT}/fs/home`;
        const source = String(backendName || '').replace(/[^a-z0-9._:-]+/gi, '-').toLowerCase();
        return `${INCOMING_ROOT_CONTEXT}/${source}`;
    }

    #setBackendError(backendName, error) {
        this.#backendStatus.set(backendName, {
            ...(this.#backendStatus.get(backendName) || {}),
            lastError: error?.message || String(error),
        });
    }
}
