'use strict';

import EventEmitter from 'eventemitter2';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import Imap from 'imap';
import { simpleParser } from 'mailparser';
import { createLogger } from '../../../../utils/log.js';
import { getIncomingEmailContext } from '../../../../utils/incoming-documents.js';
import Email from '../../../../services/synapsd/src/schemas/abstractions/Email.js';

const logger = createLogger('imap-service');
const DEFAULT_FOLDER = 'INBOX';
const DEFAULT_POLL_INTERVAL = 60000;
const DEFAULT_MODE = 'poll';
const DEFAULT_INITIAL_SYNC_DAYS = 180;
const IMAP_FETCH_BATCH_SIZE = 200;

class ImapService extends EventEmitter {
    #workspaceManager;
    #mailboxRuntimes = new Map();
    #pollingIntervals = new Map();

    constructor(options = {}) {
        super();
        this.#workspaceManager = options.workspaceManager;

        if (!this.#workspaceManager) {
            throw new Error('WorkspaceManager is required');
        }
    }

    async initialize() {
        logger.debug('ImapService initialized');
        return this;
    }

    async enable(workspace) {
        logger.debug(`Enabling ImapService for workspace ${workspace.id}`);
        const config = await this.#readConfig(workspace);
        const statuses = [];

        for (const mailbox of config.mailboxes.filter((entry) => entry.enabled)) {
            statuses.push(await this.startMailbox(workspace, mailbox.id, { persistEnabled: false, triggerSync: true }));
        }

        return {
            enabled: true,
            mailboxCount: config.mailboxes.length,
            started: statuses.length,
            mailboxes: await this.listMailboxes(workspace),
        };
    }

    async disable(workspace) {
        logger.debug(`Disabling ImapService for workspace ${workspace.id}`);
        await this.#stopWorkspaceMailboxes(workspace.id);
        return true;
    }

    isEnabled(workspace) {
        return Array.from(this.#mailboxRuntimes.values()).some((runtime) => runtime.workspaceId === workspace.id);
    }

    async reload(workspace) {
        await this.disable(workspace);
        if (!workspace.isServiceEnabled('imap')) {
            return this.getWorkspaceStatus(workspace);
        }
        await this.enable(workspace);
        return this.getWorkspaceStatus(workspace);
    }

    async getWorkspaceStatus(workspace) {
        const mailboxes = await this.listMailboxes(workspace);
        return {
            ...workspace.services.imap,
            initialized: this.isEnabled(workspace),
            mailboxCount: mailboxes.length,
            activeMailboxCount: mailboxes.filter((mailbox) => mailbox.runtime.active).length,
            mailboxes,
        };
    }

    async listMailboxes(workspace) {
        const config = await this.#readConfig(workspace);
        return config.mailboxes.map((mailbox) => this.#serializeMailbox(workspace.id, mailbox));
    }

    async getMailbox(workspace, mailboxId) {
        const config = await this.#readConfig(workspace);
        const mailbox = config.mailboxes.find((entry) => entry.id === String(mailboxId));
        return mailbox ? this.#serializeMailbox(workspace.id, mailbox) : null;
    }

    async saveMailbox(workspace, mailboxInput = {}) {
        const config = await this.#readConfig(workspace);
        const mailboxId = String(mailboxInput.id || '').trim() || this.#generateMailboxId(mailboxInput);
        const index = config.mailboxes.findIndex((entry) => entry.id === mailboxId);
        const current = index >= 0 ? config.mailboxes[index] : null;
        const nextInput = {
            ...current,
            ...mailboxInput,
            id: mailboxId,
        };

        if (current && typeof mailboxInput.password === 'string' && mailboxInput.password.length === 0) {
            nextInput.password = current.password;
        }

        const mailbox = this.#normalizeMailbox({
            ...nextInput,
        });

        if (index >= 0) {
            config.mailboxes[index] = mailbox;
        } else {
            config.mailboxes.push(mailbox);
        }

        await this.#writeConfig(workspace, config);

        if (workspace.isServiceEnabled('imap')) {
            if (mailbox.enabled) {
                await this.startMailbox(workspace, mailbox.id, { persistEnabled: false, triggerSync: true });
            } else {
                await this.stopMailbox(workspace, mailbox.id, { persistEnabled: false });
            }
        }

        return this.#serializeMailbox(workspace.id, mailbox);
    }

    async removeMailbox(workspace, mailboxId) {
        const config = await this.#readConfig(workspace);
        const index = config.mailboxes.findIndex((entry) => entry.id === String(mailboxId));
        if (index === -1) {
            return false;
        }

        const [mailbox] = config.mailboxes.splice(index, 1);
        await this.stopMailbox(workspace, mailbox.id, { persistEnabled: false });
        await this.#writeConfig(workspace, config);
        return this.#serializeMailbox(workspace.id, mailbox);
    }

    async testMailbox(workspace, mailboxId) {
        const mailbox = await this.#getMailboxConfig(workspace, mailboxId);
        if (!mailbox) {
            throw new Error(`Mailbox "${mailboxId}" not found`);
        }

        const result = await this.#verifyMailbox(mailbox);
        await this.#updateMailboxState(workspace, mailbox.id, {
            lastError: null,
            lastSyncAt: new Date().toISOString(),
        });
        return {
            mailbox: this.#serializeMailbox(workspace.id, mailbox),
            result,
        };
    }

    async listMailboxFolders(workspace, mailboxId) {
        const mailbox = await this.#getMailboxConfig(workspace, mailboxId);
        if (!mailbox) {
            throw new Error(`Mailbox "${mailboxId}" not found`);
        }
        return this.#listFolders(mailbox);
    }

    async discoverFolders(mailboxInput = {}) {
        return this.#listFolders(this.#normalizeMailbox({
            ...mailboxInput,
            id: mailboxInput.id || 'folder-discovery',
        }));
    }

    async subscribeFolders(workspace, mailboxId, folderPaths = []) {
        const config = await this.#readConfig(workspace);
        const sourceMailbox = config.mailboxes.find((entry) => entry.id === String(mailboxId));
        if (!sourceMailbox) {
            throw new Error(`Mailbox "${mailboxId}" not found`);
        }

        const folders = Array.from(new Set(folderPaths.map((folder) => String(folder || '').trim()).filter(Boolean)));
        const mailboxes = [];

        for (const folder of folders) {
            let mailbox = config.mailboxes.find((entry) =>
                entry.host === sourceMailbox.host && entry.user === sourceMailbox.user && entry.folder === folder
            );

            if (!mailbox) {
                mailbox = this.#normalizeMailbox({
                    ...sourceMailbox,
                    id: this.#generateMailboxId({ ...sourceMailbox, folder }),
                    folder,
                    lastUid: 0,
                    lastSyncAt: null,
                    lastError: null,
                });
                config.mailboxes.push(mailbox);
            }

            mailboxes.push(mailbox);
        }

        await this.#writeConfig(workspace, config);

        if (workspace.isServiceEnabled('imap')) {
            for (const mailbox of mailboxes.filter((entry) => entry.enabled)) {
                await this.startMailbox(workspace, mailbox.id, { persistEnabled: false, triggerSync: true });
            }
        }

        return mailboxes.map((mailbox) => this.#serializeMailbox(workspace.id, mailbox));
    }

    async startMailbox(workspace, mailboxId, options = {}) {
        const { persistEnabled = true, triggerSync = true } = options;
        let mailbox = await this.#getMailboxConfig(workspace, mailboxId);
        if (!mailbox) {
            throw new Error(`Mailbox "${mailboxId}" not found`);
        }

        if (persistEnabled && !mailbox.enabled) {
            mailbox = await this.#updateMailboxState(workspace, mailbox.id, { enabled: true, lastError: null });
        }

        const runtime = this.#getOrCreateRuntime(workspace, mailbox);
        runtime.status = 'idle';
        runtime.active = true;
        runtime.lastError = mailbox.lastError || null;
        runtime.lastUid = mailbox.lastUid || 0;

        this.#scheduleMailbox(workspace, mailbox);

        if (triggerSync) {
            try {
                await this.syncMailbox(workspace, mailbox.id);
            } catch (error) {
                logger.debug(`Initial IMAP sync failed for ${workspace.id}/${mailbox.id}: ${error.message}`);
            }
        }

        return this.#serializeMailbox(workspace.id, mailbox);
    }

    async stopMailbox(workspace, mailboxId, options = {}) {
        const { persistEnabled = true } = options;
        const mailbox = await this.#getMailboxConfig(workspace, mailboxId);
        if (!mailbox) {
            throw new Error(`Mailbox "${mailboxId}" not found`);
        }

        this.#clearMailboxTimer(workspace.id, mailbox.id);

        const runtimeKey = this.#getRuntimeKey(workspace.id, mailbox.id);
        const runtime = this.#mailboxRuntimes.get(runtimeKey);
        if (runtime) {
            runtime.active = false;
            runtime.status = 'stopped';
        }

        let nextMailbox = mailbox;
        if (persistEnabled && mailbox.enabled) {
            nextMailbox = await this.#updateMailboxState(workspace, mailbox.id, { enabled: false });
        }

        return this.#serializeMailbox(workspace.id, nextMailbox);
    }

    async syncMailbox(workspace, mailboxId) {
        const mailbox = await this.#getMailboxConfig(workspace, mailboxId);
        if (!mailbox) {
            throw new Error(`Mailbox "${mailboxId}" not found`);
        }

        const runtime = this.#getOrCreateRuntime(workspace, mailbox);
        if (runtime.syncing) {
            return {
                mailbox: this.#serializeMailbox(workspace.id, mailbox),
                skipped: true,
                reason: 'Mailbox sync already in progress',
            };
        }

        runtime.syncing = true;
        runtime.active = true;
        runtime.status = 'syncing';

        try {
            const result = await this.#fetchMailboxEmails(workspace, mailbox);
            const updatedMailbox = await this.#updateMailboxState(workspace, mailbox.id, {
                lastUid: result.lastUid,
                lastSyncAt: new Date().toISOString(),
                lastError: null,
            });

            runtime.lastUid = updatedMailbox.lastUid;
            runtime.lastSyncAt = updatedMailbox.lastSyncAt;
            runtime.lastError = null;
            runtime.status = this.#pollingIntervals.has(this.#getRuntimeKey(workspace.id, mailbox.id)) ? 'running' : 'idle';

            return {
                mailbox: this.#serializeMailbox(workspace.id, updatedMailbox),
                inserted: result.inserted,
                lastUid: result.lastUid,
            };
        } catch (error) {
            const updatedMailbox = await this.#updateMailboxState(workspace, mailbox.id, {
                lastError: error.message,
            });

            runtime.lastError = error.message;
            runtime.status = 'error';
            runtime.active = this.#pollingIntervals.has(this.#getRuntimeKey(workspace.id, mailbox.id));

            throw new Error(`IMAP sync failed for "${updatedMailbox.id}": ${error.message}`);
        } finally {
            runtime.syncing = false;
        }
    }

    async #readConfig(workspace) {
        const configPath = this.#getConfigPath(workspace);
        if (!fs.existsSync(configPath)) {
            return { mailboxes: [] };
        }

        const content = await fs.promises.readFile(configPath, 'utf-8');
        const parsed = JSON.parse(content || '{}');
        return this.#normalizeConfig(parsed);
    }

    async #writeConfig(workspace, config) {
        const configPath = this.#getConfigPath(workspace);
        await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
        await fs.promises.writeFile(configPath, JSON.stringify(this.#normalizeConfig(config), null, 2), 'utf-8');
    }

    #normalizeConfig(config = {}) {
        const sourceMailboxes = Array.isArray(config.mailboxes)
            ? config.mailboxes
            : Array.isArray(config.accounts)
                ? config.accounts
                : [];

        return {
            ...config,
            mailboxes: sourceMailboxes.map((mailbox, index) => this.#normalizeMailbox(mailbox, `mailbox-${index + 1}`)),
        };
    }

    #normalizeMailbox(mailbox = {}, fallbackId = 'mailbox') {
        const id = String(mailbox.id || fallbackId).trim();
        if (!id) {
            throw new Error('Mailbox id is required');
        }

        const host = String(mailbox.host || '').trim();
        const user = String(mailbox.user || '').trim();
        const password = String(mailbox.password || '');
        if (!host) {
            throw new Error(`Mailbox "${id}" is missing host`);
        }
        if (!user) {
            throw new Error(`Mailbox "${id}" is missing user`);
        }
        if (!password) {
            throw new Error(`Mailbox "${id}" is missing password`);
        }

        const port = Number(mailbox.port || 993);
        if (!Number.isInteger(port) || port <= 0) {
            throw new Error(`Mailbox "${id}" has invalid port`);
        }

        const pollInterval = Number(mailbox.pollInterval || DEFAULT_POLL_INTERVAL);
        if (!Number.isInteger(pollInterval) || pollInterval <= 0) {
            throw new Error(`Mailbox "${id}" has invalid poll interval`);
        }

        const initialSyncDays = Number(mailbox.initialSyncDays ?? DEFAULT_INITIAL_SYNC_DAYS);
        if (!Number.isInteger(initialSyncDays) || initialSyncDays < 0) {
            throw new Error(`Mailbox "${id}" has invalid initial sync window`);
        }

        const mode = mailbox.mode || DEFAULT_MODE;
        if (mode !== 'poll') {
            throw new Error(`Mailbox "${id}" uses unsupported mode "${mode}"`);
        }

        return {
            id,
            enabled: mailbox.enabled !== false,
            host,
            port,
            tls: mailbox.tls !== false,
            allowSelfSigned: mailbox.allowSelfSigned !== false,
            user,
            password,
            folder: String(mailbox.folder || DEFAULT_FOLDER).trim() || DEFAULT_FOLDER,
            mode,
            pollInterval,
            initialSyncDays,
            lastUid: Math.max(0, Number(mailbox.lastUid || 0)),
            lastSyncAt: mailbox.lastSyncAt || null,
            lastError: mailbox.lastError || null,
        };
    }

    #serializeMailbox(workspaceId, mailbox) {
        const runtime = this.#mailboxRuntimes.get(this.#getRuntimeKey(workspaceId, mailbox.id));
        return {
            id: mailbox.id,
            enabled: mailbox.enabled,
            host: mailbox.host,
            port: mailbox.port,
            tls: mailbox.tls,
            allowSelfSigned: mailbox.allowSelfSigned,
            user: mailbox.user,
            folder: mailbox.folder,
            mode: mailbox.mode,
            pollInterval: mailbox.pollInterval,
            initialSyncDays: mailbox.initialSyncDays,
            lastUid: mailbox.lastUid || 0,
            lastSyncAt: mailbox.lastSyncAt || null,
            lastError: mailbox.lastError || null,
            passwordConfigured: Boolean(mailbox.password),
            runtime: {
                active: runtime?.active === true,
                syncing: runtime?.syncing === true,
                status: runtime?.status || 'stopped',
            },
        };
    }

    async #getMailboxConfig(workspace, mailboxId) {
        const config = await this.#readConfig(workspace);
        return config.mailboxes.find((entry) => entry.id === String(mailboxId)) || null;
    }

    async #updateMailboxState(workspace, mailboxId, patch = {}) {
        const config = await this.#readConfig(workspace);
        const index = config.mailboxes.findIndex((entry) => entry.id === String(mailboxId));
        if (index === -1) {
            throw new Error(`Mailbox "${mailboxId}" not found`);
        }

        const mailbox = this.#normalizeMailbox({
            ...config.mailboxes[index],
            ...patch,
            id: config.mailboxes[index].id,
        });
        config.mailboxes[index] = mailbox;
        await this.#writeConfig(workspace, config);
        return mailbox;
    }

    #getRuntimeKey(workspaceId, mailboxId) {
        return `${workspaceId}:${mailboxId}`;
    }

    #getOrCreateRuntime(workspace, mailbox) {
        const key = this.#getRuntimeKey(workspace.id, mailbox.id);
        if (!this.#mailboxRuntimes.has(key)) {
            this.#mailboxRuntimes.set(key, {
                workspaceId: workspace.id,
                userId: workspace.owner,
                mailboxId: mailbox.id,
                active: false,
                syncing: false,
                status: 'stopped',
                lastUid: mailbox.lastUid || 0,
                lastSyncAt: mailbox.lastSyncAt || null,
                lastError: mailbox.lastError || null,
            });
        }
        return this.#mailboxRuntimes.get(key);
    }

    async #stopWorkspaceMailboxes(workspaceId) {
        const runtimeKeys = Array.from(this.#mailboxRuntimes.keys()).filter((key) => key.startsWith(`${workspaceId}:`));
        for (const key of runtimeKeys) {
            this.#clearMailboxTimerByKey(key);
            this.#mailboxRuntimes.delete(key);
        }
    }

    #scheduleMailbox(workspace, mailbox) {
        const runtimeKey = this.#getRuntimeKey(workspace.id, mailbox.id);
        this.#clearMailboxTimerByKey(runtimeKey);

        if (!mailbox.enabled || mailbox.mode !== 'poll') {
            const runtime = this.#mailboxRuntimes.get(runtimeKey);
            if (runtime) {
                runtime.status = 'idle';
                runtime.active = false;
            }
            return;
        }

        const runtime = this.#getOrCreateRuntime(workspace, mailbox);
        runtime.active = true;
        runtime.status = 'running';

        const intervalId = setInterval(async () => {
            try {
                const currentWorkspace = await this.#workspaceManager.getWorkspace(workspace.id, workspace.owner);
                if (!currentWorkspace) {
                    return;
                }
                await this.syncMailbox(currentWorkspace, mailbox.id);
            } catch (error) {
                logger.debug(`IMAP polling error for ${workspace.id}/${mailbox.id}: ${error.message}`);
            }
        }, mailbox.pollInterval || DEFAULT_POLL_INTERVAL);

        this.#pollingIntervals.set(runtimeKey, intervalId);
    }

    #clearMailboxTimer(workspaceId, mailboxId) {
        this.#clearMailboxTimerByKey(this.#getRuntimeKey(workspaceId, mailboxId));
    }

    #clearMailboxTimerByKey(runtimeKey) {
        const intervalId = this.#pollingIntervals.get(runtimeKey);
        if (!intervalId) {
            return;
        }
        clearInterval(intervalId);
        this.#pollingIntervals.delete(runtimeKey);
    }

    async #verifyMailbox(mailbox) {
        return new Promise((resolve, reject) => {
            const imap = new Imap(this.#createImapOptions(mailbox));
            let finished = false;

            const finish = (error, payload = null) => {
                if (finished) {
                    return;
                }
                finished = true;
                try { imap.end(); } catch {}
                if (error) {
                    reject(error);
                    return;
                }
                resolve(payload);
            };

            imap.once('ready', () => {
                imap.openBox(mailbox.folder, true, (error, box) => {
                    if (error) {
                        finish(error);
                        return;
                    }
                    finish(null, {
                        folder: box?.name || mailbox.folder,
                        messageCount: box?.messages?.total || 0,
                    });
                });
            });

            imap.once('error', finish);
            imap.connect();
        });
    }

    async #listFolders(mailbox) {
        return new Promise((resolve, reject) => {
            const imap = new Imap(this.#createImapOptions(mailbox));
            let finished = false;

            const finish = (error, payload = null) => {
                if (finished) {
                    return;
                }
                finished = true;
                try { imap.end(); } catch {}
                if (error) {
                    reject(error);
                    return;
                }
                resolve(payload);
            };

            imap.once('ready', () => {
                imap.getBoxes((error, boxes) => {
                    if (error) {
                        finish(error);
                        return;
                    }
                    finish(null, this.#flattenBoxes(boxes));
                });
            });

            imap.once('error', finish);
            imap.connect();
        });
    }

    #flattenBoxes(boxes = {}, parentPath = '', parentDelimiter = '/') {
        const folders = [];
        for (const [name, box] of Object.entries(boxes || {})) {
            const delimiter = box?.delimiter || parentDelimiter || '/';
            const folderPath = parentPath ? `${parentPath}${delimiter}${name}` : name;
            const attribs = (box?.attribs || []).map((attrib) => String(attrib).toLowerCase());

            folders.push({
                name,
                path: folderPath,
                delimiter,
                selectable: !attribs.includes('\\noselect'),
                attributes: box?.attribs || [],
            });

            if (box?.children) {
                folders.push(...this.#flattenBoxes(box.children, folderPath, delimiter));
            }
        }
        return folders.sort((a, b) => a.path.localeCompare(b.path));
    }

    async #persistBuffer(workspace, relativePath, buffer) {
        const filePath = path.join(workspace.dataPath, relativePath);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, buffer);
        return path.posix.join('data', relativePath.split(path.sep).join('/'));
    }

    #createChecksum(buffer) {
        return crypto.createHash('sha256').update(buffer).digest('hex');
    }

    #safeFileName(name, fallback = 'attachment.bin') {
        const value = String(name || fallback).trim();
        const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        return sanitized || fallback;
    }

    async #buildEmailDocument(workspace, parsed, rawBuffer, imapMetadata = {}) {
        const rawChecksum = this.#createChecksum(rawBuffer);
        const rawRelativePath = path.join('email', 'raw', `${rawChecksum}.eml`);
        const rawKey = await this.#persistBuffer(workspace, rawRelativePath, rawBuffer);

        const attachmentBasePath = path.join('email', 'attachments', rawChecksum);
        const attachments = [];
        for (const attachment of parsed.attachments || []) {
            const content = Buffer.isBuffer(attachment.content)
                ? attachment.content
                : Buffer.from(attachment.content || '');
            const checksum = this.#createChecksum(content);
            const fileName = this.#safeFileName(attachment.filename, `${checksum}.bin`);
            const attachmentRelativePath = path.join(attachmentBasePath, `${checksum}-${fileName}`);
            const attachmentKey = await this.#persistBuffer(workspace, attachmentRelativePath, content);

            attachments.push({
                filename: attachment.filename || fileName,
                contentType: attachment.contentType,
                size: attachment.size,
                contentId: attachment.contentId,
                isInline: attachment.contentDisposition === 'inline',
                checksum: `sha256:${checksum}`,
                url: attachmentKey,
                storageRef: {
                    backend: 'workspace',
                    key: attachmentKey,
                },
            });
        }

        const emailDoc = Email.fromIMAP(parsed, imapMetadata);
        emailDoc.data.attachments = attachments.length ? attachments : emailDoc.data.attachments;
        emailDoc.data.folder = {
            ...(emailDoc.data.folder || {}),
            path: imapMetadata.folderPath || emailDoc.data.folder?.path,
            name: imapMetadata.folderName || emailDoc.data.folder?.name,
        };
        emailDoc.data.rawRef = {
            backend: 'workspace',
            key: rawKey,
            checksum: `sha256:${rawChecksum}`,
        };
        emailDoc.metadata = {
            ...(emailDoc.metadata || {}),
            source: 'imap',
            workspaceId: workspace.id,
        };

        return emailDoc;
    }

    #getEmailFeatures(emailDoc, mailbox) {
        return Email.getFeatureBitmapArray(emailDoc, {
            mailboxPath: mailbox.folder,
        });
    }

    #buildFetchRange(identifiers = []) {
        const values = identifiers
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0)
            .sort((a, b) => a - b);

        if (!values.length) {
            return '';
        }

        const ranges = [];
        let start = values[0];
        let end = values[0];

        for (let index = 1; index < values.length; index += 1) {
            const value = values[index];
            if (value === end + 1) {
                end = value;
                continue;
            }

            ranges.push(start === end ? `${start}` : `${start}:${end}`);
            start = value;
            end = value;
        }

        ranges.push(start === end ? `${start}` : `${start}:${end}`);
        return ranges.join(',');
    }

    #buildFetchBatches(identifiers = [], batchSize = IMAP_FETCH_BATCH_SIZE) {
        const values = identifiers
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0);
        const batches = [];

        for (let index = 0; index < values.length; index += batchSize) {
            const range = this.#buildFetchRange(values.slice(index, index + batchSize));
            if (range) {
                batches.push(range);
            }
        }

        return batches;
    }

    #formatSearchDate(date) {
        const day = date.getDate();
        const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()];
        const year = date.getFullYear();
        return `${month} ${day}, ${year}`;
    }

    #getSearchCriteria(mailbox) {
        if (mailbox.lastUid > 0) {
            return [['UID', `${mailbox.lastUid + 1}:*`]];
        }

        if ((mailbox.initialSyncDays || 0) > 0) {
            const since = new Date();
            since.setDate(since.getDate() - mailbox.initialSyncDays);
            return [['SINCE', this.#formatSearchDate(since)]];
        }

        return ['ALL'];
    }

    async #fetchEmailBatch(imap, source, workspace, mailbox, box, emails, onUid) {
        return new Promise((resolve, reject) => {
            const fetch = imap.fetch(source, { bodies: '' });
            const pendingMessages = [];

            fetch.on('message', (msg, seqno) => {
                const chunks = [];
                let attributes = {};
                let doneMessage;
                const messageDone = new Promise((resolveMessage) => {
                    doneMessage = resolveMessage;
                });
                pendingMessages.push(messageDone);

                msg.on('body', (stream) => {
                    stream.on('data', (chunk) => {
                        chunks.push(Buffer.from(chunk));
                    });
                });

                msg.once('attributes', (attrs) => {
                    attributes = attrs || {};
                    onUid(Number(attributes.uid) || 0);
                });

                msg.once('end', async () => {
                    try {
                        const rawBuffer = Buffer.concat(chunks);
                        const parsed = await simpleParser(rawBuffer);
                        const emailDoc = await this.#buildEmailDocument(workspace, parsed, rawBuffer, {
                            uid: attributes.uid,
                            seqno,
                            flags: attributes.flags,
                            provider: 'imap',
                            accountId: mailbox.user,
                            folderName: box?.name,
                            folderPath: box?.name,
                        });

                        const incomingContext = getIncomingEmailContext('imap', mailbox.user, box?.name || mailbox.folder || 'inbox');
                        const docId = await workspace.put(emailDoc, {
                            directory: workspace.getIncomingTreeSelector(incomingContext),
                            features: this.#getEmailFeatures(emailDoc, mailbox),
                            emitEvent: true,
                        });
                        emailDoc.id = docId;
                        emails.push(emailDoc);

                        workspace.emit('source.imap.email.received', {
                            workspaceId: workspace.id,
                            document: emailDoc,
                            account: {
                                user: mailbox.user,
                                host: mailbox.host,
                            },
                            mailbox: {
                                id: mailbox.id,
                                path: box?.name || mailbox.folder,
                            },
                            uid: attributes.uid,
                            seqno,
                            flags: attributes.flags || [],
                            source: 'imap',
                        });
                    } catch (parseError) {
                        logger.debug(`Error parsing email for ${workspace.id}/${mailbox.id}: ${parseError.message}`);
                    } finally {
                        doneMessage();
                    }
                });
            });

            fetch.once('error', reject);
            fetch.once('end', () => {
                Promise.all(pendingMessages).then(() => resolve()).catch(reject);
            });
        });
    }

    async #fetchMailboxEmails(workspace, mailbox) {
        logger.debug(`Fetching IMAP emails for workspace ${workspace.id}, mailbox ${mailbox.id}`);

        return new Promise((resolve, reject) => {
            const imap = new Imap(this.#createImapOptions(mailbox));
            const emails = [];
            let maxUid = mailbox.lastUid || 0;
            let settled = false;

            const finish = (error, payload = null) => {
                if (settled) {
                    return;
                }
                settled = true;
                try { imap.end(); } catch {}
                if (error) {
                    reject(error);
                    return;
                }
                resolve(payload);
            };

            imap.once('ready', () => {
                imap.openBox(mailbox.folder, true, (openError, box) => {
                    if (openError) {
                        finish(openError);
                        return;
                    }

                    const criteria = this.#getSearchCriteria(mailbox);

                    imap.search(criteria, (searchError, results) => {
                        if (searchError) {
                            finish(searchError);
                            return;
                        }

                        if (!results || results.length === 0) {
                            finish(null, { inserted: 0, lastUid: mailbox.lastUid || 0 });
                            return;
                        }
                        const fetchBatches = this.#buildFetchBatches(results);
                        maxUid = Math.max(maxUid, ...results.map((value) => Number(value) || 0));

                        void (async () => {
                            try {
                                for (const fetchRange of fetchBatches) {
                                    await this.#fetchEmailBatch(
                                        imap,
                                        fetchRange,
                                        workspace,
                                        mailbox,
                                        box,
                                        emails,
                                        (uid) => {
                                            if (uid > maxUid) {
                                                maxUid = uid;
                                            }
                                        },
                                    );
                                }

                                finish(null, {
                                    inserted: emails.length,
                                    lastUid: maxUid,
                                });
                            } catch (fetchError) {
                                finish(fetchError);
                            }
                        })();
                    });
                });
            });

            imap.once('error', finish);
            imap.connect();
        });
    }

    #createImapOptions(mailbox) {
        return {
            user: mailbox.user,
            password: mailbox.password,
            host: mailbox.host,
            port: mailbox.port || 993,
            tls: mailbox.tls !== false,
            tlsOptions: {
                rejectUnauthorized: mailbox.allowSelfSigned === false,
            },
        };
    }

    #getConfigPath(workspace) {
        return path.join(workspace.rootPath, 'config', 'imap.json');
    }

    #generateMailboxId(mailboxInput = {}) {
        const base = [
            mailboxInput.user,
            mailboxInput.host,
            mailboxInput.folder || DEFAULT_FOLDER,
        ]
            .filter(Boolean)
            .join('-')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        return base || `mailbox-${Date.now()}`;
    }
}

export default ImapService;
