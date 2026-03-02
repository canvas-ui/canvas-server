'use strict';

import path from 'path';
import { existsSync, createReadStream } from 'fs';
import { stat as fsStat } from 'fs/promises';

/**
 * Virtual filesystem adapter for the workspace context tree.
 * Maps the tree structure to a FS-like interface so WebDAV can browse it
 * as if it were a normal directory hierarchy.
 *
 * Tree nodes → directories
 * Documents at each tree path → files
 */
export default class VirtualContextFS {
    #ws;

    constructor(workspace) { this.#ws = workspace; }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Stat a virtual path. Returns descriptor or null.
     * @returns {{ isDir, name, size, doc?, localFile? } | null}
     */
    async stat(vPath) {
        const n = norm(vPath);
        const tree = this.#ws.tree;

        // Tree node → directory
        if (n === '/' || tree.pathExists(n)) {
            return { isDir: true, name: path.posix.basename(n) || 'context', size: 0 };
        }

        // Document → file
        const parent = path.posix.dirname(n);
        const fname = path.posix.basename(n);
        if (parent !== n && tree.pathExists(parent)) {
            const doc = await this.#findDoc(parent, fname);
            if (doc) {
                const local = this.#localPath(doc);
                const sz = local
                    ? (await fsStat(local).catch(() => null))?.size ?? 0
                    : Buffer.byteLength(JSON.stringify(doc, null, 2));
                return { isDir: false, name: fname, size: sz, doc, localFile: local || null };
            }
        }
        return null;
    }

    /**
     * List entries in a virtual directory.
     * @returns {Array<{ name, isDir, size }>|null}
     */
    async readdir(vPath) {
        const n = norm(vPath);
        const tree = this.#ws.tree;
        if (n !== '/' && !tree.pathExists(n)) return null;

        const entries = [];
        const used = new Set();

        // 1. Child tree nodes → subdirectories
        const node = this.#treeNode(n);
        if (node?.children) {
            for (const c of node.children) {
                entries.push({ name: c.name, isDir: true, size: 0 });
                used.add(c.name);
            }
        }

        // 2. Documents → files
        try {
            const docs = await tree.findDocuments(n, [], [], { parse: true, limit: 1000 });
            if (Array.isArray(docs)) {
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
            }
        } catch { /* empty directory is fine */ }

        return entries;
    }

    /**
     * Get file content for a virtual path.
     * @returns {{ stream?, buffer?, size, contentType }|null}
     */
    async getContent(vPath) {
        const info = await this.stat(vPath);
        if (!info || info.isDir) return null;

        // Serve actual file from storage backend if available
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

        // Fallback: serve document as JSON
        const buf = Buffer.from(JSON.stringify(info.doc, null, 2), 'utf-8');
        return { buffer: buf, size: buf.length, contentType: 'application/json' };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    #treeNode(vPath) {
        const json = this.#ws.tree.buildJsonTree();
        if (vPath === '/') return json;
        let node = json;
        for (const s of vPath.split('/').filter(Boolean)) {
            node = node.children?.find(c => c.name === s);
            if (!node) return null;
        }
        return node;
    }

    async #findDoc(treePath, filename) {
        try {
            const docs = await this.#ws.tree.findDocuments(treePath, [], [], { parse: true, limit: 1000 });
            return Array.isArray(docs) ? docs.find(d => docName(d) === filename) || null : null;
        } catch { return null; }
    }

    #localPath(doc) {
        for (const dp of doc.metadata?.dataPaths || []) {
            if (!dp.startsWith('file://')) continue;
            const p = dp.slice(7).replace('{WORKSPACE_ROOT}', this.#ws.rootPath);
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
    const schema = (doc.schema || 'doc').split('/').pop();
    return `${schema}_${doc.id}.json`;
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
