'use strict';

import EventEmitter from 'eventemitter2';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { simpleParser } from 'mailparser';
import ImapBackend from './ImapBackend.js';
import Email from '../../../../services/synapsd/src/schemas/abstractions/Email.js';
import { parseLocationUrl } from '../../../../services/synapsd/src/utils/path-helpers.js';
import { getBackendEmailContext, normalizeSegment, BACKENDS_ROOT_CONTEXT } from '../../../../utils/backend-documents.js';

/*
 * WorkspaceMailIndex (ImapService)
 *
 * Per-workspace IMAP connector: manages mailbox accounts (config/stored.json),
 * runs incremental sync + poll, and ingests messages as Email documents (raw
 * .eml + attachment blobs persisted under data/email/, indexed into the
 * directory tree's /.backends/imap/<account>/<folder> subtree).
 *
 * Fully self-owned: it instantiates and owns its ImapBackend instances directly
 * (its own registry + event wiring + lifecycle) — it does NOT ride the stored
 * blob store. Email raw .eml + attachment blobs are persisted into the local
 * content-addressable data store via the injected persistBlob seam and addressed
 * by `stored://workspace:data/<checksum>` (deduped; opaque on-disk layout — the
 * synapsd tree is the navigation).
 *
 * Emits the uniform workspace-service event contract for the Workspace to
 * forward (see services event convention):
 *   object:add | object:change | object:unlink   { kind, docId?, payload }
 *   source:state                                  { source, ... }
 *   error                                         { error, ... }
 */

const IMAP_BACKEND_PREFIX = 'imap';
const IMAP_DEFAULT_FOLDER = 'INBOX';
const IMAP_DEFAULT_POLL_INTERVAL = 60000;
const IMAP_DEFAULT_INITIAL_SYNC_DAYS = 180;

export class WorkspaceMailIndex extends EventEmitter {
    #rootPath;
    #workspaceId;
    #logger;

    // Injected dependencies
    #put;
    #getBackendsTreeSelector;
    #getDb;
    #persistBlob;
    // Optional backend-node enable-lock hooks (lock /.backends/imap/<account>
    // while a mailbox on that account is enabled).
    #lockBackendNode;
    #unlockBackendNode;

    #started = false;
    #backends = new Map(); // name -> ImapBackend
    #backendStatus = new Map();

    constructor({ rootPath, workspaceId, logger, put, getBackendsTreeSelector, getDb, persistBlob, lockBackendNode = null, unlockBackendNode = null }) {
        super({ wildcard: true, delimiter: '.', maxListeners: 100 });
        if (!rootPath) throw new Error('rootPath is required');
        if (!put || !getBackendsTreeSelector || !getDb || !persistBlob) {
            throw new Error('put, getBackendsTreeSelector, getDb, persistBlob are required');
        }
        this.#rootPath = rootPath;
        this.#workspaceId = workspaceId;
        this.#logger = logger || console;
        this.#put = put;
        this.#getBackendsTreeSelector = getBackendsTreeSelector;
        this.#getDb = getDb;
        this.#persistBlob = persistBlob;
        this.#lockBackendNode = lockBackendNode;
        this.#unlockBackendNode = unlockBackendNode;
    }

    get isRunning() { return this.#started; }

    async start() {
        if (this.#started) return;
        this.#started = true;
        try {
            await this.#registerStoredConfigBackends();
            await this.#startStoredConfigSources();
        } catch (error) {
            this.#logger.warn({ workspaceId: this.#workspaceId, error: error.message }, 'IMAP service unavailable');
            await this.stop();
        }
    }

    async stop() {
        for (const backend of this.#backends.values()) {
            await backend.stop().catch(() => {});
        }
        this.#backends.clear();
        this.#backendStatus.clear();
        this.#started = false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Owned ImapBackend registry — instances + their event wiring live here, not
    // in stored. Each backend emits object:add (kind:message) / backend:state /
    // error directly to this service.
    // ─────────────────────────────────────────────────────────────────────────

    #registerBackend(name, config) {
        let backend = this.#backends.get(name);
        if (backend) return backend;
        backend = new ImapBackend(name, config);

        // Awaited ingest — the backend advances its UID cursor only after this
        // resolves, so a failed index never silently skips a message.
        backend.onMessage = (payload) => this.#onObject(payload);
        backend.on('backend:state', (payload) => this.#persistBackendState(payload));
        backend.on('error', (error) => {
            this.#setBackendError(name, error);
            this.emit('error', { source: name, error: error?.message || String(error) });
        });

        this.#backends.set(name, backend);
        this.#backendStatus.set(name, { lastScanAt: null, lastError: null });
        this.#applyAccountNodeLock(name, config, true);
        return backend;
    }

    #getBackend(name) { return this.#backends.get(name); }

    async #removeBackend(name) {
        const backend = this.#backends.get(name);
        if (!backend) return;
        await backend.stop().catch(() => {});
        this.#backends.delete(name);
        this.#applyAccountNodeLock(name, backend.config, false);
    }

    // Enable-lock on the shared account node /.backends/imap/<account>. Holder
    // is the mailbox backend name (imap:<id>): lockedBy is an array, so two
    // mailboxes on one account each hold their own entry and the node unlocks
    // only when the last one releases. Fire-and-forget: lock state is a guard
    // rail, never worth failing a sync over.
    #applyAccountNodeLock(name, config = {}, locked) {
        const hook = locked ? this.#lockBackendNode : this.#unlockBackendNode;
        if (!hook) return;
        const account = this.#safeAccount(config.account || config.user);
        const nodePath = `${BACKENDS_ROOT_CONTEXT}/${IMAP_BACKEND_PREFIX}/${normalizeSegment(account)}`;
        Promise.resolve(hook(nodePath, name)).catch((err) =>
            this.#logger.warn({ workspaceId: this.#workspaceId, backend: name, error: err.message }, 'IMAP account node lock update failed'));
    }

    // Awaited by ImapBackend.#fetchBatch. Errors propagate so the backend leaves
    // its UID cursor unadvanced and refetches the message on the next pass.
    async #onObject(payload = {}) {
        if (payload?.kind !== 'message') return;
        await this.ingestMessage(payload);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Email indexing
    // ─────────────────────────────────────────────────────────────────────────

    async #persistBackendState(payload = {}) {
        if (!payload.backend) return;
        await this.patchStoredBackend(payload.backend, {
            lastUid: payload.lastUid,
            lastSyncAt: new Date().toISOString(),
        }).catch((error) => this.#logger.warn({ workspaceId: this.#workspaceId, backend: payload.backend, error: error.message }, 'Failed to persist backend state'));
        this.emit('source:state', { source: payload.backend, lastUid: payload.lastUid });
    }

    // Ingest one fetched message into an Email document. Normally driven by an
    // owned ImapBackend's object:add event (#onObject); also the entry point for
    // any connector that pushes raw messages.
    async ingestMessage(payload = {}) {
        const { raw, uid, seqno, flags, folder, account } = payload;
        if (!Buffer.isBuffer(raw)) return null;

        const parsed = await simpleParser(raw);
        const emailDoc = await this.#buildEmailDocument(parsed, raw, {
            uid, seqno, flags,
            provider: 'imap',
            accountId: account,
            folderName: folder,
            folderPath: folder,
        });

        const backendContext = getBackendEmailContext('imap', account, folder || 'inbox');
        const directory = this.#getBackendsTreeSelector(backendContext);
        const features = Email.getFeatureBitmapArray(emailDoc, { mailboxPath: folder });
        // Canonical source-backend tag (observability/selection, not a purge driver).
        // Mirrors WorkspaceStoredIndex#buildFeatures: data/backend/imap/<account>.
        if (account) features.push(`data/backend/imap/${account}`);
        // Ingested email is filed ONLY under the directory tree's
        // /.backends/imap/<account>/<folder> — context:null keeps it out of the
        // context root (no "all emails dumped into /").
        const docId = await this.#put(emailDoc, { context: null, directory, features, emitEvent: true });
        emailDoc.id = docId;
        this.emit('object:add', { kind: 'message', docId, source: account, payload: { folder, account, uid } });
        return docId;
    }

    #createChecksum(buffer) {
        return crypto.createHash('sha256').update(buffer).digest('hex');
    }

    #safeFileName(name, fallback = 'attachment.bin') {
        const value = String(name || fallback).trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        return value || fallback;
    }

    #safeAccount(value) {
        return String(value || 'unknown').replace(/[/\\]+/g, '_').trim() || 'unknown';
    }

    #encodeFolder(value) {
        return String(value || 'INBOX').split('/').map(encodeURIComponent).join('/') || 'INBOX';
    }

    async #buildEmailDocument(parsed, rawBuffer, imapMetadata = {}) {
        const account = this.#safeAccount(imapMetadata.accountId);
        const folder = this.#encodeFolder(imapMetadata.folderPath || imapMetadata.folderName);

        // Persist the raw .eml into the content-addressable data store (deduped).
        const raw = await this.#persistBlob(rawBuffer);
        const rawChecksum = raw.checksum || this.#createChecksum(rawBuffer);

        const attachments = [];
        for (const attachment of parsed.attachments || []) {
            const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content || '');
            const blob = await this.#persistBlob(content);
            const checksum = blob.checksum || this.#createChecksum(content);
            attachments.push({
                filename: attachment.filename || this.#safeFileName(attachment.filename, `${checksum}.bin`),
                contentType: attachment.contentType,
                size: attachment.size,
                contentId: attachment.contentId,
                isInline: attachment.contentDisposition === 'inline',
                checksum: `sha256/${checksum}`,
                url: blob.url,
            });
        }

        const emailDoc = Email.fromIMAP(parsed, imapMetadata);
        emailDoc.data.attachments = attachments.length ? attachments : emailDoc.data.attachments;
        emailDoc.data.folder = {
            ...(emailDoc.data.folder || {}),
            path: imapMetadata.folderPath || emailDoc.data.folder?.path,
            name: imapMetadata.folderName || emailDoc.data.folder?.name,
        };

        const uid = Number(imapMetadata.uid) || null;
        const provenanceUrl = `imap://${account}/${folder}${uid ? `;UID=${uid}` : ''}`;
        emailDoc.locations = [
            { url: raw.url, metadata: { size: rawBuffer.length, synced: true } },
            { url: provenanceUrl, metadata: { provenance: true } },
        ];
        emailDoc.checksumArray = [`sha256/${rawChecksum}`];
        emailDoc.metadata = {
            ...(emailDoc.metadata || {}),
            source: 'imap',
            workspaceId: this.#workspaceId,
        };
        return emailDoc;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // imap:// location ops — backs the Workspace Destroy/describe path for imap
    // provenance locations (the blob indexer delegates these here).
    // ─────────────────────────────────────────────────────────────────────────

    // Resolve creds for an account from stored.json and return an ImapBackend
    // able to EXPUNGE (registered mailbox if one matches, else a transient one).
    async #ensureImapBackend(account) {
        if (!account) return null;
        for (const backend of this.#backends.values()) {
            if ((backend.config.account || backend.config.user) === account) return backend;
        }
        const cfg = await this.#findImapConfig(account);
        if (!cfg) return null;
        return new ImapBackend(`${IMAP_BACKEND_PREFIX}:${account}`, { account, ...cfg });
    }

    async #findImapConfig(account) {
        const { backends } = await this.readStoredConfig();
        const entry = Object.values(backends).find(
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
            folder: entry.folder,
            readOnly: entry.readOnly === true,
        };
    }

    async describeImapLocation(url) {
        const p = parseLocationUrl(url);
        const backend = await this.#ensureImapBackend(p?.backend);
        // Config-level readOnly declares the mailbox hands-off: describe it as
        // non-deletable even with working credentials (destroy reference-drops).
        const deletable = !!backend && backend.canDelete && backend.config?.readOnly !== true;
        return { url, scheme: 'imap', backend: p?.backend, kind: 'imap', deletable };
    }

    // EXPUNGE the message behind an imap:// url. Returns { ok } — ok:false means
    // no credentials wired or readOnly mailbox (caller reference-drops only).
    async destroyImapLocation(url) {
        const p = parseLocationUrl(url);
        const backend = await this.#ensureImapBackend(p?.backend);
        if (!backend || !backend.canDelete || backend.config?.readOnly === true) return { ok: false };
        await backend.delete(p.key); // STORE \Deleted + EXPUNGE by UID
        return { ok: true };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // config/stored.json — user-configurable imap accounts.
    // Shape: { backends: { "<name>": { driver: 'imap', ... } } }
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

    // Register every enabled imap backend from stored.json. Does not start
    // sources — that happens in #startStoredConfigSources.
    async #registerStoredConfigBackends() {
        const config = await this.readStoredConfig();
        for (const [name, backendConfig] of Object.entries(config.backends || {})) {
            if (backendConfig?.enabled === false) continue;
            if (backendConfig?.driver !== 'imap') continue;
            if (this.#backends.has(name)) continue;
            try {
                this.#registerBackend(name, backendConfig);
            } catch (error) {
                this.#logger.warn({ workspaceId: this.#workspaceId, backend: name, error: error.message }, 'Failed to register imap backend');
            }
        }
    }

    // Initial incremental sync, then start the poll loop, for each imap account.
    async #startStoredConfigSources() {
        for (const [name, backend] of this.#backends) {
            try {
                await this.#syncImapBackend(name, backend);
            } catch (error) {
                this.#setBackendError(name, error);
                this.#logger.warn({ workspaceId: this.#workspaceId, backend: name, error: error.message }, 'IMAP initial sync failed');
            }
            backend.watch?.();
        }
    }

    async #syncImapBackend(name, backend) {
        const result = await backend.scan();
        await this.patchStoredBackend(name, {
            lastUid: result.lastUid,
            lastSyncAt: new Date().toISOString(),
            lastError: null,
        });
        this.#backendStatus.set(name, { ...(this.#backendStatus.get(name) || {}), lastScanAt: new Date().toISOString(), lastError: null });
        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Mailbox management — a "mailbox" is an imap backend entry in stored.json
    // (name `imap:<id>`). Protocol is delegated to ImapBackend.
    // ─────────────────────────────────────────────────────────────────────────

    #mailboxName(id) { return `${IMAP_BACKEND_PREFIX}:${id}`; }
    #mailboxIdFromName(name) {
        return name.startsWith(`${IMAP_BACKEND_PREFIX}:`) ? name.slice(IMAP_BACKEND_PREFIX.length + 1) : name;
    }

    #generateMailboxId(input = {}) {
        const base = [input.user, input.host, input.folder || IMAP_DEFAULT_FOLDER]
            .filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return base || `mailbox-${Date.now()}`;
    }

    #normalizeMailbox(input = {}, fallbackId = 'mailbox') {
        const id = String(input.id || fallbackId).trim();
        if (!id) throw new Error('Mailbox id is required');
        const host = String(input.host || '').trim();
        const user = String(input.user || '').trim();
        const password = String(input.password || '');
        if (!host) throw new Error(`Mailbox "${id}" is missing host`);
        if (!user) throw new Error(`Mailbox "${id}" is missing user`);
        if (!password) throw new Error(`Mailbox "${id}" is missing password`);
        const port = Number(input.port || 993);
        if (!Number.isInteger(port) || port <= 0) throw new Error(`Mailbox "${id}" has invalid port`);
        const pollInterval = Number(input.pollInterval || IMAP_DEFAULT_POLL_INTERVAL);
        if (!Number.isInteger(pollInterval) || pollInterval <= 0) throw new Error(`Mailbox "${id}" has invalid poll interval`);
        const initialSyncDays = Number(input.initialSyncDays ?? IMAP_DEFAULT_INITIAL_SYNC_DAYS);
        if (!Number.isInteger(initialSyncDays) || initialSyncDays < 0) throw new Error(`Mailbox "${id}" has invalid initial sync window`);
        return {
            driver: 'imap',
            enabled: input.enabled !== false,
            host, port,
            tls: input.tls !== false,
            allowSelfSigned: input.allowSelfSigned !== false,
            user, password,
            account: user,
            folder: String(input.folder || IMAP_DEFAULT_FOLDER).trim() || IMAP_DEFAULT_FOLDER,
            mode: 'poll',
            // readOnly: never delete on the server (Destroy degrades to a
            // reference drop) even though the imap driver supports EXPUNGE.
            readOnly: input.readOnly === true,
            pollInterval, initialSyncDays,
            lastUid: Math.max(0, Number(input.lastUid || 0)),
            lastSyncAt: input.lastSyncAt || null,
            lastError: input.lastError || null,
        };
    }

    #serializeMailbox(id, config) {
        const backend = this.#getBackend(this.#mailboxName(id));
        return {
            id,
            enabled: config.enabled !== false,
            host: config.host, port: config.port, tls: config.tls, allowSelfSigned: config.allowSelfSigned,
            user: config.user, folder: config.folder, mode: config.mode || 'poll',
            readOnly: config.readOnly === true,
            pollInterval: config.pollInterval, initialSyncDays: config.initialSyncDays,
            lastUid: config.lastUid || 0, lastSyncAt: config.lastSyncAt || null, lastError: config.lastError || null,
            passwordConfigured: Boolean(config.password),
            runtime: {
                active: !!backend,
                watching: backend?.watching === true,
                status: backend ? (backend.watching ? 'running' : 'idle') : 'stopped',
            },
        };
    }

    async #imapEntries() {
        const config = await this.readStoredConfig();
        return Object.entries(config.backends || {})
            .filter(([, c]) => c?.driver === 'imap')
            .map(([name, c]) => ({ id: this.#mailboxIdFromName(name), name, config: c }));
    }

    async listMailboxes() {
        const entries = await this.#imapEntries();
        return entries.map(({ id, config }) => this.#serializeMailbox(id, config));
    }

    async saveMailbox(input = {}) {
        const stored = await this.readStoredConfig();
        const id = String(input.id || '').trim() || this.#generateMailboxId(input);
        const name = this.#mailboxName(id);
        const current = stored.backends[name] || null;
        const merged = { ...(current || {}), ...input, id };
        if (current && typeof input.password === 'string' && input.password.length === 0) merged.password = current.password;
        // initialSyncDays only governs the first sync (lastUid==0); see
        // ImapBackend#searchCriteria. If it changed, reset the cursor so the new
        // window is honored on the next sync (re-ingest dedups).
        if (current && input.initialSyncDays != null && Number(input.initialSyncDays) !== Number(current.initialSyncDays)) {
            merged.lastUid = 0;
            merged.lastSyncAt = null;
        }
        const mailbox = this.#normalizeMailbox(merged, id);
        // Drop any running instance first so its in-memory cursor can't re-persist
        // stale state, and so the rebuilt backend picks up the new config/cursor.
        await this.#removeBackend(name);
        stored.backends[name] = mailbox;
        await this.writeStoredConfig(stored);
        await this.#refreshMailboxBackend(id, mailbox);
        return this.#serializeMailbox(id, mailbox);
    }

    // Resync every enabled mailbox on an account, addressed by its normalized
    // /.backends/imap/<account> tree segment. The tree segment was built with
    // normalizeSegment(accountId), so we normalize each mailbox's account the
    // same way to match. MVP resyncs the whole account (folder ignored).
    async resyncAccount(accountSegment) {
        const wanted = normalizeSegment(accountSegment);
        const config = await this.readStoredConfig();
        const ids = [];
        for (const [name, entry] of Object.entries(config.backends || {})) {
            if (entry?.driver !== 'imap') continue;
            if (entry?.enabled === false) continue;
            const acc = normalizeSegment(entry.account || entry.user || '');
            if (acc === wanted) ids.push(this.#mailboxIdFromName(name));
        }
        if (!ids.length) throw new Error(`No IMAP mailbox found for account "${accountSegment}"`);
        const results = [];
        for (const id of ids) results.push(await this.syncMailbox(id));
        return { account: wanted, mailboxes: results.length, results };
    }

    async removeMailbox(id) {
        const stored = await this.readStoredConfig();
        const name = this.#mailboxName(id);
        const removed = stored.backends[name];
        if (!removed) return false;
        await this.#removeBackend(name);
        delete stored.backends[name];
        await this.writeStoredConfig(stored);
        return this.#serializeMailbox(id, removed);
    }

    async testMailbox(id) {
        const config = await this.readStoredConfig();
        const entry = config.backends[this.#mailboxName(id)];
        if (!entry) throw new Error(`Mailbox "${id}" not found`);
        const result = await new ImapBackend(this.#mailboxName(id), entry).verify();
        await this.patchStoredBackend(this.#mailboxName(id), { lastError: null });
        return { mailbox: this.#serializeMailbox(id, entry), result };
    }

    async listMailboxFolders(id) {
        const config = await this.readStoredConfig();
        const entry = config.backends[this.#mailboxName(id)];
        if (!entry) throw new Error(`Mailbox "${id}" not found`);
        return new ImapBackend(this.#mailboxName(id), entry).listFolders();
    }

    async discoverFolders(input = {}) {
        const mailbox = this.#normalizeMailbox({ ...input, id: input.id || 'folder-discovery' }, 'folder-discovery');
        return new ImapBackend('imap:folder-discovery', mailbox).listFolders();
    }

    async subscribeFolders(id, folderPaths = []) {
        const stored = await this.readStoredConfig();
        const source = stored.backends[this.#mailboxName(id)];
        if (!source) throw new Error(`Mailbox "${id}" not found`);
        const folders = Array.from(new Set((folderPaths || []).map((f) => String(f || '').trim()).filter(Boolean)));
        const result = [];
        for (const folder of folders) {
            const childId = this.#generateMailboxId({ ...source, folder });
            const name = this.#mailboxName(childId);
            if (!stored.backends[name]) {
                stored.backends[name] = this.#normalizeMailbox({ ...source, folder, id: childId, lastUid: 0, lastSyncAt: null, lastError: null }, childId);
            }
            result.push({ id: childId, config: stored.backends[name] });
        }
        await this.writeStoredConfig(stored);
        for (const { id: childId, config } of result) {
            if (config.enabled !== false) await this.#refreshMailboxBackend(childId, config);
        }
        return result.map(({ id: childId, config }) => this.#serializeMailbox(childId, config));
    }

    async syncMailbox(id) {
        const name = this.#mailboxName(id);
        let backend = this.#getBackend(name);
        if (!backend) {
            const config = await this.readStoredConfig();
            const entry = config.backends[name];
            if (!entry) throw new Error(`Mailbox "${id}" not found`);
            backend = this.#registerBackend(name, entry);
        }
        const result = await this.#syncImapBackend(name, backend);
        const config = await this.readStoredConfig();
        return { mailbox: this.#serializeMailbox(id, config.backends[name]), inserted: result.inserted, lastUid: result.lastUid };
    }

    // Register (if needed) + start/stop a mailbox backend to match its enabled flag.
    async #refreshMailboxBackend(id, config) {
        const name = this.#mailboxName(id);
        if (config.enabled === false) { await this.#removeBackend(name); return; }
        const backend = this.#registerBackend(name, config);
        try { await this.#syncImapBackend(name, backend); }
        catch (error) { this.#setBackendError(name, error); }
        backend.watch?.();
    }

    // Workspace 'imap' service hooks.
    async getImapStatus() {
        const mailboxes = await this.listMailboxes();
        return {
            initialized: this.isRunning,
            mailboxCount: mailboxes.length,
            activeMailboxCount: mailboxes.filter((m) => m.runtime.active).length,
            mailboxes,
        };
    }

    async disableImap() {
        for (const name of [...this.#backends.keys()]) await this.#removeBackend(name);
    }

    #setBackendError(backendName, error) {
        this.#backendStatus.set(backendName, {
            ...(this.#backendStatus.get(backendName) || {}),
            lastError: error?.message || String(error),
        });
    }
}

export default WorkspaceMailIndex;
