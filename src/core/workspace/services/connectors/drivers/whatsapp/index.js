import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import pino from 'pino';
import BaseConnector from '../../BaseConnector.js';
import { openAuthState } from './auth.js';

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Personal WhatsApp linked device. Socket state lives outside stored.json:
// account descriptors/API reads must never expose Signal keys or credentials.
export default class WhatsAppConnector extends BaseConnector {
    static driver = 'whatsapp';
    static label = 'WhatsApp (linked device)';
    static icon = 'mdi:whatsapp';
    static blurb = 'Pair your phone and select conversations to synchronize.';
    static provenanceScheme = 'whatsapp';
    static configFields = [
        { key: 'address', label: 'Account label', required: true },
        { key: 'chats', label: 'Conversation IDs', list: true },
    ];
    #root;
    #onDocument;
    #socket;
    #starting;
    #stopped = false;
    #retry;
    #attempt = 0;
    #qr = null;
    #state = 'disconnected';
    #chats = new Map();
    #queue = Promise.resolve();
    #lib;
    #auth;

    constructor(address, config, { rootPath, onDocument, ...options } = {}) {
        super(address, config, options);
        this.#root = path.join(rootPath, 'var', 'whatsapp', hash(address));
        this.#onDocument = onDocument;
        this.#lib = options.library;
    }

    #selected(jid) { return (this.config.chats || []).includes(jid); }
    #enqueue(fn) {
        this.#queue = this.#queue.then(fn).catch((error) => this.logger.warn?.({ error: error.message }, 'WhatsApp local persistence failed'));
    }

    async #start() {
        if (this.#state === 'logged-out') return;
        if (this.#stopped || this.#socket || this.#starting) return this.#starting;
        this.#starting = this.#connect().finally(() => { this.#starting = null; });
        return this.#starting;
    }

    async #connect() {
        const lib = this.#lib ||= await import('@whiskeysockets/baileys');
        await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
        await fs.chmod(this.#root, 0o700);
        // One linked-device session per configured account, persisted by Baileys.
        await this.#queue;
        await this.#auth?.flush();
        this.#auth = await openAuthState(this.#root, lib);
        const { state, saveCreds } = this.#auth;
        try { for (const c of JSON.parse(await fs.readFile(path.join(this.#root, 'chats.json'), 'utf8'))) this.#chats.set(c.id, c); } catch { /* no saved chat list */ }
        if (this.#stopped) return;
        const socket = lib.default({
            auth: state, logger: pino({ level: 'silent' }),
            browser: lib.Browsers.ubuntu('Canvas'), markOnlineOnConnect: false,
            syncFullHistory: false,
            getMessage: async (key) => (await this.#readMessage(key))?.message,
        });
        this.#socket = socket;
        this.#state = 'connecting';
        socket.ev.on('creds.update', () => { if (socket === this.#socket && !this.#stopped) this.#enqueue(saveCreds); });
        socket.ev.on('connection.update', (update) => {
            if (socket !== this.#socket || this.#stopped) return;
            if (update.qr) { this.#qr = update.qr; this.#state = 'pairing'; }
            if (update.connection === 'open') { this.#state = 'connected'; this.#qr = null; this.#attempt = 0; }
            if (update.connection === 'close') {
                this.#socket = null;
                this.#qr = null;
                const loggedOut = update.lastDisconnect?.error?.output?.statusCode === lib.DisconnectReason.loggedOut;
                this.#state = loggedOut ? 'logged-out' : 'disconnected';
                if (!loggedOut) {
                    this.#retry = setTimeout(() => this.#start().catch(() => { this.#state = 'error'; }), Math.min(60000, 1000 * 2 ** this.#attempt++));
                    this.#retry.unref?.();
                }
            }
        });
        const rememberChats = (chats = []) => {
            for (const c of chats) if (c.id && !c.id.endsWith('@broadcast')) this.#chats.set(c.id, { id: c.id, name: c.name || c.subject || this.#chats.get(c.id)?.name || c.id });
        };
        const persistChats = (chats) => { rememberChats(chats); this.#enqueue(() => fs.writeFile(path.join(this.#root, 'chats.json'), JSON.stringify([...this.#chats.values()]), { mode: 0o600 })); };
        socket.ev.on('chats.upsert', persistChats);
        socket.ev.on('chats.update', persistChats);
        socket.ev.on('messaging-history.set', ({ chats, messages }) => {
            persistChats(chats);
            for (const m of messages || []) this.#enqueue(() => this.#ingest(m));
        });
        socket.ev.on('messages.upsert', ({ messages }) => {
            for (const m of messages || []) this.#enqueue(() => this.#ingest(m));
        });
    }

    async stop() {
        this.#stopped = true;
        clearTimeout(this.#retry);
        this.#socket?.end(new Error('Canvas account stopped'));
        this.#socket = null;
        this.#qr = null;
        await this.#starting;
        await this.#queue;
        await this.#auth?.flush();
    }

    async resetSession() {
        await this.stop();
        await this.#starting;
        await this.#queue;
        await this.#auth?.flush();
        await fs.unlink(path.join(this.#root, 'session.json')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
        this.#stopped = false;
        this.#state = 'disconnected';
        this.#attempt = 0;
        await this.#start();
        return { state: this.#state };
    }

    async connectionStatus() {
        await this.#start();
        const { default: QRCode } = await import('qrcode');
        return { state: this.#state, qr: this.#qr ? await QRCode.toDataURL(this.#qr) : null, chats: [...this.#chats.values()] };
    }

    async test() {
        await this.#start();
        if (this.#state !== 'connected') throw new Error('Pair this account from its WhatsApp connection panel');
    }

    async listContainers() {
        await this.#start();
        return (this.config.chats || []).map((id) => this.#chats.get(id) || { id, name: id });
    }
    async fetchChanges(_container, cursor) { return { documents: [], nextCursor: cursor, done: true }; }

    #messageFile(key) { return path.join(this.#root, `${hash(`${key.remoteJid}/${key.id}`)}.json`); }
    async #readMessage(key) {
        try { return JSON.parse(await fs.readFile(this.#messageFile(key), 'utf8'), this.#lib.BufferJSON.reviver); }
        catch { return undefined; }
    }
    #toDocument(message) {
        const jid = message.key.remoteJid;
        const body = this.#lib.normalizeMessageContent(message.message) || {};
        const content = body.extendedTextMessage || body.imageMessage || body.videoMessage || body.documentMessage || {};
        const text = body.conversation || content.text || content.caption || content.fileName || '';
        if (!text) return null;
        const quoted = content.contextInfo?.stanzaId;
        return this.document({
            schema: 'data/schema/message', containerSegment: jid,
            provenanceUrl: this.provenance(this.address, jid, message.key.id),
            parentProvenanceUrl: quoted ? this.provenance(this.address, jid, quoted) : null,
            data: { text, platform: 'whatsapp', channel: { id: jid, name: this.#chats.get(jid)?.name || jid },
                sender: { id: message.key.participant || (message.key.fromMe ? this.#socket?.user?.id : jid), username: message.pushName },
                timestamp: new Date(Number(message.messageTimestamp || Date.now() / 1000) * 1000).toISOString(),
            },
            metadata: { remoteId: message.key.id, whatsappKey: message.key, outgoing: message.key.fromMe === true },
        });
    }
    async #ingest(message) {
        const jid = message.key?.remoteJid;
        if (this.#stopped || !message.key?.id || !this.#selected(jid)) return;
        await fs.writeFile(this.#messageFile(message.key), JSON.stringify(message, this.#lib.BufferJSON.replacer), { mode: 0o600 });
        const document = this.#toDocument(message);
        if (document) await this.#onDocument({ id: jid, name: this.#chats.get(jid)?.name || jid }, document);
    }

    async prepareMessage(input, parent) {
        if (!this.canWrite || this.config.sendEnabled !== true) throw new Error('Sending is disabled for this WhatsApp account');
        await this.#start();
        if (this.#state !== 'connected') throw new Error('WhatsApp is disconnected; reconnect before sending');
        const target = parent?.data?.channel?.id || input.target;
        if (!this.#selected(target)) throw new Error('Select a configured WhatsApp conversation');
        const quoted = parent ? await this.#readMessage(parent.metadata?.whatsappKey || {}) : undefined;
        if (parent && !quoted) throw new Error('The original WhatsApp message is unavailable for quoting');
        return { target, quoted, text: input.text };
    }

    async sendMessage(prepared) {
        const message = await this.#socket.sendMessage(prepared.target, { text: prepared.text }, { quoted: prepared.quoted });
        if (!message?.key?.id) throw new Error('WhatsApp did not acknowledge the message');
        await fs.writeFile(this.#messageFile(message.key), JSON.stringify(message, this.#lib.BufferJSON.replacer), { mode: 0o600 }).catch(() => {});
        return { status: 'accepted', providerMessageId: message.key.id,
            document: this.#toDocument(message), container: { id: prepared.target, name: prepared.target } };
    }
}
