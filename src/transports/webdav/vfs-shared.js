'use strict';

import path from 'path';

// ── Schema ↔ extension mapping (writable abstractions) ──────────────────────

const NOTE_SCHEMA = 'data/schema/note';
const TODO_SCHEMA = 'data/schema/task';
const TAB_SCHEMA  = 'data/schema/tab';
const FILE_SCHEMA = 'data/schema/file';

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
 *   5. the URL basename, but only for schemes whose path really is a name —
 *      never for content-addressed `stored://`, whose key is a hash;
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
    if (doc.schema === NOTE_SCHEMA) return `${sanitize(doc.data?.title || `note-${doc.id}`)}.md`;
    if (doc.schema === TODO_SCHEMA) return `${sanitize(doc.data?.title || `todo-${doc.id}`)}.todo.json`;
    if (doc.schema === TAB_SCHEMA)  return `${sanitize(doc.data?.title || doc.data?.url || `tab-${doc.id}`)}.url`;
    const schema = (doc.schema || 'doc').split('/').pop();
    return `${schema}_${doc.id}.json`;
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

// Basename of a location URL, for schemes where the path IS a name. A
// `stored://` key is a content hash, so it never yields one.
function nameBearingBasename(url) {
    if (!url || /^stored:\/\//i.test(url)) return null;
    const afterScheme = String(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const slash = afterScheme.indexOf('/');
    const key = slash >= 0 ? afterScheme.slice(slash + 1) : afterScheme;
    const base = key.split('/').filter(Boolean).pop();
    if (!base) return null;
    try { return sanitize(decodeURIComponent(base)); } catch { return sanitize(base); }
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
    '.url': 'application/internet-shortcut',
};

export function mimeFor(filePath) {
    return EXT_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// ── Document → file mapping (shared by all virtual FS impls) ────────────────

// Size of a doc as a file: the stored byte size (a checksum-invariant) when
// known, else its inline JSON byte length.
export function docSize(doc) {
    if (Number.isFinite(doc?.metadata?.size)) { return doc.metadata.size; }
    return Buffer.byteLength(JSON.stringify(doc?.data ?? {}, null, 2));
}

// Turn a list of docs into deduplicated file entries ({ name, isDir, size }).
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
        entries.push({ name, isDir: false, size: docSize(doc) });
    }
    return entries;
}

// Render a non-local doc to a downloadable buffer + content type. Notes/tabs/
// todos get human-friendly bodies; everything else falls back to JSON.
export function renderDoc(doc) {
    if (doc.schema === NOTE_SCHEMA) { return { buffer: Buffer.from(String(doc.data?.content ?? ''), 'utf-8'), contentType: 'text/markdown; charset=utf-8' }; }
    if (doc.schema === TAB_SCHEMA)  { return { buffer: Buffer.from(`[InternetShortcut]\nURL=${doc.data?.url ?? ''}\n`, 'utf-8'), contentType: 'application/internet-shortcut' }; }
    if (doc.schema === TODO_SCHEMA) { return { buffer: Buffer.from(JSON.stringify(doc.data ?? {}, null, 2), 'utf-8'), contentType: 'application/json' }; }
    return { buffer: Buffer.from(JSON.stringify(doc, null, 2), 'utf-8'), contentType: 'application/json' };
}

// Resolve a doc's downloadable content. File-backed docs stream their real
// bytes through the workspace resolver (stored:// etc.); everything else
// renders the abstraction (note/tab/todo → text body, else JSON).
export async function resolveDocContent(workspace, doc, filename, { range = null } = {}) {
    if (doc?.locations?.length) {
        const resolved = await workspace
            .resolveDocument(doc, { stream: true, ...(range ? { range } : {}) })
            .catch(() => null);
        if (resolved?.stream) {
            return {
                stream: resolved.stream,
                size: Number.isFinite(doc.metadata?.size) ? doc.metadata.size : undefined,
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
