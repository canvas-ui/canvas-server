'use strict';

import path from 'path';

// ── Schema ↔ extension mapping (writable abstractions) ──────────────────────

const NOTE_SCHEMA = 'data/schema/note';
const TODO_SCHEMA = 'data/schema/task';
const TAB_SCHEMA  = 'data/schema/tab';

/**
 * Infer schema + parsed data payload from a filename + body for PUT.
 * Returns { schema, data } or null if the extension is not writable.
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

    if (lower.endsWith('.md')) {
        const title = name.slice(0, -3);
        return { schema: NOTE_SCHEMA, data: { title, content: text } };
    }

    if (lower.endsWith('.url')) {
        const title = name.slice(0, -4);
        const url = extractUrlFromShortcut(text);
        if (!url) throw new Error('Empty or invalid .url shortcut body');
        return { schema: TAB_SCHEMA, data: { title, url } };
    }

    return null;
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
 * Round-trip docName: ensures notes/todos/tabs use stable, extension-bearing
 * filenames so re-PUT targets the existing doc instead of creating a new one.
 */
export function docName(doc) {
    if (doc.data?.filename) return doc.data.filename; // notes/todos/tabs written via WebDAV
    if (doc.schema === NOTE_SCHEMA) return `${sanitize(doc.data?.title || `note-${doc.id}`)}.md`;
    if (doc.schema === TODO_SCHEMA) return `${sanitize(doc.data?.title || `todo-${doc.id}`)}.todo.json`;
    if (doc.schema === TAB_SCHEMA)  return `${sanitize(doc.data?.title || doc.data?.url || `tab-${doc.id}`)}.url`;
    // Uploaded files carry their real name on the location; the location KEY is
    // a content hash, so falling through to locationBasename() first would show
    // every uploaded file as a hash.
    const declared = (doc.locations || []).map((location) => location?.metadata?.filename).find(Boolean);
    if (declared) return sanitize(declared);
    const fromLocation = locationBasename(doc); // blobs: name comes from a location key
    if (fromLocation) return fromLocation;
    const schema = (doc.schema || 'doc').split('/').pop();
    return `${schema}_${doc.id}.json`;
}

// Basename of the first location's key (everything after scheme://backend/).
function locationBasename(doc) {
    const url = (doc.locations || [])[0]?.url;
    if (!url) return null;
    const afterScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
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
export async function resolveDocContent(workspace, doc, filename) {
    if (doc?.locations?.length) {
        const resolved = await workspace.resolveDocument(doc, { stream: true }).catch(() => null);
        if (resolved?.stream) {
            return {
                stream: resolved.stream,
                size: Number.isFinite(doc.metadata?.size) ? doc.metadata.size : undefined,
                contentType: doc.metadata?.contentType || mimeFor(filename),
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
