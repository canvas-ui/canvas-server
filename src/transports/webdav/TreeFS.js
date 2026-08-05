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
            if (doc) { return { isDir: false, name: fname, size: docSize(doc), doc }; }
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
        const files = docEntries(await this.#list(n), used);
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

    /**
     * `rm` detaches from THIS path — the document survives in the store and in
     * every other path it is filed under. `trashIfOrphaned` adds the mount rule:
     * if this was its last placement it lands in the trash rather than becoming
     * reachable only through the flat workspace-wide list.
     */
    async del(vPath, { trashIfOrphaned = false } = {}) {
        const n = norm(vPath);
        const parent = path.posix.dirname(n);
        const filename = path.posix.basename(n);

        const doc = await this.#findDoc(parent, filename);
        if (doc) {
            await this.#ws.unlink(doc.id, this.#target(parent), { trashIfOrphaned });
            return { deleted: 'doc' };
        }
        if (this.#tree.pathExists(n)) {
            await this.#tree.removePath(n, true);
            return { deleted: 'path' };
        }
        throw httpError(404, 'Not Found');
    }

    // ── Re-tag API (MOVE) ────────────────────────────────────────────────────
    // A move is a change of membership, never a transfer of bytes: file the
    // document at the destination, unfile it at the source. Both halves work on
    // the document id, so a 4GB blob moves as cheaply as a note — and it works
    // across trees and across roots, since every virtual FS speaks the same two
    // verbs.

    /** The document behind a path, or null. */
    async docAt(vPath) {
        const info = await this.stat(norm(vPath));
        return info && !info.isDir ? info.doc : null;
    }

    /**
     * File an existing document at `vPath`. When the destination basename
     * differs from the document's current name this is also a rename, which is
     * a filename update — the document keeps its id, content and checksums.
     */
    async linkDoc(vPath, doc) {
        const n = norm(vPath);
        const parent = path.posix.dirname(n);
        const filename = path.posix.basename(n);
        if (!filename || parent === n) { throw httpError(400, 'Invalid path'); }

        if (!this.#tree.pathExists(parent)) { await this.#tree.insertPath(parent); }
        await this.#ws.link(doc.id, this.#target(parent));

        if (docName(doc) !== filename) {
            await this.#ws.put({ ...doc, data: { ...(doc.data || {}), filename } }, this.#target(parent));
        }
        return { linked: true };
    }

    /** Unfile a document from `vPath`'s directory. */
    async unlinkDoc(vPath, doc, { trashIfOrphaned = false } = {}) {
        const parent = path.posix.dirname(norm(vPath));
        await this.#ws.unlink(doc.id, this.#target(parent), { trashIfOrphaned });
        return { unlinked: true };
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
