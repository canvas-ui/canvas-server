'use strict';

import path from 'path';

// ── Schema ↔ extension mapping (writable abstractions) ──────────────────────

const NOTE_SCHEMA = 'data/schema/note';
const TODO_SCHEMA = 'data/schema/task';
const TAB_SCHEMA  = 'data/schema/tab';
const FILE_SCHEMA = 'data/schema/file';
const EMAIL_SCHEMA = 'data/schema/message/email';
// A link is one address you can open, the same as a tab — it just names its
// target `uri` and itself `label`, where a tab uses `url`/`title`.
const LINK_SCHEMA = 'data/schema/link';

/**
 * Which schema a NEW file implies, or null when it is just a file.
 *
 * `.todo.json` and `.url` keep a canvas meaning because they are not general
 * formats: a browser emits `.url` when you drag a link out of the address bar,
 * and `.todo.json` only ever comes from our own renderer. **`.md` does not** —
 * markdown is a general document format, so a new `.md` is a FILE. Rendering
 * markdown as a note is a UI decision, not a storage one.
 *
 * Throws on malformed JSON / url bodies.
 */
export function inferDocFromFile(filename, body) {
    const name = String(filename || '');
    const lower = name.toLowerCase();
    const text = Buffer.isBuffer(body) ? body.toString('utf-8') : String(body ?? '');

    if (lower.endsWith('.todo.json')) {
        const title = name.slice(0, -('.todo.json'.length));
        const parsed = text.trim() ? JSON.parse(text) : {};
        return { schema: TODO_SCHEMA, data: { title, ...parsed } };
    }

    if (lower.endsWith('.url')) {
        const title = name.slice(0, -4);
        const url = extractUrlFromShortcut(text);
        if (!url) throw new Error('Empty or invalid .url shortcut body');
        return { schema: TAB_SCHEMA, data: { title, url } };
    }

    return null;
}

/**
 * Build a NEW document for a known schema.
 *
 * Used where the destination declares the schema rather than the filename —
 * `Contexts/<id>/Notes/` holds notes because that is what the folder IS, so a
 * write there is a note whatever it is called. (Under `Trees/**` nothing
 * declares a schema, which is why a new file there is a file; see
 * inferDocFromFile.)
 *
 * Returns null for a schema with no file representation, and throws when the
 * body cannot be read as the schema the folder asked for.
 */
export function buildDocForSchema(schema, filename, body) {
    const text = Buffer.isBuffer(body) ? body.toString('utf-8') : String(body ?? '');
    const title = filename.replace(/\.[^.]+$/, '');

    if (schema === NOTE_SCHEMA) { return { schema, data: { title, content: text, filename } }; }
    if (schema === TODO_SCHEMA) {
        const parsed = text.trim() ? JSON.parse(text) : {};
        return { schema, data: { title, ...parsed, filename } };
    }
    if (schema === TAB_SCHEMA) {
        const url = extractUrlFromShortcut(text);
        if (!url) throw new Error('Empty or invalid .url shortcut body');
        return { schema, data: { title, url, filename } };
    }
    return null;
}

/**
 * Apply a new body to an EXISTING document, in its own schema.
 *
 * Editing through a mount must never change what a document IS: a note that
 * already exists stays a note when you save `notes.md` over it, even though a
 * new `.md` would now be created as a file. Returns null for documents whose
 * body is bytes (files) — the caller persists a blob for those.
 */
export function applyBodyToDoc(existing, filename, body) {
    const text = Buffer.isBuffer(body) ? body.toString('utf-8') : String(body ?? '');

    if (existing.schema === NOTE_SCHEMA) {
        return { ...existing, data: { ...(existing.data || {}), content: text } };
    }
    if (existing.schema === TODO_SCHEMA) {
        const parsed = text.trim() ? JSON.parse(text) : {};
        return { ...existing, data: { ...(existing.data || {}), ...parsed } };
    }
    if (existing.schema === TAB_SCHEMA) {
        const url = extractUrlFromShortcut(text);
        if (!url) throw new Error('Empty or invalid .url shortcut body');
        return { ...existing, data: { ...(existing.data || {}), url } };
    }
    if (existing.schema === LINK_SCHEMA) {
        const uri = extractUrlFromShortcut(text);
        if (!uri) throw new Error('Empty or invalid .url shortcut body');
        return { ...existing, data: { ...(existing.data || {}), uri } };
    }
    return null;
}

/**
 * The File document for a persisted blob. `data` stays empty (core/File.js
 * reserves it for JSON docs); the name lives on the location AND, once a
 * document has been named, in metadata — see displayFilename().
 */
export function fileDocumentFromBlob(blob, filename, existing = null) {
    const record = {
        ...(existing || {}),
        schema: FILE_SCHEMA,
        data: {},
        checksumArray: blob.checksum ? [`sha256/${blob.checksum}`] : (existing?.checksumArray || []),
        locations: [{ url: blob.url, metadata: { filename } }],
        metadata: {
            ...(existing?.metadata || {}),
            contentType: blob.mimeType || mimeFor(filename),
            size: blob.size,
            ...(blob.metadata || {}),
        },
    };
    // A document that was explicitly renamed keeps that name; otherwise the
    // location name speaks for it and metadata stays clean.
    if (existing?.metadata?.filename) { record.metadata.filename = existing.metadata.filename; }
    return record;
}

// Accepts a plain URL on its own line or a Windows [InternetShortcut] body.
function extractUrlFromShortcut(text) {
    const trimmed = text.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed.split(/\s+/)[0];
    const m = trimmed.match(/^URL\s*=\s*(\S+)/im);
    return m ? m[1] : null;
}

// ── Filename round-tripping ─────────────────────────────────────────────────

/**
 * The name a consumer should display for a document.
 *
 * The same bytes may be called something different at every location, and
 * `locations` is append-ordered and rebuilt per backend scan — so position must
 * never decide. (Before this resolver a file could rename itself to a content
 * hash simply because a mirror was added and landed at index 0.) The order is:
 *
 *   1. the document's own name (`metadata.filename`) — set by a rename;
 *   2. `data.filename` — the same idea for JSON abstractions (note/todo/tab);
 *   3. the name on the canvas-owned copy (`stored://workspace:*`), which we set
 *      at ingest;
 *   4. any location name, by a STABLE sort (url), never array order;
 *   5. the URL basename, but only where the path really is a name — a
 *      `stored://` key qualifies only when it looks like a filename, since a
 *      content-addressed key is a hash;
 *   6. a schema-derived fallback.
 *
 * Mirrored in the web UI (`src/lib/document-display.ts`); keep them in step.
 */
export function displayFilename(doc) {
    if (!doc) return null;

    if (doc.metadata?.filename) return sanitize(doc.metadata.filename);
    if (doc.data?.filename) return sanitize(doc.data.filename);

    const locations = Array.isArray(doc.locations) ? doc.locations.filter(Boolean) : [];
    const owned = locations.find((location) => /^stored:\/\/workspace:/i.test(location.url || ''));
    if (owned?.metadata?.filename) return sanitize(owned.metadata.filename);

    const stable = [...locations].sort((a, b) => String(a.url || '').localeCompare(String(b.url || '')));
    const named = stable.find((location) => location.metadata?.filename);
    if (named) return sanitize(named.metadata.filename);

    for (const location of stable) {
        const base = nameBearingBasename(location.url);
        if (base) return base;
    }
    return null;
}

export function docName(doc) {
    const resolved = displayFilename(doc);
    if (resolved) return resolved;
    if (doc.schema === EMAIL_SCHEMA) return emailName(doc);
    if (doc.schema === NOTE_SCHEMA) return `${sanitize(doc.data?.title || `note-${doc.id}`)}.md`;
    if (doc.schema === TODO_SCHEMA) return `${sanitize(doc.data?.title || `todo-${doc.id}`)}.todo.json`;
    if (doc.schema === TAB_SCHEMA)  return `${sanitize(doc.data?.title || doc.data?.url || `tab-${doc.id}`)}.url`;
    if (doc.schema === LINK_SCHEMA) return `${sanitize(doc.data?.label || doc.data?.title || doc.data?.uri || `link-${doc.id}`)}.url`;
    const schema = (doc.schema || 'doc').split('/').pop();
    return `${schema}_${doc.id}.json`;
}

/**
 * A message as a file: `<from address>-<subject>.eml`.
 *
 * The bytes behind an email document are the raw RFC 822 message, so `.eml` is
 * what it actually is — every mail client opens one. The name has to come from
 * the document because its locations are addresses, not names: left to those,
 * every message on the mount was called `INBOX;UID=56909`, which says nothing
 * and changes the moment the mailbox is renumbered. Sender and subject are what
 * a person recognises, and both are on the record.
 *
 * Same-name collisions (a repeated subject from one sender) are disambiguated
 * by docEntries(), which appends the document id.
 */
export function emailName(doc) {
    const from = emailAddress(doc?.data?.from) || 'unknown';
    const subject = slugify(doc?.data?.title ?? doc?.data?.subject ?? doc?.data?.name) || 'no-subject';
    return `${sanitize(from)}-${subject}.eml`;
}

// `from` is a string on some records and `{ address, name }` on others (the
// Email schema accepts both); a list shows up on the recipient fields.
function emailAddress(from) {
    if (!from) return '';
    if (Array.isArray(from)) return emailAddress(from[0]);
    if (typeof from === 'string') return from.trim().toLowerCase();
    return String(from.address || from.name || '').trim().toLowerCase();
}

/**
 * A subject as one filename token: accents folded, everything that is not a
 * letter or a digit collapsed to a single '-'. Letters are matched by Unicode
 * property, not `a-z` — a Cyrillic or Greek subject keeps its words instead of
 * slugging away to nothing. Capped at 80 characters so the whole name stays
 * well inside the 255-byte limit alongside the address.
 */
function slugify(value) {
    return String(value ?? '')
        .normalize('NFKD').replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .slice(0, 80)
        .replace(/^-+|-+$/g, '');
}

/**
 * Where a rename is recorded. For a File the document's name is `metadata`
 * (`data` is reserved for JSON docs and core/File.js keeps it empty); every
 * other schema names itself in `data.filename`.
 */
export function renamedRecord(doc, filename) {
    return doc.schema === FILE_SCHEMA
        ? { ...doc, metadata: { ...(doc.metadata || {}), filename } }
        : { ...doc, data: { ...(doc.data || {}), filename } };
}

/**
 * Basename of a location URL, for schemes where the path IS a name.
 *
 * A `stored://` key is only sometimes a name: file-backed keys are the real
 * workspace path (`stored://workspace:home/photos/OM_R2.png`), while cacache
 * and auto-generated keys are content hashes (`ab/cd/<hex>`). So a stored key
 * has to look like a filename — a plain extension, and not bare hex — before
 * it may speak for the document; everything else stays anonymous rather than
 * showing a hash to a human.
 *
 * Some schemes never name anything: `imap://<account>/INBOX;UID=56909` is a
 * slot in a mailbox, and it is renumbered by the next resync. Documents from
 * those carry their own naming rule instead (see docName).
 */
function nameBearingBasename(url) {
    if (!url) return null;
    if (ADDRESS_ONLY_SCHEME.test(url)) return null;
    const afterScheme = String(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const slash = afterScheme.indexOf('/');
    const key = slash >= 0 ? afterScheme.slice(slash + 1) : afterScheme;
    const base = key.split('/').filter(Boolean).pop();
    if (!base) return null;
    let decoded; try { decoded = decodeURIComponent(base); } catch { decoded = base; }
    if (/^stored:\/\//i.test(url) && !looksLikeFilename(decoded)) return null;
    return sanitize(decoded);
}

const ADDRESS_ONLY_SCHEME = /^(imaps?|pop3s?|mailto|graph|ews|news|nntp):/i;

// A name a person would recognise: has an extension and isn't a bare digest.
function looksLikeFilename(base) {
    return /\.[A-Za-z0-9]{1,12}$/.test(base) && !/^[a-f0-9]{16,}$/i.test(base.replace(/\.[^.]*$/, ''));
}

function sanitize(s) {
    const cleaned = String(s)
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '') // drop lone surrogates
        .replace(/[/\\:*?"<>|]|\p{Cc}/gu, '_');
    return [...cleaned].slice(0, 120).join(''); // slice by code point, never split a pair
}

/**
 * Sidecar files a desktop client writes on its own initiative — Finder's
 * AppleDouble/.DS_Store, Windows' desktop.ini, editor swap files. They are
 * bookkeeping for the client, never user content, and must not become
 * documents: a `cp -r` of any folder from a Mac would otherwise litter the
 * workspace with them.
 */
export function isClientDropping(name) {
    const base = String(name || '');
    return base === '.DS_Store'
        || base === 'desktop.ini'
        || base === 'Thumbs.db'
        || base.startsWith('._')
        || base.startsWith('.~lock.')
        || /^~\$/.test(base);
}

// ── Path normalization shared by all virtual FS impls ──────────────────────

export function norm(p) {
    if (!p || p === '/') return '/';
    let n = p.startsWith('/') ? p : '/' + p;
    if (n !== '/' && n.endsWith('/')) n = n.slice(0, -1);
    return n;
}

// ── MIME ────────────────────────────────────────────────────────────────────

const EXT_MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain',
    '.md': 'text/markdown', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.gz': 'application/gzip', '.tar': 'application/x-tar',
    '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav',
    '.url': 'application/internet-shortcut', '.eml': 'message/rfc822',
};

export function mimeFor(filePath) {
    return EXT_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ── Paged listing ───────────────────────────────────────────────────────────

/**
 * How much of a view one call fetches, and how much of it a request will walk.
 *
 * The flat views show every document filed anywhere — a context, a backends
 * tree, the root of a context tree — so a single 1000-document window is not a
 * view of a workspace, it is a view of its oldest thousand documents. Reading
 * only that window left everything past it invisible to readdir AND unfindable
 * by stat, which is how a file could PUT with a 201 and then 404 on the way
 * back out, or show once from a cached listing and vanish on the next look.
 *
 * The budget is what keeps that honest without promising the impossible: a
 * lookup stops as soon as it has its answer, and a listing that hits the
 * ceiling says so instead of quietly presenting a truncated folder as whole.
 */
export const LIST_PAGE = 1000;
export const LIST_BUDGET = 25000;

/**
 * Walk a view page by page. `fetchPage(offset, limit)` returns one page of
 * documents; iteration ends at the first short page or at the budget.
 */
export async function* documentPages(fetchPage, budget = LIST_BUDGET) {
    for (let offset = 0; offset < budget; offset += LIST_PAGE) {
        const limit = Math.min(LIST_PAGE, budget - offset);
        let page;
        try { page = await fetchPage(offset, limit); }
        catch { return; }
        if (!Array.isArray(page) || page.length === 0) { return; }
        yield page;
        if (page.length < limit) { return; }
    }
}

/**
 * Every document in a view, up to the budget. `onTruncated` is called when the
 * ceiling cut the listing short — the caller decides how to say so.
 */
export async function collectDocuments(fetchPage, onTruncated = null) {
    const docs = [];
    for await (const page of documentPages(fetchPage)) { docs.push(...page); }
    if (docs.length >= LIST_BUDGET && onTruncated) { onTruncated(docs.length); }
    return docs;
}

/**
 * The document a filename addresses, resolved page by page and stopping at the
 * first match.
 *
 * Names are resolved exactly as readdir resolves them — `reserved` seeds the
 * same collision set (subdirectory names) and docEntries applies the same
 * `_<id>` suffix — because a name the listing showed has to be a name that
 * opens. Matching bare docName() meant every deduplicated file was listed and
 * then 404'd.
 */
export async function findDocumentByName(fetchPage, filename, reserved = []) {
    const used = new Set(reserved);
    for await (const page of documentPages(fetchPage)) {
        for (const entry of docEntries(page, used)) {
            if (entry.name === filename) { return entry.doc; }
        }
    }
    return null;
}

// ── Document → file mapping (shared by all virtual FS impls) ────────────────

/**
 * The size of the bytes this document stores, where anything records it: the
 * document's own metadata first, then any location that measured what it holds
 * (IMAP records the raw message size on the location, not on the document).
 * Null when nothing knows.
 */
function storedSize(doc) {
    if (Number.isFinite(doc?.metadata?.size)) { return doc.metadata.size; }
    const sized = (Array.isArray(doc?.locations) ? doc.locations : [])
        .find((location) => Number.isFinite(location?.metadata?.size));
    return sized ? sized.metadata.size : null;
}

/**
 * Size of a doc as a file: its stored byte size when known, else the length of
 * the body we would actually render.
 *
 * The rendering is the point — PROPFIND must not advertise a length that the
 * GET then contradicts. It used to answer with the JSON length of `data` for
 * every abstraction, while the GET served the note's markdown or the tab's
 * shortcut, so a client sizing its cache from PROPFIND was wrong about every
 * one of them.
 */
export function docSize(doc) {
    const stored = storedSize(doc);
    if (stored != null) { return stored; }
    return renderDoc(doc).buffer.length;
}

/**
 * When a document was last modified, as a file.
 *
 * Derived from the record, NEVER from `now`. A mount that stamps the current
 * time on every stat is telling the client the file changed under it, and a
 * client with a cache (davfs2, gvfs, Finder, the Windows redirector) answers
 * that by invalidating — which cancels the GET it already has in flight and
 * leaves a half-drawn image and an `ERR_STREAM_PREMATURE_CLOSE` in the log.
 *
 * Documents with no timestamps at all get the epoch: arbitrary, but stable,
 * which is the only property that matters here.
 */
export function docMtime(doc) {
    const ms = Date.parse(doc?.updatedAt || doc?.createdAt || '');
    return Number.isFinite(ms) ? new Date(ms) : new Date(0);
}

/**
 * A document's ETag as a file: its content hash when it has one, else its own
 * identity and mtime. Stable exactly as long as the bytes are — see docMtime
 * for why that matters more than freshness.
 */
export function docEtag(doc) {
    const checksum = (Array.isArray(doc?.checksumArray) ? doc.checksumArray : [])
        .find((entry) => typeof entry === 'string' && entry.includes('/'));
    if (checksum) { return `"${checksum.split('/').pop().slice(0, 32)}"`; }
    return `"d${doc?.id ?? 0}-${docSize(doc)}-${docMtime(doc).getTime()}"`;
}

/**
 * The content type a consumer should announce for this document-as-a-file.
 *
 * The extension leads, because it is not incidental here: it is chosen from the
 * schema (`.eml`, `.md`, `.url`) or is the file's own name, so it describes the
 * body that will actually be served. `metadata.contentType` only fills in for a
 * name that carries no type of its own — it records what a document was ingested
 * as, which for an abstraction is not what a GET renders.
 */
export function docContentType(doc, name) {
    const byExtension = mimeFor(name);
    if (byExtension !== 'application/octet-stream') { return byExtension; }
    return doc?.metadata?.contentType || byExtension;
}

// One shape for "this document, seen as a file": what it is called, what it is,
// how big it is, and the stable identity every DAV verb has to agree on.
export function fileEntry(doc, name) {
    return {
        isDir: false,
        name,
        size: docSize(doc),
        contentType: docContentType(doc, name),
        mtime: docMtime(doc),
        etag: docEtag(doc),
        doc,
    };
}

// Turn a list of docs into deduplicated file entries (see fileEntry).
// Name collisions get the doc id appended before the extension.
export function docEntries(docs, used = new Set()) {
    const entries = [];
    for (const doc of docs) {
        if (!doc) { continue; }
        let name = docName(doc);
        if (used.has(name)) {
            const e = path.extname(name);
            name = `${path.basename(name, e)}_${doc.id}${e}`;
        }
        used.add(name);
        entries.push(fileEntry(doc, name));
    }
    return entries;
}

// Render a non-local doc to a downloadable buffer + content type. Notes/tabs/
// todos/emails get human-friendly bodies; everything else falls back to JSON.
export function renderDoc(doc) {
    if (doc.schema === NOTE_SCHEMA) { return { buffer: Buffer.from(String(doc.data?.content ?? ''), 'utf-8'), contentType: 'text/markdown; charset=utf-8' }; }
    if (doc.schema === TAB_SCHEMA)  { return { buffer: Buffer.from(`[InternetShortcut]\nURL=${doc.data?.url ?? ''}\n`, 'utf-8'), contentType: 'application/internet-shortcut' }; }
    if (doc.schema === LINK_SCHEMA) { return { buffer: Buffer.from(`[InternetShortcut]\nURL=${doc.data?.uri ?? doc.data?.url ?? ''}\n`, 'utf-8'), contentType: 'application/internet-shortcut' }; }
    if (doc.schema === TODO_SCHEMA) { return { buffer: Buffer.from(JSON.stringify(doc.data ?? {}, null, 2), 'utf-8'), contentType: 'application/json' }; }
    if (doc.schema === EMAIL_SCHEMA) { return { buffer: renderEmail(doc), contentType: 'message/rfc822' }; }
    return { buffer: Buffer.from(JSON.stringify(doc, null, 2), 'utf-8'), contentType: 'application/json' };
}

/**
 * A message with no raw source, rebuilt as RFC 822 from its fields.
 *
 * IMAP-ingested mail keeps the original MIME bytes and streams those; mail that
 * arrived through an API (Graph, Gmail) never had them. A file called `.eml`
 * has to open in a mail client either way, so the fields are written back out
 * as a message rather than served as the JSON record.
 */
function renderEmail(doc) {
    const data = doc?.data ?? {};
    const party = (value) => {
        if (!value) { return ''; }
        if (Array.isArray(value)) { return value.map(party).filter(Boolean).join(', '); }
        if (typeof value === 'string') { return value; }
        const address = String(value.address || '').trim();
        const name = String(value.name || '').trim();
        return name && name !== address ? `${name} <${address}>` : (address || name);
    };
    const date = Date.parse(data.date || data.sentAt || data.receivedAt || '');
    const headers = [
        ['From', party(data.from)],
        ['To', party(data.to)],
        ['Cc', party(data.cc)],
        ['Subject', data.subject || data.title || ''],
        ['Date', Number.isFinite(date) ? new Date(date).toUTCString() : ''],
        ['Message-ID', data.messageId || ''],
        ['In-Reply-To', data.inReplyTo || ''],
        ['MIME-Version', '1.0'],
        ['Content-Type', data.bodyHtml && !data.body ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'],
    ];
    const head = headers
        .filter(([, value]) => String(value || '').trim())
        // A header value must not carry the line breaks that would end it.
        .map(([key, value]) => `${key}: ${String(value).replace(/[\r\n]+/g, ' ').trim()}`)
        .join('\r\n');
    const body = String(data.body || data.bodyHtml || data.bodyPreview || '');
    return Buffer.from(`${head}\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}\r\n`, 'utf-8');
}

// Resolve a doc's downloadable content. File-backed docs stream their real
// bytes through the workspace resolver (stored:// etc.); everything else
// renders the abstraction (note/tab/todo → text body, else JSON).
//
// `resolver` is anything with `resolveDocument(doc, options)` — a Workspace, or
// a context's own byte side, which applies the context's ACL first.
export async function resolveDocContent(resolver, doc, filename, { range = null } = {}) {
    if (doc?.locations?.length) {
        const resolved = await resolver
            .resolveDocument(doc, { stream: true, ...(range ? { range } : {}) })
            .catch(() => null);
        if (resolved?.stream) {
            return {
                stream: resolved.stream,
                size: storedSize(doc) ?? undefined,
                contentType: doc.metadata?.contentType || mimeFor(filename),
                // Only true when the backend actually served the window; a
                // backend that cannot seek returns the whole body and the
                // caller must answer 200, not a lying 206.
                ranged: resolved.ranged === true,
            };
        }
    }
    const { buffer, contentType } = renderDoc(doc);
    return { buffer, size: buffer.length, contentType };
}

export function httpError(statusCode, message) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}
