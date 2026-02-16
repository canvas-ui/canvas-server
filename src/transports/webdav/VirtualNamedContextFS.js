'use strict';

import path from 'path';
import { existsSync, createReadStream } from 'fs';
import { stat as fsStat } from 'fs/promises';

/**
 * Virtual filesystem for a named context's WebDAV view.
 * Shows one folder per data abstraction containing documents of that type.
 * No tree traversal — flat folders only.
 *
 * /Notes/          → documents with feature 'data/abstraction/note'
 * /Tabs/           → documents with feature 'data/abstraction/tab'
 * /Files/          → documents with feature 'data/abstraction/file'
 * ...etc
 */

const ABSTRACTIONS = [
    { folder: 'Notes',    feature: 'data/abstraction/note' },
    { folder: 'Tabs',     feature: 'data/abstraction/tab' },
    { folder: 'Files',    feature: 'data/abstraction/file' },
    { folder: 'Emails',   feature: 'data/abstraction/email' },
    { folder: 'Messages', feature: 'data/abstraction/message' },
    { folder: 'Dotfiles', feature: 'data/abstraction/dotfile' },
    { folder: 'Documents', feature: 'data/abstraction/document' },
    { folder: 'Contacts', feature: 'data/abstraction/contact' },
    { folder: 'Devices',  feature: 'data/abstraction/device' },
];

const FOLDER_MAP = new Map(ABSTRACTIONS.map(a => [a.folder, a.feature]));

export default class VirtualNamedContextFS {
    #ctx;

    constructor(context) { this.#ctx = context; }

    // ── Public API ───────────────────────────────────────────────────────────

    async stat(vPath) {
        const n = norm(vPath);

        if (n === '/') return { isDir: true, name: 'context', size: 0 };

        const parts = n.split('/').filter(Boolean);
        if (parts.length === 1 && FOLDER_MAP.has(parts[0])) {
            return { isDir: true, name: parts[0], size: 0 };
        }

        if (parts.length === 2 && FOLDER_MAP.has(parts[0])) {
            const doc = await this.#findDoc(parts[0], parts[1]);
            if (doc) {
                const local = this.#localPath(doc);
                const sz = local
                    ? (await fsStat(local).catch(() => null))?.size ?? 0
                    : Buffer.byteLength(JSON.stringify(doc, null, 2));
                return { isDir: false, name: parts[1], size: sz, doc, localFile: local || null };
            }
        }

        return null;
    }

    async readdir(vPath) {
        const n = norm(vPath);

        // Root → list abstraction folders (only those with documents)
        if (n === '/') {
            const folders = [];
            for (const { folder, feature } of ABSTRACTIONS) {
                const docs = await this.#listDocs(feature, 1);
                if (docs && docs.length > 0) {
                    folders.push({ name: folder, isDir: true, size: 0 });
                }
            }
            return folders;
        }

        const parts = n.split('/').filter(Boolean);
        if (parts.length === 1 && FOLDER_MAP.has(parts[0])) {
            return await this.#readdirFolder(parts[0]);
        }

        return null;
    }

    async getContent(vPath) {
        const info = await this.stat(vPath);
        if (!info || info.isDir) return null;

        if (info.localFile) {
            const st = await fsStat(info.localFile).catch(() => null);
            if (st) {
                return {
                    stream: createReadStream(info.localFile),
                    size: st.size,
                    contentType: mimeFor(info.localFile),
                };
            }
        }

        const buf = Buffer.from(JSON.stringify(info.doc, null, 2), 'utf-8');
        return { buffer: buf, size: buf.length, contentType: 'application/json' };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    async #readdirFolder(folderName) {
        const feature = FOLDER_MAP.get(folderName);
        const docs = await this.#listDocs(feature, 1000);
        if (!docs?.length) return [];

        const entries = [];
        const used = new Set();

        for (const doc of docs) {
            let name = docName(doc);
            if (used.has(name)) {
                const e = path.extname(name);
                name = `${path.basename(name, e)}_${doc.id}${e}`;
            }
            used.add(name);

            const local = this.#localPath(doc);
            const sz = local
                ? (await fsStat(local).catch(() => null))?.size ?? 0
                : Buffer.byteLength(JSON.stringify(doc, null, 2));
            entries.push({ name, isDir: false, size: sz });
        }

        return entries;
    }

    async #findDoc(folderName, filename) {
        const feature = FOLDER_MAP.get(folderName);
        const docs = await this.#listDocs(feature, 1000);
        if (!docs?.length) return null;
        return docs.find(d => docName(d) === filename) || null;
    }

    async #listDocs(feature, limit) {
        try {
            return await this.#ctx.listDocuments(
                this.#ctx.userId, [feature], [], { limit, parse: true }
            );
        } catch { return null; }
    }

    #localPath(doc) {
        const ws = this.#ctx.workspace;
        if (!ws) return null;
        for (const dp of doc.metadata?.dataPaths || []) {
            if (!dp.startsWith('file://')) continue;
            const p = dp.slice(7).replace('{WORKSPACE_ROOT}', ws.rootPath);
            if (existsSync(p)) return p;
        }
        return null;
    }
}

// ── Module-level helpers ────────────────────────────────────────────────────

function norm(p) {
    if (!p || p === '/') return '/';
    let n = p.startsWith('/') ? p : '/' + p;
    if (n !== '/' && n.endsWith('/')) n = n.slice(0, -1);
    return n;
}

function docName(doc) {
    if (doc.data?.filename) return doc.data.filename;
    if (doc.data?.title) return `${sanitize(doc.data.title)}.json`;
    if (doc.data?.subject) return `${sanitize(doc.data.subject)}.json`;
    if (doc.data?.url) return `${sanitize(doc.data.url)}.json`;
    const schema = (doc.schema || 'doc').split('/').pop();
    return `${schema}_${doc.id}.json`;
}

function sanitize(s) {
    return String(s).replace(/[/\\:*?"<>|]/g, '_').slice(0, 100);
}

const EXT_MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain',
    '.md': 'text/markdown', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.gz': 'application/gzip', '.tar': 'application/x-tar',
    '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav',
};

function mimeFor(filePath) {
    return EXT_MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}
