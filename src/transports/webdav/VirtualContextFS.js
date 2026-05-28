'use strict';

import path from 'path';
import { createReadStream } from 'fs';
import { stat as fsStat } from 'fs/promises';
import { docName, inferDocFromFile, localPath, mimeFor, norm } from './vfs-shared.js';

/**
 * Virtual filesystem adapter for the workspace context tree.
 * Maps the tree structure to a FS-like interface so WebDAV can browse it
 * as if it were a normal directory hierarchy.
 *
 * Tree nodes → directories. Documents at each tree path → files.
 * Writes are extension-inferred: .md → note, .todo.json → todo, .url → tab.
 */
export default class VirtualContextFS {
    #ws;
    #tree;

    constructor(workspace, tree = null) {
        this.#ws = workspace;
        this.#tree = tree || workspace.getDefaultContextTree();
    }

    // ── Read API ─────────────────────────────────────────────────────────────

    async stat(vPath) {
        const n = norm(vPath);
        const tree = this.#tree;

        if (n === '/' || tree.pathExists(n)) {
            return { isDir: true, name: path.posix.basename(n) || 'context', size: 0 };
        }

        const parent = path.posix.dirname(n);
        const fname = path.posix.basename(n);
        if (parent !== n && tree.pathExists(parent)) {
            const doc = await this.#findDoc(parent, fname);
            if (doc) {
                const local = localPath(doc, this.#ws.rootPath);
                const sz = local
                    ? (await fsStat(local).catch(() => null))?.size ?? 0
                    : Buffer.byteLength(JSON.stringify(doc, null, 2));
                return { isDir: false, name: fname, size: sz, doc, localFile: local || null };
            }
        }
        return null;
    }

    async readdir(vPath) {
        const n = norm(vPath);
        const tree = this.#tree;
        if (n !== '/' && !tree.pathExists(n)) return null;

        const entries = [];
        const used = new Set();

        const node = this.#treeNode(n);
        if (node?.children) {
            for (const c of node.children) {
                entries.push({ name: c.name, isDir: true, size: 0 });
                used.add(c.name);
            }
        }

        try {
            const docs = await tree.list({ path: n, parse: true, limit: 1000 });
            if (Array.isArray(docs)) {
                for (const doc of docs) {
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
        } catch { /* empty directory is fine */ }

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

        const buf = renderDocBuffer(info.doc);
        return { buffer: buf, size: buf.length, contentType: contentTypeForDoc(info.doc) };
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
        const selector = this.#ws.getContextTreeSelector(parent, this.#tree.name);

        if (existing) {
            await this.#ws.put({ ...existing, data: { ...existing.data, ...inferred.data, filename } }, { context: selector });
            return { created: false };
        }
        await this.#ws.put({ schema: inferred.schema, data: { ...inferred.data, filename } }, { context: selector });
        return { created: true };
    }

    async del(vPath) {
        const n = norm(vPath);
        const parent = path.posix.dirname(n);
        const filename = path.posix.basename(n);

        const doc = await this.#findDoc(parent, filename);
        if (doc) {
            const selector = this.#ws.getContextTreeSelector(parent, this.#tree.name);
            await this.#ws.unlink(doc.id, { context: selector });
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

    #treeNode(vPath) {
        const json = this.#tree.buildJsonTree();
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
            const docs = await this.#tree.list({ path: treePath, parse: true, limit: 1000 });
            return Array.isArray(docs) ? docs.find(d => docName(d) === filename) || null : null;
        } catch { return null; }
    }
}

// ── Module-level helpers ────────────────────────────────────────────────────

function httpError(statusCode, message) {
    const err = new Error(message);
    err.statusCode = statusCode;
    return err;
}

function renderDocBuffer(doc) {
    if (doc.schema === 'data/abstraction/note') return Buffer.from(String(doc.data?.content ?? ''), 'utf-8');
    if (doc.schema === 'data/abstraction/tab')  return Buffer.from(`[InternetShortcut]\nURL=${doc.data?.url ?? ''}\n`, 'utf-8');
    if (doc.schema === 'data/abstraction/todo') return Buffer.from(JSON.stringify(doc.data ?? {}, null, 2), 'utf-8');
    return Buffer.from(JSON.stringify(doc, null, 2), 'utf-8');
}

function contentTypeForDoc(doc) {
    if (doc.schema === 'data/abstraction/note') return 'text/markdown; charset=utf-8';
    if (doc.schema === 'data/abstraction/tab')  return 'application/internet-shortcut';
    return 'application/json';
}
