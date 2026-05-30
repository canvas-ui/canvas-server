'use strict';

import path from 'path';
import { existsSync } from 'fs';
import { stat as fsStat } from 'fs/promises';

// ── Schema ↔ extension mapping (writable abstractions) ──────────────────────

const NOTE_SCHEMA = 'data/abstraction/note';
const TODO_SCHEMA = 'data/abstraction/todo';
const TAB_SCHEMA  = 'data/abstraction/tab';

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
    if (doc.data?.filename) return doc.data.filename;
    if (doc.schema === NOTE_SCHEMA) return `${sanitize(doc.data?.title || `note-${doc.id}`)}.md`;
    if (doc.schema === TODO_SCHEMA) return `${sanitize(doc.data?.title || `todo-${doc.id}`)}.todo.json`;
    if (doc.schema === TAB_SCHEMA)  return `${sanitize(doc.data?.title || doc.data?.url || `tab-${doc.id}`)}.url`;
    const schema = (doc.schema || 'doc').split('/').pop();
    return `${schema}_${doc.id}.json`;
}

function sanitize(s) {
    const cleaned = String(s)
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '') // drop lone surrogates
        .replace(/[/\\:*?"<>|\x00-\x1f]/g, '_');
    return [...cleaned].slice(0, 120).join(''); // slice by code point, never split a pair
}

// ── Path normalization shared by all virtual FS impls ──────────────────────

export function norm(p) {
    if (!p || p === '/') return '/';
    let n = p.startsWith('/') ? p : '/' + p;
    if (n !== '/' && n.endsWith('/')) n = n.slice(0, -1);
    return n;
}

// ── Local-file resolution (file://{WORKSPACE_ROOT}/...) ────────────────────

export function localPath(doc, rootPath) {
    if (!rootPath) return null;
    const urls = (doc.locations || []).map((l) => l.url);
    for (const url of urls) {
        if (!url.startsWith('file://')) continue;
        const p = url.slice(7).replace('{WORKSPACE_ROOT}', rootPath);
        if (existsSync(p)) return p;
    }
    return null;
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

// Size of a doc as a file: the stored byte size when known, then an on-disk
// file size, else its serialized byte length.
export async function docSize(doc, rootPath) {
    if (Number.isFinite(doc?.data?.size)) { return doc.data.size; }
    const local = localPath(doc, rootPath);
    if (local) { return (await fsStat(local).catch(() => null))?.size ?? 0; }
    return Buffer.byteLength(JSON.stringify(doc, null, 2));
}

// Turn a list of docs into deduplicated file entries ({ name, isDir, size }).
// Name collisions get the doc id appended before the extension.
export async function docEntries(docs, rootPath, used = new Set()) {
    const entries = [];
    for (const doc of docs) {
        if (!doc) { continue; }
        let name = docName(doc);
        if (used.has(name)) {
            const e = path.extname(name);
            name = `${path.basename(name, e)}_${doc.id}${e}`;
        }
        used.add(name);
        entries.push({ name, isDir: false, size: await docSize(doc, rootPath) });
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

// Resolve a doc's downloadable content. File-backed docs (stored:// or
// file://) stream their real bytes through the workspace resolver; everything
// else renders the abstraction (note/tab/todo → text body, else JSON).
export async function resolveDocContent(workspace, doc, filename) {
    if (doc?.locations?.length) {
        const resolved = await workspace.resolveDocument(doc, { stream: true }).catch(() => null);
        if (resolved?.stream) {
            return {
                stream: resolved.stream,
                size: Number.isFinite(doc.data?.size) ? doc.data.size : undefined,
                contentType: doc.data?.mime || mimeFor(filename),
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
