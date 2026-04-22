'use strict';

import path from 'path';
import Stored from '../../../services/stored/src/index.js';
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
const CHECKSUM_PRIORITY = ['sha256', 'sha1', 'md5'];

export class WorkspaceStoredIndex {
    static HOME_STORED_BACKEND = HOME_STORED_BACKEND;
    static HOME_BACKEND_FEATURE = HOME_BACKEND_FEATURE;

    #dataPath;
    #homePath;
    #workspaceId;
    #logger;

    // Injected workspace operations
    #put;
    #unlink;
    #getIncomingTreeSelector;
    #getDb;

    #stored = null;
    #listeners = [];

    constructor({ dataPath, homePath, workspaceId, logger, put, unlink, getIncomingTreeSelector, getDb }) {
        if (!dataPath || !homePath) throw new Error('dataPath and homePath are required');
        if (!put || !unlink || !getIncomingTreeSelector || !getDb) throw new Error('put, unlink, getIncomingTreeSelector, getDb are required');

        this.#dataPath = dataPath;
        this.#homePath = homePath;
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

    async start() {
        if (this.#stored) return;

        try {
            this.#stored = new Stored({
                index: { path: path.join(this.#dataPath, 'stored-index') },
                checksums: ['sha256', 'md5'],
                primaryChecksum: 'sha256',
            });

            this.#stored.addBackend(HOME_STORED_BACKEND, {
                driver: 'file',
                root: this.#homePath,
                watch: true,
                provider: 'fs',
                account: 'workspace',
                container: 'workspace',
            });

            this.#bindEvents();
            await this.#syncSnapshot();
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

    async #syncSnapshot() {
        if (!this.#stored) return;
        const files = await this.#stored.scan(HOME_STORED_BACKEND);
        for (const file of files) {
            await this.#upsertDocument(file);
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
                .map((backend) => {
                    const filePath = backend?.source?.path || backend?.key || '';
                    const dir = filePath ? path.dirname(filePath) : null;
                    const suffix = (dir && dir !== '.') ? `/${dir}` : '';
                    return `${INCOMING_ROOT_CONTEXT}/file/fs/workspace${suffix}`;
                })
        ));
    }

    #buildFeatures(backends = []) {
        const features = [];
        for (const backend of backends) {
            if (backend.backend === HOME_STORED_BACKEND) features.push(HOME_BACKEND_FEATURE);
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
}
