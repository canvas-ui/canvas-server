'use strict';

import path from 'path';
import { existsSync } from 'fs';

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
    return String(s).replace(/[/\\:*?"<>|]/g, '_').slice(0, 120);
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
