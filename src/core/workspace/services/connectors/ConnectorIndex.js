'use strict';

import EventEmitter from 'eventemitter2';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { getBackendFileContext, normalizeSegment } from '../../../../utils/backend-documents.js';
import {
    getConnectorDriver,
    isConnectorDriver,
    connectorSecretKeys,
    connectorDriverForProvenanceUrl,
    ALL_SECRET_KEYS,
} from './registry.js';

/*
 * WorkspaceConnectorIndex
 *
 * Per-workspace connector service for poll-based external sources — GitHub
 * issues, Slack channels, Google Calendar, MS Teams. Sibling of the mail
 * service (services/imap): config lives in config/stored.json (backends map,
 * keyed `<driver>:<address>`), synced documents are filed ONLY into the
 * backends tree (/github/<address>/<owner>/<repo>, /slack/<address>/<channel>,
 * …), and the uniform workspace-service event contract is emitted for the
 * Workspace to forward (object:add | source:state | error).
 *
 * Identity model (see docs/connectors.md): remote objects are mutable, so
 * every synced document's checksumArray is the sha256 of its canonical
 * provenance URL — synapsd's checksum dedup then makes every re-sync an
 * UPSERT of the same document, with no side-car remoteId→docId state to lose.
 *
 * Cursors are persisted per container in the backend's stored.json entry and
 * only advance after a successful put — a failed index never skips items.
 */

const DEFAULT_POLL_INTERVAL = 300_000;
// Unauthenticated GitHub gets 60 req/h — poll slowly unless a token is set.
const MIN_POLL_INTERVAL = 60_000;
const MAX_BACKOFF = 3_600_000;

export class WorkspaceConnectorIndex extends EventEmitter {
    #rootPath;
    #workspaceId;
    #logger;

    // Injected dependencies (same seams as the mail service)
    #put;
    #getBackendsTreeSelector;
    #insertBackendPath;
    #lockBackendNode;
    #unlockBackendNode;
    // Deletion-sync seams (all three required for pruneRemoved to act)
    #listDocumentIdsUnderBackendPath;
    #getDocumentsByIdArray;
    #reconcileRemovedLocations;

    #started = false;
    #backends = new Map(); // name (`<driver>:<address>`) -> { driver, address, config, instance }
    #status = new Map();   // name -> { syncing, lastSyncAt, lastError, backoff }
    #timers = new Map();   // name -> timeout handle

    constructor({ rootPath, workspaceId, logger, put, getBackendsTreeSelector, insertBackendPath = null, lockBackendNode = null, unlockBackendNode = null, listDocumentIdsUnderBackendPath = null, getDocumentsByIdArray = null, reconcileRemovedLocations = null }) {
        super({ wildcard: true, delimiter: '.', maxListeners: 100 });
        if (!rootPath) throw new Error('rootPath is required');
        if (!put || !getBackendsTreeSelector) throw new Error('put and getBackendsTreeSelector are required');
        this.#rootPath = rootPath;
        this.#workspaceId = workspaceId;
        this.#logger = logger || console;
        this.#put = put;
        this.#getBackendsTreeSelector = getBackendsTreeSelector;
        this.#insertBackendPath = insertBackendPath;
        this.#lockBackendNode = lockBackendNode;
        this.#unlockBackendNode = unlockBackendNode;
        this.#listDocumentIdsUnderBackendPath = listDocumentIdsUnderBackendPath;
        this.#getDocumentsByIdArray = getDocumentsByIdArray;
        this.#reconcileRemovedLocations = reconcileRemovedLocations;
    }

    get isRunning() { return this.#started; }

    async start() {
        if (this.#started) return;
        this.#started = true;
        try {
            const { backends } = await this.readStoredConfig();
            for (const [name, config] of Object.entries(backends)) {
                if (config?.enabled === false) continue;
                if (!isConnectorDriver(config?.driver)) continue;
                this.#register(name, config);
            }
            for (const name of this.#backends.keys()) this.#kickSync(name);
        } catch (error) {
            this.#logger.warn({ workspaceId: this.#workspaceId, error: error.message }, 'Connector service unavailable');
            await this.stop();
        }
    }

    async stop() {
        for (const timer of this.#timers.values()) clearTimeout(timer);
        this.#timers.clear();
        for (const name of [...this.#backends.keys()]) this.#unregister(name);
        this.#backends.clear();
        this.#status.clear();
        this.#started = false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Backend registry
    // ─────────────────────────────────────────────────────────────────────────

    #register(name, config) {
        if (this.#backends.has(name)) return this.#backends.get(name);
        const Driver = getConnectorDriver(config.driver);
        const address = normalizeSegment(config.address || name.split(':').slice(1).join(':'));
        const entry = {
            driver: config.driver,
            address,
            config,
            instance: new Driver(address, config, { logger: this.#logger }),
        };
        this.#backends.set(name, entry);
        this.#status.set(name, { syncing: false, lastSyncAt: config.lastSyncAt || null, lastError: null, backoff: 0 });
        this.#applyNodeLock(entry, true, name);
        return entry;
    }

    #unregister(name) {
        const entry = this.#backends.get(name);
        if (!entry) return;
        const timer = this.#timers.get(name);
        if (timer) { clearTimeout(timer); this.#timers.delete(name); }
        this.#applyNodeLock(entry, false, name);
        this.#backends.delete(name);
        this.#status.delete(name);
    }

    // Enable-lock the /<driver>/<address> mirror node while the connector is
    // registered (same guard-rail semantics as imap account nodes).
    #applyNodeLock(entry, locked, holder) {
        const hook = locked ? this.#lockBackendNode : this.#unlockBackendNode;
        if (!hook) return;
        const nodePath = `/${normalizeSegment(entry.driver)}/${normalizeSegment(entry.address)}`;
        // The mirror node must exist before it can be locked (first enable on a
        // fresh backend races the first synced document otherwise).
        const ensure = (locked && this.#insertBackendPath)
            ? Promise.resolve(this.#insertBackendPath(nodePath)).catch(() => {})
            : Promise.resolve();
        ensure.then(() => hook(nodePath, holder)).catch((err) =>
            this.#logger.warn({ workspaceId: this.#workspaceId, backend: holder, error: err.message }, 'Connector node lock update failed'));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Facade surface (Workspace backend CRUD dispatches here)
    // ─────────────────────────────────────────────────────────────────────────

    listBackends() {
        return [...this.#backends.entries()].map(([name, entry]) => this.#descriptor(name, entry));
    }

    async listStoredBackends() {
        // Includes disabled entries (not registered) so the settings UI can
        // re-enable them.
        const { backends } = await this.readStoredConfig();
        const out = [];
        for (const [name, config] of Object.entries(backends)) {
            if (!isConnectorDriver(config?.driver)) continue;
            const live = this.#backends.get(name);
            out.push(live ? this.#descriptor(name, live) : this.#descriptor(name, {
                driver: config.driver,
                address: normalizeSegment(config.address || name.split(':').slice(1).join(':')),
                config,
                instance: null,
            }));
        }
        return out;
    }

    #descriptor(name, entry) {
        const status = this.#status.get(name) || {};
        const { config } = entry;
        return {
            driver: entry.driver,
            address: entry.address,
            kind: 'connector',
            enabled: config.enabled !== false,
            status: status.syncing ? 'syncing' : (status.lastError ? 'error' : (entry.instance ? 'running' : 'stopped')),
            lastSyncAt: status.lastSyncAt || config.lastSyncAt || null,
            lastError: status.lastError || null,
            treePath: `/${normalizeSegment(entry.driver)}/${normalizeSegment(entry.address)}`,
            // Declared by the driver class (BaseConnector.capabilities()) —
            // never re-derived here, so a new driver needs no edit in this file.
            capabilities: entry.instance
                ? entry.instance.capabilities()
                : { sync: true, test: true, containers: true, mutableContainers: false, deleteObject: false, prune: false, write: false, update: false, delete: false },
            // Secrets are redacted; the settings panel only needs to know they
            // are set.
            config: this.#redactConfig(config),
            containers: Object.keys(config.cursors || {}).map((id) => ({
                name: id,
                enabled: true,
                lastCursor: config.cursors[id] ?? null,
            })),
        };
    }

    // Secret keys come from the driver's configFields — a new driver declaring
    // `secret: true` is redacted without touching this file.
    #redactConfig(config = {}) {
        const declared = connectorSecretKeys(config.driver);
        const secrets = new Set(declared.length ? declared : ALL_SECRET_KEYS);
        const out = {};
        for (const [key, value] of Object.entries(config)) {
            if (key === 'cursors') continue;
            out[key] = secrets.has(key) ? Boolean(value) : value;
        }
        return out;
    }

    /**
     * Create or update a connector backend. Secrets already stored are kept
     * when the patch passes `true` (the redacted marker) or omits them.
     */
    async saveBackend(driver, input = {}) {
        if (!isConnectorDriver(driver)) throw new Error(`Unknown connector driver: ${driver}`);
        const address = normalizeSegment(input.address || input.name || '');
        if (!address || address === 'unknown') throw new Error(`${driver} backend requires an address (account label)`);
        const name = `${driver}:${address}`;

        const { backends } = await this.readStoredConfig();
        const previous = backends[name] || {};
        const merged = { ...previous, ...input, driver, address };
        // Redacted secret markers (`true`) mean "keep what is stored".
        for (const key of connectorSecretKeys(driver)) {
            if (merged[key] === true || merged[key] === undefined) {
                if (previous[key]) merged[key] = previous[key]; else delete merged[key];
            }
        }
        merged.cursors = previous.cursors || {};
        await this.patchStoredBackend(name, merged);

        // Hot-swap the live instance and kick a sync when enabled.
        this.#unregister(name);
        if (merged.enabled !== false) {
            this.#register(name, merged);
            this.#kickSync(name);
        }
        return this.#descriptor(name, this.#backends.get(name) || { driver, address, config: merged, instance: null });
    }

    async removeBackend(driver, address) {
        const name = `${driver}:${normalizeSegment(address)}`;
        this.#unregister(name);
        const config = await this.readStoredConfig();
        if (!config.backends[name]) return false;
        delete config.backends[name];
        await this.writeStoredConfig(config);
        return true;
    }

    async testBackend(driver, address) {
        const entry = this.#backends.get(`${driver}:${normalizeSegment(address)}`);
        if (!entry?.instance) throw new Error(`Connector not enabled: ${driver}/${address}`);
        await entry.instance.test();
        return { ok: true };
    }

    async listContainers(driver, address) {
        const entry = this.#backends.get(`${driver}:${normalizeSegment(address)}`);
        if (!entry?.instance) throw new Error(`Connector not enabled: ${driver}/${address}`);
        return entry.instance.listContainers();
    }

    /**
     * Write-back: create a document in a connector container (v1: caldav
     * events). The remote is created FIRST; its returned mirror document is
     * then ingested through the normal pipeline, so the new event shows up in
     * Canvas immediately with correct provenance + identity checksum.
     */
    async createDocument(driver, address, containerId, payload = {}) {
        const { entry, name } = this.#writableEntry(driver, address, 'createDocument');
        const container = await this.#resolveContainer(entry, driver, address, containerId);

        const created = await entry.instance.createDocument(container, payload);
        let docId = null;
        if (created?.document) {
            docId = await this.#ingest(name, entry, container, created.document);
        }
        return { uid: created?.uid, href: created?.href, docId };
    }

    /**
     * Write-back: update the remote object behind a synced document. The
     * caller (Workspace facade) resolves the local doc and passes its
     * provenance URL; the driver's returned mirror is re-ingested (same
     * identity checksum → clean upsert).
     */
    async updateDocument(driver, address, { provenanceUrl, containerId = null }, patch = {}, { features = [] } = {}) {
        const { entry, name } = this.#writableEntry(driver, address, 'updateDocument');
        const container = await this.#resolveContainer(entry, driver, address, containerId, provenanceUrl);
        const updated = await entry.instance.updateDocument(container, provenanceUrl, patch);
        let docId = null;
        if (updated?.document) {
            // `features` carries any tags the caller sent with the same edit —
            // the write-through path must not drop them just because the write
            // took a detour through the source.
            docId = await this.#ingest(name, entry, container, updated.document, { features });
        }
        return { docId, remote: updated?.remote ?? null };
    }

    /**
     * Write-back: delete (or the driver's closest equivalent — GitHub issues
     * cannot be deleted via REST, so the driver closes as not_planned) the
     * remote object. Returns { removedRemote, document? } — a returned
     * document means the remote still exists in a terminal state and gets
     * re-ingested; removedRemote true with no document means the caller
     * should drop the local mirror.
     */
    async deleteDocument(driver, address, { provenanceUrl, containerId = null }) {
        const { entry, name } = this.#writableEntry(driver, address, 'deleteDocument');
        const container = await this.#resolveContainer(entry, driver, address, containerId, provenanceUrl);
        const result = await entry.instance.deleteDocument(container, provenanceUrl);
        if (result?.document) {
            await this.#ingest(name, entry, container, result.document);
        }
        return { removedRemote: result?.removedRemote === true, hasMirror: Boolean(result?.document) };
    }

    // Resolve a registered backend for a write verb. Capability comes from the
    // driver class's `supports` + its canWrite gate — BaseConnector's default
    // implementations throw ConnectorNotSupportedError, so an unsupported verb
    // is caught here with a clearer message either way.
    #writableEntry(driver, address, verb) {
        const name = `${driver}:${normalizeSegment(address)}`;
        const entry = this.#backends.get(name);
        if (!entry?.instance) throw new Error(`Connector not enabled: ${driver}/${address}`);
        if (!entry.instance.canWrite) throw new Error(`Connector ${driver}/${address} is read-only`);
        const capability = { createDocument: 'create', updateDocument: 'update', deleteDocument: 'delete' }[verb];
        if (capability && entry.instance.supports[capability] !== true) {
            throw new Error(`Connector ${driver}/${address} does not support ${verb}`);
        }
        return { entry, name };
    }

    async #resolveContainer(entry, driver, address, containerId, provenanceUrl = null) {
        // No explicit container: derive it from the provenance URL (drivers
        // know their own scheme layout).
        const id = containerId
            ?? (provenanceUrl ? entry.instance.containerIdFromProvenance(provenanceUrl) : null);
        if (!id) throw new Error(`Cannot resolve container on ${driver}/${address}`);
        const containers = await entry.instance.listContainers();
        const container = containers.find((c) => c.id === id || c.name === id);
        if (!container) throw new Error(`Container "${id}" not found on ${driver}/${address}`);
        return container;
    }

    /**
     * Which registered backend owns this provenance URL?
     *
     * `hint` is the `<driver>:<address>` recorded on the document at ingest —
     * exact and free. Documents synced before that was recorded fall back to
     * the driver's registered backends: a single one is unambiguous, otherwise
     * the container has to decide. Returns null when nothing owns the URL,
     * which the caller must read as "this is not a live mirror" and leave the
     * document alone.
     */
    async resolveBackendForProvenance(provenanceUrl, hint = null) {
        const driver = connectorDriverForProvenanceUrl(provenanceUrl);
        if (!driver) return null;

        if (hint && this.#backends.has(hint)) {
            const entry = this.#backends.get(hint);
            if (entry.driver === driver) return { driver, address: entry.address, name: hint };
        }

        const candidates = [...this.#backends.entries()].filter(([, e]) => e.driver === driver);
        if (candidates.length === 0) return null;
        if (candidates.length === 1) {
            const [name, entry] = candidates[0];
            return { driver, address: entry.address, name };
        }
        for (const [name, entry] of candidates) {
            const containerId = entry.instance.containerIdFromProvenance(provenanceUrl);
            if (!containerId) continue;
            const containers = await entry.instance.listContainers().catch(() => []);
            if (containers.some((c) => c.id === containerId || c.name === containerId)) {
                return { driver, address: entry.address, name };
            }
        }
        return null;
    }

    /** Can this backend push the given verb back to its source right now? */
    supportsWrite(driver, address, verb = 'update') {
        const entry = this.#backends.get(`${driver}:${normalizeSegment(address)}`);
        if (!entry?.instance) return false;
        return entry.instance.capabilities()[verb] === true;
    }

    async resync(driver, address) {
        const name = `${driver}:${normalizeSegment(address)}`;
        if (!this.#backends.has(name)) throw new Error(`Connector not found: ${driver}/${address}`);
        this.#kickSync(name, { immediate: true });
        return { started: true };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sync loop
    // ─────────────────────────────────────────────────────────────────────────

    #pollInterval(entry) {
        const configured = Number(entry.config.pollInterval);
        if (Number.isFinite(configured) && configured >= MIN_POLL_INTERVAL) return configured;
        // Unauthenticated GitHub: keep well inside the 60 req/h budget.
        if (entry.driver === 'github' && !entry.config.token) return 900_000;
        return DEFAULT_POLL_INTERVAL;
    }

    #schedule(name, delay) {
        if (!this.#started) return;
        const existing = this.#timers.get(name);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => { this.#timers.delete(name); this.#kickSync(name); }, delay);
        if (typeof timer.unref === 'function') timer.unref();
        this.#timers.set(name, timer);
    }

    // Run a backend sync in the background and reschedule. Errors back off
    // exponentially (capped); success restores the poll cadence.
    #kickSync(name, { immediate = false } = {}) {
        const entry = this.#backends.get(name);
        const status = this.#status.get(name);
        if (!entry || !status) return;
        if (status.syncing) { if (immediate) status.rerun = true; return; }
        status.syncing = true;

        this.#syncBackend(name, entry)
            .then(() => {
                status.lastError = null;
                status.backoff = 0;
                status.lastSyncAt = new Date().toISOString();
                this.emit('source:state', { source: name, lastSyncAt: status.lastSyncAt });
            })
            .catch((error) => {
                status.lastError = error?.message || String(error);
                status.backoff = Math.min(MAX_BACKOFF, (status.backoff || this.#pollInterval(entry)) * 2);
                this.#logger.warn({ workspaceId: this.#workspaceId, backend: name, error: status.lastError }, 'Connector sync failed');
                this.emit('error', { source: name, error: status.lastError });
            })
            .finally(() => {
                status.syncing = false;
                const rerun = status.rerun;
                status.rerun = false;
                this.#schedule(name, rerun ? 0 : (status.backoff || this.#pollInterval(entry)));
            });
    }

    async #syncBackend(name, entry) {
        const containers = await entry.instance.listContainers();
        for (const container of containers) {
            await this.#syncContainer(name, entry, container);
        }
    }

    async #syncContainer(name, entry, container) {
        const cursors = entry.config.cursors || (entry.config.cursors = {});
        let cursor = cursors[container.id] ?? null;

        // Page until the driver reports done; persist the cursor only after
        // every document of the page landed.
        for (let page = 0; page < 100; page++) {
            const { documents = [], nextCursor = cursor, done = true } =
                await entry.instance.fetchChanges(container, cursor);

            for (const spec of documents) {
                await this.#ingest(name, entry, container, spec);
            }

            if (nextCursor !== cursor) {
                cursor = nextCursor;
                cursors[container.id] = cursor;
                await this.patchStoredBackend(name, { cursors, lastSyncAt: new Date().toISOString() });
            }
            if (done) break;
        }

        // Deletion-sync (opt-in): after a clean incremental sync, mirror
        // source-side removals. A prune failure never fails the sync.
        if (entry.config.pruneRemoved === true) {
            await this.#pruneContainer(name, entry, container).catch((error) =>
                this.#logger.warn({ workspaceId: this.#workspaceId, backend: name, container: container.id, error: error.message }, 'Connector prune failed'));
        }
    }

    /**
     * Mirror source-side deletions: drop the locations of indexed documents
     * whose remote object no longer exists, using the stored index's
     * orphan-not-delete semantics (doc keeps curated placements, gains
     * orphanedAt + feature/orphaned, purged later by retention GC).
     *
     * Guard rails:
     * - Only drivers that can FULLY traverse the source (listIdentities);
     *   any API error there skips the prune — a partial listing must never
     *   masquerade as "these are all".
     * - Only docs whose identity checksum derives from their provenance URL
     *   (i.e. connector-ingested) are ever touched.
     * - An empty source listing against a non-empty mirror is refused —
     *   a wiped repo/calendar is rare, a misbehaving API is not.
     */
    async #pruneContainer(name, entry, container) {
        const { instance } = entry;
        if (instance?.supports?.prune !== true) return; // driver can't traverse the source
        if (!this.#listDocumentIdsUnderBackendPath || !this.#getDocumentsByIdArray || !this.#reconcileRemovedLocations) return;

        const liveUrls = await instance.listIdentities(container);
        if (!Array.isArray(liveUrls)) return;
        const live = new Set(liveUrls.map((url) => WorkspaceConnectorIndex.identityChecksum(url)));

        const rootPath = `/${normalizeSegment(entry.driver)}/${normalizeSegment(entry.address)}`;
        const ids = await this.#listDocumentIdsUnderBackendPath(rootPath);
        if (!Array.isArray(ids) || ids.length === 0) return;
        const docs = await this.#getDocumentsByIdArray(ids);

        // Scope to this container (drivers that can attribute provenance) and
        // to genuinely connector-ingested docs.
        const inScope = [];
        for (const doc of (Array.isArray(docs) ? docs : [])) {
            const provenance = (doc?.locations || []).find((l) => l?.metadata?.provenance)?.url;
            if (!provenance) continue;
            // null = the driver cannot attribute a URL to a container; that
            // means "no scoping", never "excluded" (which would silently skip
            // every document and make prune a no-op).
            const attributed = instance.containerIdFromProvenance(provenance);
            if (attributed !== null && attributed !== container.id) continue;
            if (doc.checksumArray?.[0] !== WorkspaceConnectorIndex.identityChecksum(provenance)) continue;
            inScope.push({ doc, provenance });
        }
        if (inScope.length === 0) return;
        if (live.size === 0) {
            this.#logger.warn({ workspaceId: this.#workspaceId, backend: name, container: container.id, indexed: inScope.length },
                'Connector prune refused: source listing came back empty against a non-empty mirror');
            return;
        }

        let pruned = 0;
        for (const { doc } of inScope) {
            if (live.has(doc.checksumArray[0])) continue;
            await this.#reconcileRemovedLocations(doc, (doc.locations || []).map((l) => l?.url).filter(Boolean));
            pruned++;
        }
        if (pruned > 0) {
            this.#logger.info({ workspaceId: this.#workspaceId, backend: name, container: container.id, pruned }, 'Connector prune: source-deleted documents orphaned');
            this.emit('object:prune', { source: name, container: container.id, count: pruned });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Ingest
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * The identity checksum: sha256 of the canonical provenance URL. Remote
     * objects are mutable, so identity is the remote id — the content hash
     * would fork a new document on every remote edit.
     */
    static identityChecksum(provenanceUrl) {
        return `sha256/${crypto.createHash('sha256').update(String(provenanceUrl)).digest('hex')}`;
    }

    async #ingest(name, entry, container, spec, { features = [] } = {}) {
        const { schema, data, metadata = {}, locations = [], containerSegment } = spec;
        const provenance = locations.find((l) => l?.metadata?.provenance)?.url;
        if (!provenance) throw new Error(`Connector document without provenance location (${name})`);

        const doc = {
            schema,
            data,
            metadata: { ...metadata, source: entry.driver, connector: name, workspaceId: this.#workspaceId },
            locations,
            checksumArray: [WorkspaceConnectorIndex.identityChecksum(provenance)],
        };

        const contextSpec = getBackendFileContext(entry.driver, entry.address, containerSegment || container.id);
        const docId = await this.#put(doc, {
            context: null,
            directory: this.#getBackendsTreeSelector(contextSpec),
            emitEvent: true,
            ...(features.length ? { features } : {}),
        });
        this.emit('object:add', { kind: entry.driver, docId, source: name, payload: { container: container.id } });
        return docId;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // config/stored.json — shared with the storage + imap backends
    // ─────────────────────────────────────────────────────────────────────────

    #storedConfigPath() {
        return path.join(this.#rootPath, 'config', 'stored.json');
    }

    async readStoredConfig() {
        try {
            const raw = await fs.readFile(this.#storedConfigPath(), 'utf8');
            const parsed = JSON.parse(raw || '{}');
            return { backends: parsed.backends || {} };
        } catch {
            return { backends: {} };
        }
    }

    async writeStoredConfig(config) {
        const target = this.#storedConfigPath();
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify({ backends: config.backends || {} }, null, 2), 'utf8');
    }

    async patchStoredBackend(name, patch = {}) {
        const config = await this.readStoredConfig();
        config.backends[name] = { ...(config.backends[name] || {}), ...patch };
        await this.writeStoredConfig(config);
        return config.backends[name];
    }
}

export default WorkspaceConnectorIndex;
