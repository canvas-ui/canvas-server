'use strict';

/**
 * Document classifier: pure, synchronous helpers shared by workspace hooks,
 * the declarative hook rules engine and embedding input resolution.
 *
 * classifyDocument() never throws — a null/absent document yields a
 * classification whose predicates are all false, so callers can classify
 * unconditionally and branch on the result.
 */

const SCHEMA_PREFIX = 'data/schema/';

// Short name -> full hierarchical id. Since Rev B (2026-08-05) two entries are
// not a plain prefix concat — `email` lives under message and `todo` became
// `task` — so this map is the ONLY way a short name reliably reaches its id.
export const SCHEMAS = Object.freeze({
    application: `${SCHEMA_PREFIX}application`,
    device: `${SCHEMA_PREFIX}device`,
    document: `${SCHEMA_PREFIX}document`,
    dotfile: `${SCHEMA_PREFIX}dotfile`,
    email: `${SCHEMA_PREFIX}message/email`,
    event: `${SCHEMA_PREFIX}event`,
    file: `${SCHEMA_PREFIX}file`,
    identity: `${SCHEMA_PREFIX}identity`,
    link: `${SCHEMA_PREFIX}link`,
    message: `${SCHEMA_PREFIX}message`,
    note: `${SCHEMA_PREFIX}note`,
    tab: `${SCHEMA_PREFIX}tab`,
    // Both spellings resolve to the renamed id: `todo` is the legacy short name
    // clients still send, `task` matches the id itself.
    todo: `${SCHEMA_PREFIX}task`,
    task: `${SCHEMA_PREFIX}task`,
});

const YOUTUBE_RE = /(?:youtube\.com\/watch\?|youtu\.be\/|youtube\.com\/shorts\/)/i;

// Filename-extension → mime, for file blobs whose contentType was never captured
// at ingest (e.g. filesystem-indexed files on fs:home) and so fell back to the
// Document default 'application/json'. Focused on the types embedding cares
// about (image/*, text/*) plus a few common ones. Lowercase extension keys.
const EXT_MIME = Object.freeze({
    jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
    tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
    svg: 'image/svg+xml',
    txt: 'text/plain', text: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
    csv: 'text/csv', tsv: 'text/tab-separated-values', log: 'text/plain',
    html: 'text/html', htm: 'text/html', xml: 'text/xml',
    json: 'application/json', pdf: 'application/pdf',
});

// The `application/json` default is meaningless for a blob (a file's identity is
// its bytes, not inline JSON), so treat it as "mime not captured".
export function isGenericMime(mime) {
    return !mime || mime === 'application/json';
}

/** Best-effort mime from a document's location filenames/URLs (extension-based). */
export function mimeFromLocations(locations) {
    if (!Array.isArray(locations)) { return null; }
    for (const loc of locations) {
        const name = (loc?.metadata?.filename || loc?.url || '').toString();
        const m = name.toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/);
        const mime = m && EXT_MIME[m[1]];
        if (mime) { return mime; }
    }
    return null;
}
const ARXIV_RE = /arxiv\.org\/(?:abs|pdf)\//i;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico']);

export function normalizeSchemaId(name) {
    if (!name) { return null; }
    const value = String(name).toLowerCase();
    return value.includes('/') ? value : (SCHEMAS[value] || `${SCHEMA_PREFIX}${value}`);
}

function parseUrl(url) {
    if (!url || typeof url !== 'string') { return null; }
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed : null;
    } catch {
        return null;
    }
}

// Email `data.from` is `string | { address, name }` (Email.js zod union).
function normalizeAddress(from) {
    if (!from) { return null; }
    const address = typeof from === 'object' ? from.address : from;
    return address ? String(address).toLowerCase() : null;
}

// Email `data.to`/`cc` are arrays of the same union (or absent).
function normalizeAddressList(list) {
    if (!Array.isArray(list)) { return []; }
    return list.map(normalizeAddress).filter(Boolean);
}

/** Match a mime string against an exact type, a `type/*` glob or a RegExp. */
function mimeMatch(mime, pattern) {
    if (!mime || !pattern) { return false; }
    const regex = toPattern(pattern);
    if (regex) { return regex.test(mime); }
    const value = String(pattern).toLowerCase();
    if (value === '*' || value === '*/*') { return true; }
    if (value.endsWith('/*')) { return mime.startsWith(value.slice(0, -1)); }
    return mime === value;
}

// Event payloads carry `context`/`directory` specs whose path lives in either
// `path` (string) or `paths` (array), depending on the emitting call.
function extractPaths(spec) {
    if (!spec || typeof spec !== 'object') { return []; }
    const paths = Array.isArray(spec.paths) ? spec.paths : (spec.path ? [spec.path] : []);
    return paths.filter((p) => typeof p === 'string' && p.length > 0);
}

function toPattern(value) {
    return value instanceof RegExp ? value : null;
}

class Classification {
    constructor(doc, payload) {
        this.doc = doc || null;
        this.schema = typeof doc?.schema === 'string' ? doc.schema.toLowerCase() : null;
        this.mime = doc?.metadata?.contentType || null;
        // A file blob's identity is its bytes, not inline JSON — so a missing or
        // generic 'application/json' mime means it was never captured. Recover the
        // real type from the location filename so filesystem-indexed images/text
        // (fs:home, no stored mime) still classify + embed correctly.
        if (this.isFile() && isGenericMime(this.mime)) {
            const derived = mimeFromLocations(doc?.locations);
            if (derived) { this.mime = derived; }
        }
        this.url = typeof doc?.data?.url === 'string' ? doc.data.url : null;
        this.parsedUrl = parseUrl(this.url);
        this.host = this.parsedUrl ? this.parsedUrl.hostname.toLowerCase().replace(/^www\./, '') : null;
        this.from = normalizeAddress(doc?.data?.from);
        // Recipients: To + Cc, normalized lowercase addresses ("sent to
        // invoice@..." must also match mails where the alias is in Cc).
        this.to = [...normalizeAddressList(doc?.data?.to), ...normalizeAddressList(doc?.data?.cc)];
        this.subject = typeof doc?.data?.subject === 'string' ? doc.data.subject : null;
        this.attachments = Array.isArray(doc?.data?.attachments) ? doc.data.attachments : [];
        this.paths = [...new Set([...extractPaths(payload?.context), ...extractPaths(payload?.directory)])];
    }

    // ── Schema predicates ───────────────────────────────────────────────────
    isSchema(name) {
        return this.schema !== null && this.schema === normalizeSchemaId(name);
    }
    isTab() { return this.isSchema('tab'); }
    isEmail() { return this.isSchema('email'); }
    isFile() { return this.isSchema('file'); }
    isNote() { return this.isSchema('note'); }
    isTodo() { return this.isSchema('todo'); }
    isMessage() { return this.isSchema('message'); }
    isEvent() { return this.isSchema('event'); }

    // ── Content / mime predicates ───────────────────────────────────────────
    isText() {
        // Events join notes/todos: their title + description are inline text with
        // no contentType, so without this they would never reach the embedder.
        if (this.isNote() || this.isTodo() || this.isEvent()) { return true; }
        return typeof this.mime === 'string' && this.mime.startsWith('text/');
    }
    isImage() { return typeof this.mime === 'string' && this.mime.startsWith('image/'); }
    isAudio() { return typeof this.mime === 'string' && this.mime.startsWith('audio/'); }
    isVideo() { return typeof this.mime === 'string' && this.mime.startsWith('video/'); }
    isPdf() { return this.mime === 'application/pdf'; }
    isBlob() { return this.isFile() && Array.isArray(this.doc?.locations) && this.doc.locations.length > 0; }

    /** Match mime against an exact type, a `type/*` glob or a RegExp. */
    mimeMatches(pattern) {
        return mimeMatch(this.mime, pattern);
    }

    // ── Email predicates ────────────────────────────────────────────────────
    /** Any To/Cc recipient address contains the given substring (or matches a RegExp). */
    sentTo(addressOrPattern) {
        if (!addressOrPattern || this.to.length === 0) { return false; }
        const regex = toPattern(addressOrPattern);
        if (regex) { return this.to.some((addr) => regex.test(addr)); }
        const needle = String(addressOrPattern).toLowerCase();
        return this.to.some((addr) => addr.includes(needle));
    }
    /**
     * Document carries attachments; with a pattern, at least one attachment's
     * contentType matches it (exact, `type/*` glob, `*` for any, or RegExp).
     */
    hasAttachment(mimePattern = null) {
        if (this.attachments.length === 0) { return false; }
        if (!mimePattern) { return true; }
        return this.attachments.some((att) => mimeMatch(att?.contentType?.toLowerCase?.() || null, mimePattern));
    }

    // ── URL predicates ──────────────────────────────────────────────────────
    /** Document carries a valid http(s) URL (tabs, links, bookmarked docs). */
    isLink() { return this.parsedUrl !== null; }
    isWebsite() { return this.isLink(); }
    isYoutube() { return this.url !== null && YOUTUBE_RE.test(this.url); }
    isArxiv() { return this.url !== null && ARXIV_RE.test(this.url); }
    isImageUrl() {
        if (!this.parsedUrl) { return false; }
        const ext = this.parsedUrl.pathname.split('.').pop()?.toLowerCase();
        return Boolean(ext) && IMAGE_EXTENSIONS.has(ext);
    }
    /** Exact host or dot-suffix match: `hostMatches('youtube.com')` matches `music.youtube.com`. */
    hostMatches(hostOrSuffix) {
        if (!this.host || !hostOrSuffix) { return false; }
        const target = String(hostOrSuffix).toLowerCase().replace(/^www\./, '');
        return this.host === target || this.host.endsWith(`.${target}`);
    }
    /** Case-insensitive substring or RegExp match against the raw URL. */
    urlMatches(pattern) {
        if (!this.url || !pattern) { return false; }
        const regex = toPattern(pattern);
        if (regex) { return regex.test(this.url); }
        return this.url.toLowerCase().includes(String(pattern).toLowerCase());
    }

    // ── Path predicate ──────────────────────────────────────────────────────
    /** True when the document landed under `prefix` in any of the event's trees. */
    inPath(prefix) {
        if (!prefix) { return false; }
        const target = String(prefix).replace(/\/+$/, '') || '/';
        if (target === '/') { return this.paths.length > 0; }
        return this.paths.some((p) => p === target || p.startsWith(`${target}/`));
    }

    // ── Embedding ───────────────────────────────────────────────────────────
    /** Modality a file blob is embeddable as; mirrors resolveEmbeddingInput. */
    embeddingModality() {
        if (this.isImage()) { return 'image'; }
        if (typeof this.mime === 'string' && this.mime.startsWith('text/')) { return 'text'; }
        return null;
    }
}

/**
 * @param {Object|null} doc - parsed document ({ schema, data, metadata, ... })
 * @param {Object|null} payload - originating event payload (for context/directory paths)
 * @returns {Classification}
 */
export function classifyDocument(doc, payload = null) {
    return new Classification(doc && typeof doc === 'object' ? doc : null, payload);
}

export default classifyDocument;
