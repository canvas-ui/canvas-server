'use strict';

import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import crypto from 'crypto';
import { simpleParser } from 'mailparser';
import Stored from '../../../services/stored/src/index.js';
import ImapBackend from '../../../services/stored/src/backends/imap/index.js';
import Email from '../../../services/synapsd/src/schemas/abstractions/Email.js';
import { parseLocationUrl } from '../../../services/synapsd/src/utils/path-helpers.js';
import { INCOMING_ROOT_CONTEXT, getIncomingEmailContext } from '../../../utils/incoming-documents.js';

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
const IMAP_BACKEND_PREFIX = 'imap';
const IMAP_DEFAULT_FOLDER = 'INBOX';
const IMAP_DEFAULT_POLL_INTERVAL = 60000;
const IMAP_DEFAULT_INITIAL_SYNC_DAYS = 180;
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
    #getImapConfig;

    #stored = null;
    #listeners = [];
    #registeredDataBackends = new Set();
    #backendStatus = new Map();

    constructor({ rootPath, cachePath, dataPath, homePath, dataBackends = {}, workspaceId, logger, put, unlink, getIncomingTreeSelector, getDb, getImapConfig = null }) {
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
        this.#getImapConfig = getImapConfig;
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
            await this.#registerStoredConfigBackends();

            this.#bindEvents();
            await this.resync(HOME_STORED_BACKEND).catch((error) => {
                this.#setBackendError(HOME_STORED_BACKEND, error);
                this.#logger.warn({ workspaceId: this.#workspaceId, error: error.message }, 'Stored home resync failed');
            });
            // Start imap accounts (initial sync + poll) once event bindings exist.
            await this.#startStoredConfigSources();
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
    // config/stored.json — single home for user-configurable backends
    // (imap accounts now; s3/http/… later). System fs backends are still
    // auto-registered above. Shape: { backends: { "<name>": { driver, ... } } }
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

    // Merge a patch into one backend's persisted config (e.g. lastUid after sync).
    async patchStoredBackend(name, patch = {}) {
        const config = await this.readStoredConfig();
        config.backends[name] = { ...(config.backends[name] || {}), ...patch };
        await this.writeStoredConfig(config);
        return config.backends[name];
    }

    // Register (addBackend) every enabled backend from stored.json. Does not
    // start sources — that happens in #startStoredConfigSources once event
    // bindings exist, so emitted change events are actually consumed.
    async #registerStoredConfigBackends() {
        const config = await this.readStoredConfig();
        for (const [name, backendConfig] of Object.entries(config.backends || {})) {
            if (backendConfig?.enabled === false) continue;
            if (this.#stored.getBackend(name)) continue;
            try {
                this.#stored.addBackend(name, { ...backendConfig, watch: false });
                this.#backendStatus.set(name, { lastScanAt: null, lastError: null });
            } catch (error) {
                this.#logger.warn({ workspaceId: this.#workspaceId, backend: name, error: error.message }, 'Failed to register stored backend');
            }
        }
    }

    // Kick off change-detection for poll/scan backends (imap). Initial
    // incremental sync, then start the poll loop.
    async #startStoredConfigSources() {
        const config = await this.readStoredConfig();
        for (const [name, backendConfig] of Object.entries(config.backends || {})) {
            if (backendConfig?.enabled === false) continue;
            if (backendConfig?.driver !== 'imap') continue;
            const backend = this.#stored.getBackend(name);
            if (!backend) continue;
            try {
                await this.#syncImapBackend(name, backend);
            } catch (error) {
                this.#setBackendError(name, error);
                this.#logger.warn({ workspaceId: this.#workspaceId, backend: name, error: error.message }, 'IMAP initial sync failed');
            }
            backend.watch?.();
        }
    }

    // One incremental imap sync; persist advanced lastUid + status.
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
    // Event binding
    // ─────────────────────────────────────────────────────────────────────────

    #bindEvents() {
        this.#unbindEvents();
        if (!this.#stored?.on) return;

        // Generic object:* events from all backends; dispatch by kind.
        // (file backends emit file:* AND object:* kind:file — we bind only the
        // object:* family here to avoid double-handling.)
        const dispatch = (payload) => {
            if (payload?.kind === 'message') return this.#indexImapMessage(payload);
            return this.#upsertDocument(payload); // kind 'file' (or legacy)
        };
        const eventMap = {
            'object:add': dispatch,
            'object:change': dispatch,
            'object:unlink': (payload) => this.#unlinkDocument(payload),
            'backend:state': (payload) => this.#persistBackendState(payload),
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
    // IMAP / email indexing — consumes object:add (kind:message) from the imap
    // backend, builds an Email document, persists the raw blob locally, indexes
    // it into the incoming tree. (Protocol lives entirely in stored.)
    // ─────────────────────────────────────────────────────────────────────────

    async #persistBackendState(payload = {}) {
        if (!payload.backend) return;
        await this.patchStoredBackend(payload.backend, {
            lastUid: payload.lastUid,
            lastSyncAt: new Date().toISOString(),
        }).catch((error) => this.#logger.warn({ workspaceId: this.#workspaceId, backend: payload.backend, error: error.message }, 'Failed to persist backend state'));
    }

    async #indexImapMessage(payload = {}) {
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

        const incomingContext = getIncomingEmailContext('imap', account, folder || 'inbox');
        const directory = this.#getIncomingTreeSelector(incomingContext);
        const features = Email.getFeatureBitmapArray(emailDoc, { mailboxPath: folder });
        const docId = await this.#put(emailDoc, { directory, features, emitEvent: true });
        emailDoc.id = docId;
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

    async #persistEmailBlob(key, buffer) {
        const root = WorkspaceStoredIndex.dataBackendRoot(this.#dataPath, 'email');
        const filePath = path.join(root, key);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, buffer);
        return key;
    }

    async #buildEmailDocument(parsed, rawBuffer, imapMetadata = {}) {
        const backendName = WorkspaceStoredIndex.dataBackendName('email'); // fs:data:email
        const rawChecksum = this.#createChecksum(rawBuffer);
        const account = this.#safeAccount(imapMetadata.accountId);
        const folder = this.#encodeFolder(imapMetadata.folderPath || imapMetadata.folderName);

        const rawKey = path.posix.join(account, folder, `${rawChecksum}.eml`);
        await this.#persistEmailBlob(rawKey, rawBuffer);
        const rawUrl = `stored://${backendName}/${rawKey}`;

        const attachments = [];
        for (const attachment of parsed.attachments || []) {
            const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content || '');
            const checksum = this.#createChecksum(content);
            const fileName = this.#safeFileName(attachment.filename, `${checksum}.bin`);
            const attachmentKey = path.posix.join(account, folder, rawChecksum, fileName);
            await this.#persistEmailBlob(attachmentKey, content);
            attachments.push({
                filename: attachment.filename || fileName,
                contentType: attachment.contentType,
                size: attachment.size,
                contentId: attachment.contentId,
                isInline: attachment.contentDisposition === 'inline',
                checksum: `sha256/${checksum}`,
                url: `stored://${backendName}/${attachmentKey}`,
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
            { url: rawUrl, metadata: { backend: backendName, size: rawBuffer.length, synced: true } },
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
    // IMAP mailbox management — a "mailbox" is an imap backend entry in
    // stored.json (name `imap:<id>`). Protocol is delegated to ImapBackend.
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
            pollInterval, initialSyncDays,
            lastUid: Math.max(0, Number(input.lastUid || 0)),
            lastSyncAt: input.lastSyncAt || null,
            lastError: input.lastError || null,
        };
    }

    #serializeMailbox(id, config) {
        const backend = this.#stored?.getBackend(this.#mailboxName(id));
        return {
            id,
            enabled: config.enabled !== false,
            host: config.host, port: config.port, tls: config.tls, allowSelfSigned: config.allowSelfSigned,
            user: config.user, folder: config.folder, mode: config.mode || 'poll',
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

    async getMailbox(id) {
        const config = await this.readStoredConfig();
        const entry = config.backends[this.#mailboxName(id)];
        return entry && entry.driver === 'imap' ? this.#serializeMailbox(id, entry) : null;
    }

    async saveMailbox(input = {}) {
        const stored = await this.readStoredConfig();
        const id = String(input.id || '').trim() || this.#generateMailboxId(input);
        const name = this.#mailboxName(id);
        const current = stored.backends[name] || null;
        const merged = { ...(current || {}), ...input, id };
        if (current && typeof input.password === 'string' && input.password.length === 0) merged.password = current.password;
        const mailbox = this.#normalizeMailbox(merged, id);
        stored.backends[name] = mailbox;
        await this.writeStoredConfig(stored);
        await this.#refreshMailboxBackend(id, mailbox);
        return this.#serializeMailbox(id, mailbox);
    }

    async removeMailbox(id) {
        const stored = await this.readStoredConfig();
        const name = this.#mailboxName(id);
        const removed = stored.backends[name];
        if (!removed) return false;
        await this.#stopMailboxBackend(name);
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
        let backend = this.#stored?.getBackend(name);
        if (!backend) {
            const config = await this.readStoredConfig();
            const entry = config.backends[name];
            if (!entry) throw new Error(`Mailbox "${id}" not found`);
            backend = this.#stored.addBackend(name, { ...entry, watch: false });
        }
        const result = await this.#syncImapBackend(name, backend);
        const config = await this.readStoredConfig();
        return { mailbox: this.#serializeMailbox(id, config.backends[name]), inserted: result.inserted, lastUid: result.lastUid };
    }

    async startMailbox(id) {
        const stored = await this.readStoredConfig();
        const name = this.#mailboxName(id);
        const entry = stored.backends[name];
        if (!entry) throw new Error(`Mailbox "${id}" not found`);
        if (entry.enabled === false) { entry.enabled = true; stored.backends[name] = entry; await this.writeStoredConfig(stored); }
        await this.#refreshMailboxBackend(id, entry);
        return this.#serializeMailbox(id, entry);
    }

    async stopMailbox(id) {
        const stored = await this.readStoredConfig();
        const name = this.#mailboxName(id);
        const entry = stored.backends[name];
        if (!entry) throw new Error(`Mailbox "${id}" not found`);
        await this.#stopMailboxBackend(name);
        entry.enabled = false; stored.backends[name] = entry; await this.writeStoredConfig(stored);
        return this.#serializeMailbox(id, entry);
    }

    // Register (if needed) + start/stop a mailbox backend to match its enabled flag.
    async #refreshMailboxBackend(id, config) {
        if (!this.#stored) return;
        const name = this.#mailboxName(id);
        if (config.enabled === false) { await this.#stopMailboxBackend(name); return; }
        let backend = this.#stored.getBackend(name);
        if (!backend) backend = this.#stored.addBackend(name, { ...config, watch: false });
        try { await this.#syncImapBackend(name, backend); }
        catch (error) { this.#setBackendError(name, error); }
        backend.watch?.();
    }

    async #stopMailboxBackend(name) {
        if (!this.#stored?.getBackend(name)) return;
        await this.#stored.removeBackend(name).catch(() => {}); // stops watcher + unregisters
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
        const entries = await this.#imapEntries();
        for (const { name } of entries) await this.#stopMailboxBackend(name);
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
            await this.#ensureBackendForUrl(backend);
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

    // Lazily register a data backend (e.g. fs:data:email) so its locations resolve/delete.
    async #ensureBackendForUrl(backend) {
        if (!this.#stored.getBackend(backend) && this.#isDataBackend(backend)) {
            const abstraction = backend.slice(`${DATA_STORED_BACKEND_PREFIX}:`.length);
            if (abstraction) await this.ensureDataBackend(abstraction);
        }
        return this.#stored.getBackend(backend);
    }

    // Lazily register an imap backend (imap:<account>) from injected credentials,
    // so imap:// locations can be EXPUNGEd. Returns the backend or null if no
    // config resolver / credentials are available.
    async #ensureImapBackend(account) {
        const name = `imap:${account}`;
        let be = this.#stored.getBackend(name);
        if (be) return be;
        if (!this.#getImapConfig) return null;
        const cfg = await this.#getImapConfig(account);
        if (!cfg) return null;
        be = this.#stored.addBackend(name, { driver: 'imap', account, ...cfg });
        return be;
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
                const be = this.#stored ? await this.#ensureBackendForUrl(p.backend) : null;
                kind = 'stored';
                deletable = !!be && be.canDelete;
            } else if (p?.scheme === 'file' && p.backend === '{WORKSPACE_ROOT}') {
                kind = 'workspace-file';
                deletable = true;
            } else if (p?.scheme === 'imap') {
                // Deletable only if imap credentials are wired (server EXPUNGE).
                const be = this.#stored ? await this.#ensureImapBackend(p.backend) : null;
                kind = 'imap';
                deletable = !!be && be.canDelete;
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
     * NOTE: imap:// server-side removal (EXPUNGE) is not wired yet — imap
     * locations are reference-dropped only. file://<deviceId> likewise.
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
                    const be = await this.#ensureBackendForUrl(p.backend);
                    if (be && be.canDelete) {
                        await this.#stored.deleteByUrl(loc.url);
                        result.deleted.push(loc.url);
                    } else {
                        // read-only or unknown backend → reference drop only
                        result.droppedRefs.push(loc.url);
                    }
                } else if (p?.scheme === 'file' && p.backend === '{WORKSPACE_ROOT}') {
                    await fs.rm(path.join(this.#rootPath, p.key), { force: true });
                    result.deleted.push(loc.url);
                } else if (p?.scheme === 'imap') {
                    const be = await this.#ensureImapBackend(p.backend);
                    if (be && be.canDelete) {
                        await be.delete(p.key); // STORE \Deleted + EXPUNGE by UID
                        result.deleted.push(loc.url);
                    } else {
                        // no credentials wired → drop reference only
                        result.droppedRefs.push(loc.url);
                    }
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
            await db.delete(doc.id);
            result.docDeleted = true;
        } else if (doc?.id != null) {
            await this.#put(doc); // persist trimmed locations (update in place)
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
