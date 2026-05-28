'use strict';

import path from 'path';
import { createReadStream } from 'fs';
import { stat as fsStat } from 'fs/promises';
import { docName, inferDocFromFile, localPath, mimeFor, norm } from './vfs-shared.js';

/**
 * Virtual filesystem adapter for the workspace DirectoryTree (VFS).
 * Same shape as VirtualContextFS but indexed via the directory tree's
 * path bitmap (find/OIDs → docs).
 */
export default class VirtualDirectoryFS {
    #ws;
    #tree;

    constructor(workspace, tree = null) {
        this.#ws = workspace;
        this.#tree = tree || workspace.getDefaultDirectoryTree();
    }

    // ── Read API ─────────────────────────────────────────────────────────────

    async stat(vPath) {
        const n = norm(vPath);
        const dirTree = this.#tree;

        if (n === '/') return { isDir: true, name: 'Directories', size: 0 };

        if (dirTree.pathExists(n)) {
            return { isDir: true, name: path.posix.basename(n), size: 0 };
        }

        const parent = path.posix.dirname(n);
        const basename = path.posix.basename(n);
        const childDirs = await dirTree.listDirectories(parent);
        if (childDirs.includes(basename)) {
            return { isDir: true, name: basename, size: 0 };
        }

        if (parent === '/' || dirTree.pathExists(parent)) {
            const doc = await this.#findDoc(parent, basename);
            if (doc) {
                const local = localPath(doc, this.#ws.rootPath);
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

        const childDirs = await dirTree.listDirectories(n);
        for (const name of childDirs) {
            entries.push({ name, isDir: true, size: 0 });
            used.add(name);
        }

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

                const local = localPath(doc, this.#ws.rootPath);
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

    // ── Write API ────────────────────────────────────────────────────────────

    async put(vPath, body) {
        const n = norm(vPath);
        const parent = path.posix.dirname(n);
        const filename = path.posix.basename(n);
        if (!filename || parent === n) throw httpError(400, 'Invalid path');

        const inferred = inferDocFromFile(filename, body);
        if (!inferred) throw httpError(403, 'Only .md / .todo.json / .url are writable here');

        if (!this.#tree.pathExists(parent)) await this.#tree.insertPath(parent);

        const existing = await this.#findDoc(parent, filename);
        const selector = this.#ws.getDirectoryTreeSelector(parent, this.#tree.name);

        if (existing) {
            await this.#ws.put({ ...existing, data: { ...existing.data, ...inferred.data, filename } }, { directory: selector });
            return { created: false };
        }
        await this.#ws.put({ schema: inferred.schema, data: { ...inferred.data, filename } }, { directory: selector });
        return { created: true };
    }

    async del(vPath) {
        const n = norm(vPath);
        const parent = path.posix.dirname(n);
        const filename = path.posix.basename(n);

        // Doc takes precedence over tree-path delete (unlink semantics)
        const doc = await this.#findDoc(parent, filename);
        if (doc) {
            const selector = this.#ws.getDirectoryTreeSelector(parent, this.#tree.name);
            await this.#ws.unlink(doc.id, { directory: selector });
            return { deleted: 'doc' };
        }

        if (this.#tree.pathExists(n)) {
            await this.#tree.removePath(n, true);
            return { deleted: 'path' };
        }
        throw httpError(404, 'Not Found');
    }

    async mkcol(vPath) {
        const n = norm(vPath);
        if (this.#tree.pathExists(n)) throw httpError(405, 'Already exists');
        await this.#tree.insertPath(n);
        return { created: true };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    async #findDoc(dirPath, filename) {
        const bitmap = await this.#tree.find(dirPath);
        if (!bitmap || bitmap.size === 0) return null;

        const oids = bitmap.toArray().slice(0, 1000);
        const docs = await this.#ws.getDocumentsByIdArray(oids);
        return docs.find(d => d && docName(d) === filename) || null;
    }
}

function httpError(statusCode, message) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}
