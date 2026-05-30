'use strict';

import path from 'path';
import {
    docEntries, docName, docSize, httpError, inferDocFromFile,
    norm, resolveDocContent,
} from './vfs-shared.js';

/**
 * Virtual filesystem adapter for a workspace tree (context OR directory type).
 *
 * Reads are fully type-agnostic — both tree types expose list({ path }) and
 * listDirectories(path), so child folders and documents map onto an FS the
 * same way regardless of bitmap semantics. The only type-specific behaviour
 * is the write selector (context layers vs directory folders).
 */
export default class TreeFS {
    #ws;
    #tree;

    constructor(workspace, tree) {
        this.#ws = workspace;
        this.#tree = tree;
    }

    // ── Read API ─────────────────────────────────────────────────────────────

    async stat(vPath) {
        const n = norm(vPath);
        if (n === '/' || this.#tree.pathExists(n)) {
            return { isDir: true, name: path.posix.basename(n) || this.#tree.name, size: 0 };
        }

        const parent = path.posix.dirname(n);
        const fname = path.posix.basename(n);
        if (parent === '/' || this.#tree.pathExists(parent)) {
            const doc = await this.#findDoc(parent, fname);
            if (doc) { return { isDir: false, name: fname, size: await docSize(doc, this.#ws.rootPath), doc }; }
        }
        return null;
    }

    async readdir(vPath) {
        const n = norm(vPath);
        if (n !== '/' && !this.#tree.pathExists(n)) { return null; }

        const used = new Set();
        const dirs = (await this.#tree.listDirectories(n)).map((name) => {
            used.add(name);
            return { name, isDir: true, size: 0 };
        });
        const files = await docEntries(await this.#list(n), this.#ws.rootPath, used);
        return [...dirs, ...files];
    }

    async getContent(vPath) {
        const info = await this.stat(vPath);
        if (!info || info.isDir) { return null; }
        return resolveDocContent(this.#ws, info.doc, info.name);
    }

    // ── Write API ────────────────────────────────────────────────────────────

    async put(vPath, body) {
        const n = norm(vPath);
        const parent = path.posix.dirname(n);
        const filename = path.posix.basename(n);
        if (!filename || parent === n) { throw httpError(400, 'Invalid path'); }

        const inferred = inferDocFromFile(filename, body);
        if (!inferred) { throw httpError(403, 'Only .md / .todo.json / .url are writable here'); }

        if (!this.#tree.pathExists(parent)) { await this.#tree.insertPath(parent); }

        const existing = await this.#findDoc(parent, filename);
        const data = { ...(existing?.data || {}), ...inferred.data, filename };
        const record = existing ? { ...existing, data } : { schema: inferred.schema, data };
        await this.#ws.put(record, this.#target(parent));
        return { created: !existing };
    }

    async del(vPath) {
        const n = norm(vPath);
        const parent = path.posix.dirname(n);
        const filename = path.posix.basename(n);

        const doc = await this.#findDoc(parent, filename);
        if (doc) {
            await this.#ws.unlink(doc.id, this.#target(parent));
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
        if (this.#tree.pathExists(n)) { throw httpError(405, 'Already exists'); }
        await this.#tree.insertPath(n);
        return { created: true };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    async #list(treePath) {
        try {
            const docs = await this.#tree.list({ path: treePath, parse: true, limit: 1000 });
            return Array.isArray(docs) ? docs : [];
        } catch { return []; }
    }

    async #findDoc(treePath, filename) {
        return (await this.#list(treePath)).find((d) => docName(d) === filename) || null;
    }

    // Write target selector: context trees tick layer bitmaps, directory trees
    // tick self-contained folder bitmaps.
    #target(parent) {
        return this.#tree.type === 'directory'
            ? { directory: this.#ws.getDirectoryTreeSelector(parent, this.#tree.name) }
            : { context: this.#ws.getContextTreeSelector(parent, this.#tree.name) };
    }
}
