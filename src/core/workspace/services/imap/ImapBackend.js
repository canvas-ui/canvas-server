import Debug from 'debug';
import Imap from 'imap';
import StorageBackend from '../../../../services/stored/src/backends/StorageBackend.js';

const debug = Debug('stored:backend:imap');

const DEFAULT_FOLDER = 'INBOX';
const DEFAULT_POLL_INTERVAL = 60000;
const DEFAULT_INITIAL_SYNC_DAYS = 180;
const FETCH_BATCH_SIZE = 200;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * IMAP storage backend — owns the IMAP protocol for one account/folder.
 *
 * Addresses messages by `<folder>;UID=<n>` (RFC 5092). Emits `object:add` per
 * fetched message (kind:'message') so the workspace indexer can build documents;
 * change-detection is `scan()` (incremental search by UID) driven by `watch()`
 * (poll loop). Read + delete (EXPUNGE) supported; append (write) is not.
 *
 * config: { host, port=993, tls=true, allowSelfSigned=false, user, password,
 *           folder='INBOX', account?, pollInterval?, initialSyncDays?, lastUid? }
 */
export default class ImapBackend extends StorageBackend {
    #pollTimer = null;
    #lastUid = 0;
    #syncing = false;

    // Awaited ingest handler injected by the owning service. scan() only advances
    // the UID cursor after this resolves, so a failed ingest never silently skips
    // a message (at-least-once; the service dedups on re-ingest).
    onMessage = null;

    constructor(name, config = {}) {
        super(name, config);
        this.type = 'remote';
        this.#lastUid = Math.max(0, Number(config.lastUid || 0));
        debug(`ImapBackend "${name}" initialized (account=${config.account ?? config.user ?? '?'}, folder=${this.#folder})`);
    }

    get capabilities() { return { read: true, write: false, delete: true }; }

    // imap://<account>/<folder>;UID=<n> — matches the provenance grammar.
    nativeUrl(key) { return `imap://${this.#account}/${key}`; }
    get watching() { return !!this.#pollTimer; }
    get lastUid() { return this.#lastUid; }
    get #folder() { return this.config.folder || DEFAULT_FOLDER; }
    get #account() { return this.config.account || this.config.user; }

    // ── connection ────────────────────────────────────────────────────────────
    #options() {
        const c = this.config;
        return {
            user: c.user,
            password: c.password,
            host: c.host,
            port: c.port || 993,
            tls: c.tls !== false,
            tlsOptions: { rejectUnauthorized: c.allowSelfSigned === false },
            authTimeout: c.authTimeout || 15000,
            connTimeout: c.connTimeout || 15000,
        };
    }

    // Connect, run `fn(imap)`, always end the connection.
    #withConnection(fn) {
        return new Promise((resolve, reject) => {
            const imap = new Imap(this.#options());
            let settled = false;
            const done = (err, val) => {
                if (settled) return;
                settled = true;
                try { imap.end(); } catch { /* already closed */ }
                err ? reject(err) : resolve(val);
            };
            imap.once('ready', () => {
                Promise.resolve().then(() => fn(imap, done))
                    .then((val) => done(null, val), (e) => done(e));
            });
            imap.once('error', (e) => done(e));
            imap.connect();
        });
    }

    #openBox(imap, folder, readOnly) {
        return new Promise((resolve, reject) => {
            imap.openBox(folder, readOnly, (err, box) => (err ? reject(err) : resolve(box)));
        });
    }

    // ── key parsing ─────────────────────────────────────────────────────────
    #parseKey(key) {
        const m = String(key || '').match(/^(.*);UID=(\d+)$/i);
        if (!m) throw new Error(`imap key must be "<folder>;UID=<n>", got: ${key}`);
        const folder = m[1].split('/').map((s) => decodeURIComponent(s)).join('/');
        return { folder, uid: Number(m[2]) };
    }

    #encodeFolder(value) {
        return String(value || DEFAULT_FOLDER).split('/').map(encodeURIComponent).join('/') || DEFAULT_FOLDER;
    }

    // ── CRUD ──────────────────────────────────────────────────────────────────
    async get(key, options = {}) {
        const { folder, uid } = this.#parseKey(key);
        return this.#withConnection((imap) => new Promise((resolve, reject) => {
            this.#openBox(imap, folder, true).then(() => {
                const f = imap.fetch(uid, { bodies: '' }); // top-level fetch is UID-based
                let found = false;
                f.on('message', (msg) => {
                    const chunks = [];
                    msg.on('body', (stream) => stream.on('data', (c) => chunks.push(Buffer.from(c))));
                    msg.once('end', () => { found = true; resolve(Buffer.concat(chunks)); });
                });
                f.once('error', reject);
                f.once('end', () => { if (!found) resolve(null); });
            }).catch(reject);
            void options; // streaming not supported for IMAP; buffer returned
        }));
    }

    async delete(key) {
        const { folder, uid } = this.#parseKey(key);
        return this.#withConnection((imap) => new Promise((resolve, reject) => {
            this.#openBox(imap, folder, false) // read-write
                .then(() => new Promise((res, rej) => imap.addFlags(uid, '\\Deleted', (e) => (e ? rej(e) : res()))))
                .then(() => new Promise((res, rej) => imap.expunge([uid], (e) => (e ? rej(e) : res()))))
                .then(() => { debug(`EXPUNGE ${folder};UID=${uid}`); resolve(true); })
                .catch(reject);
        }));
    }

    async stat(key) {
        const data = await this.get(key);
        return data ? { key, size: data.length, modified: null, created: null } : null;
    }

    // ── connectivity / discovery ────────────────────────────────────────────
    async verify() {
        return this.#withConnection((imap) => this.#openBox(imap, this.#folder, true)
            .then((box) => ({ folder: box?.name || this.#folder, messageCount: box?.messages?.total || 0 })));
    }

    async listFolders() {
        return this.#withConnection((imap) => new Promise((resolve, reject) => {
            imap.getBoxes((err, boxes) => (err ? reject(err) : resolve(this.#flattenBoxes(boxes))));
        }));
    }

    #flattenBoxes(boxes = {}, parentPath = '', parentDelimiter = '/') {
        const folders = [];
        for (const [name, box] of Object.entries(boxes || {})) {
            const delimiter = box?.delimiter || parentDelimiter || '/';
            const folderPath = parentPath ? `${parentPath}${delimiter}${name}` : name;
            const attribs = (box?.attribs || []).map((a) => String(a).toLowerCase());
            folders.push({
                name, path: folderPath, delimiter,
                selectable: !attribs.includes('\\noselect'),
                attributes: box?.attribs || [],
            });
            if (box?.children) folders.push(...this.#flattenBoxes(box.children, folderPath, delimiter));
        }
        return folders.sort((a, b) => a.path.localeCompare(b.path));
    }

    // ── search / fetch helpers ────────────────────────────────────────────────
    #formatSearchDate(date) {
        return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
    }

    #searchCriteria() {
        if (this.#lastUid > 0) return [['UID', `${this.#lastUid + 1}:*`]];
        const days = Number(this.config.initialSyncDays ?? DEFAULT_INITIAL_SYNC_DAYS);
        if (days > 0) {
            const since = new Date();
            since.setDate(since.getDate() - days);
            return [['SINCE', this.#formatSearchDate(since)]];
        }
        return ['ALL'];
    }

    #fetchBatches(uids = [], batchSize = FETCH_BATCH_SIZE) {
        const values = uids.map(Number).filter((v) => Number.isInteger(v) && v > 0).sort((a, b) => a - b);
        const batches = [];
        for (let i = 0; i < values.length; i += batchSize) {
            batches.push(this.#rangeOf(values.slice(i, i + batchSize)));
        }
        return batches.filter(Boolean);
    }

    #rangeOf(values = []) {
        if (!values.length) return '';
        const ranges = [];
        let start = values[0], end = values[0];
        for (let i = 1; i < values.length; i++) {
            if (values[i] === end + 1) { end = values[i]; continue; }
            ranges.push(start === end ? `${start}` : `${start}:${end}`);
            start = end = values[i];
        }
        ranges.push(start === end ? `${start}` : `${start}:${end}`);
        return ranges.join(',');
    }

    #fetchBatch(imap, source) {
        return new Promise((resolve, reject) => {
            const fetch = imap.fetch(source, { bodies: '' });
            const pending = [];
            // Advance the persisted cursor only to the highest UID that actually
            // ingested. On any failure the batch rejects and #lastUid is left
            // untouched, so the whole batch is refetched next pass (no skip).
            let maxUid = this.#lastUid;
            fetch.on('message', (msg, seqno) => {
                const chunks = [];
                let attrs = {};
                msg.on('body', (stream) => stream.on('data', (c) => chunks.push(Buffer.from(c))));
                msg.once('attributes', (a) => { attrs = a || {}; });
                msg.once('end', () => {
                    const uid = Number(attrs.uid) || 0;
                    const folderKey = this.#encodeFolder(this.#folder);
                    const payload = {
                        backend: this.name,
                        kind: 'message',
                        key: `${folderKey};UID=${uid}`,
                        raw: Buffer.concat(chunks),
                        uid,
                        seqno,
                        flags: attrs.flags || [],
                        folder: this.#folder,
                        account: this.#account,
                    };
                    // Await ingest before crediting the UID; fall back to a plain
                    // emit only if no handler is wired (cursor still advances).
                    pending.push(Promise.resolve()
                        .then(() => (this.onMessage ? this.onMessage(payload) : this.emit('object:add', payload)))
                        .then(() => { if (uid > maxUid) maxUid = uid; }));
                });
            });
            fetch.once('error', reject);
            fetch.once('end', () => Promise.all(pending)
                .then(() => { this.#lastUid = maxUid; resolve(); })
                .catch(reject));
        });
    }

    /**
     * Incremental sync: search since last UID (or initialSyncDays / ALL), fetch
     * in batches, emit `object:add` per message. Returns { inserted, lastUid }.
     */
    async scan(options = {}) {
        if (typeof options.lastUid === 'number') this.#lastUid = Math.max(this.#lastUid, options.lastUid);
        return this.#withConnection((imap) => new Promise((resolve, reject) => {
            this.#openBox(imap, this.#folder, true).then(() => {
                imap.search(this.#searchCriteria(), (err, results) => {
                    if (err) return reject(err);
                    if (!results || results.length === 0) return resolve({ inserted: 0, lastUid: this.#lastUid });
                    const before = this.#lastUid;
                    void before;
                    const batches = this.#fetchBatches(results);
                    (async () => {
                        try {
                            for (const range of batches) await this.#fetchBatch(imap, range);
                            this.emit('backend:state', { backend: this.name, lastUid: this.#lastUid });
                            resolve({ inserted: results.length, lastUid: this.#lastUid });
                        } catch (e) { reject(e); }
                    })();
                });
            }).catch(reject);
        }));
    }

    /**
     * Start polling (watchd-style change detection). Each tick runs an
     * incremental scan; messages surface as `object:add` events.
     */
    async watch() {
        if (this.#pollTimer) return true;
        const interval = Number(this.config.pollInterval || DEFAULT_POLL_INTERVAL);
        const tick = async () => {
            if (this.#syncing) return;
            this.#syncing = true;
            try { await this.scan(); }
            catch (e) { this.emit('error', e); }
            finally { this.#syncing = false; }
        };
        this.#pollTimer = setInterval(tick, interval);
        debug(`Polling ${this.name} every ${interval}ms`);
        return true;
    }

    async stop() {
        if (this.#pollTimer) { clearInterval(this.#pollTimer); this.#pollTimer = null; debug(`Stopped polling ${this.name}`); }
    }
}
