'use strict';

import path from 'path';
import { existsSync, createReadStream } from 'fs';
import { stat as fsStat } from 'fs/promises';

/**
 * Virtual filesystem adapter for the workspace DirectoryTree (VFS).
 * Maps traditional path-based directory structure to a FS-like interface
 * for WebDAV browsing.
 *
 * DirectoryTree nodes → directories
 * Documents at each path → files
 */
export default class VirtualDirectoryFS {
    #ws;
    #tree;

    constructor(workspace, tree = null) {
        this.#ws = workspace;
        this.#tree = tree || workspace.getDefaultDirectoryTree();
    }

    // ── Public API ───────────────────────────────────────────────────────────

    async stat(vPath) {
        const n = norm(vPath);
        const dirTree = this.#tree;

        // Root always exists
        if (n === '/') return { isDir: true, name: 'Directories', size: 0 };

        // Has documents directly → directory
        if (dirTree.pathExists(n)) {
            return { isDir: true, name: path.posix.basename(n), size: 0 };
        }

        // Known child directory segment of parent
        const parent = path.posix.dirname(n);
        const basename = path.posix.basename(n);
        const childDirs = await dirTree.listDirectories(parent);
        if (childDirs.includes(basename)) {
            return { isDir: true, name: basename, size: 0 };
        }

        // Document at parent path
        if (parent === '/' || dirTree.pathExists(parent)) {
            const doc = await this.#findDoc(parent, basename);
            if (doc) {
                const local = this.#localPath(doc);
                const sz = local
                    ? (await fsStat(local).catch(() => null))?.size ?? 0
                    : Buffer.byteLength(JSON.stringify(doc, null, 2));
                return { isDir: false, name: basename, size: sz, doc, localFile: local || null };
            }
        }

        return null;
    }

    async readdir(vPath) {
        const n = norm(vPath);
        const dirTree = this.#tree;

        const entries = [];
        const used = new Set();

        // 1. Child directories
        const childDirs = await dirTree.listDirectories(n);
        for (const name of childDirs) {
            entries.push({ name, isDir: true, size: 0 });
            used.add(name);
        }

        // 2. Documents at this path (bitmap → OIDs → documents)
        const bitmap = await dirTree.find(n);
        if (bitmap && bitmap.size > 0) {
            const oids = bitmap.toArray().slice(0, 1000);
            const docs = await this.#ws.getDocumentsByIdArray(oids);

            for (const doc of docs) {
                if (!doc) continue;
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

        return entries;
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

    async #findDoc(dirPath, filename) {
        const bitmap = await this.#tree.find(dirPath);
        if (!bitmap || bitmap.size === 0) return null;

        const oids = bitmap.toArray().slice(0, 1000);
        const docs = await this.#ws.getDocumentsByIdArray(oids);
        return docs.find(d => d && docName(d) === filename) || null;
    }

    #localPath(doc) {
        const urls = (doc.locations || []).map((l) => l.url);
        for (const url of urls) {
            if (!url.startsWith('file://')) continue;
            const p = url.slice(7).replace('{WORKSPACE_ROOT}', this.#ws.rootPath);
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
