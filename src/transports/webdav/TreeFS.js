'use strict';

import path from 'path';
import {
    applyBodyToDoc, collectDocuments, docEntries, docName, fileDocumentFromBlob, fileEntry,
    findDocumentByName, httpError, inferDocFromFile, LIST_BUDGET, norm, renamedRecord,
    resolveDocContent,
} from './vfs-shared.js';
import Workspace from '../../core/workspace/Workspace.js';
import { createLogger } from '../../utils/log.js';

const logger = createLogger('webdav');

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

    // Identity, so a MOVE can tell "same tree" (a folder move is a tree
    // operation) from "different tree" (only documents can cross).
    get treeId() { return this.#tree.id; }
    get treeName() { return this.#tree.name; }

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
            if (doc) { return fileEntry(doc, fname); }
        }
        return null;
    }

    async readdir(vPath) {
        const n = norm(vPath);
        if (n !== '/' && !this.#tree.pathExists(n)) { return null; }

        const used = new Set();
        const dirs = (await this.#dirNames(n)).map((name) => {
            used.add(name);
            return { name, isDir: true, size: 0 };
        });
        const files = docEntries(await this.#list(n), used);
        return [...dirs, ...files];
    }

    /**
     * `options.doc` is the document the caller already resolved. Worth passing:
     * resolving a name in a flat view means walking the view, and a GET that
     * stats and then reads would otherwise walk it twice for one file.
     */
    async getContent(vPath, options = {}) {
        if (options.doc) {
            return resolveDocContent(this.#ws, options.doc, path.posix.basename(norm(vPath)), options);
        }
        const info = await this.stat(vPath);
        if (!info || info.isDir) { return null; }
        return resolveDocContent(this.#ws, info.doc, info.name, options);
    }

    // ── Write API ────────────────────────────────────────────────────────────

    /**
     * Write a file into a tree path.
     *
     * A file is a file: anything without a canvas-native meaning becomes a File
     * document whose bytes go to the local blob store. `.todo.json` and `.url`
     * still create their abstractions (see inferDocFromFile), and an EXISTING
     * document is updated in its own schema — saving over a note edits the
     * note, it does not convert it to a file.
     */
    async put(vPath, body) {
        const n = norm(vPath);
        const parent = path.posix.dirname(n);
        const filename = path.posix.basename(n);
        if (!filename || parent === n) { throw httpError(400, 'Invalid path'); }

        if (!this.#tree.pathExists(parent)) { await this.#tree.insertPath(parent); }
        const target = this.#target(parent);
        const existing = await this.#findDoc(parent, filename);

        if (existing) {
            const updated = applyBodyToDoc(existing, filename, body);
            if (updated) {
                await this.#ws.put({ ...updated, data: { ...updated.data, filename } }, target);
                return { created: false };
            }
            // Bytes: a new blob, same document id — the checksum moves with the
            // content, the placements and the name stay put.
            const blob = await this.#ws.persistBlob(body);
            await this.#ws.put(fileDocumentFromBlob(blob, filename, existing), target);
            return { created: false };
        }

        const inferred = inferDocFromFile(filename, body);
        if (inferred) {
            await this.#ws.put({ schema: inferred.schema, data: { ...inferred.data, filename } }, target);
            return { created: true };
        }

        const blob = await this.#ws.persistBlob(body);
        await this.#ws.put(fileDocumentFromBlob(blob, filename), target);
        return { created: true };
    }

    /** File an already-persisted blob at `vPath` (the Home → tree ingest path). */
    async putFile(vPath, blob) {
        const n = norm(vPath);
        const parent = path.posix.dirname(n);
        const filename = path.posix.basename(n);
        if (!filename || parent === n) { throw httpError(400, 'Invalid path'); }

        if (!this.#tree.pathExists(parent)) { await this.#tree.insertPath(parent); }
        const existing = await this.#findDoc(parent, filename);
        await this.#ws.put(fileDocumentFromBlob(blob, filename, existing), this.#target(parent));
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

        // A different basename at the destination is a rename. Where that name
        // is recorded depends on the schema (a File names itself in metadata,
        // JSON abstractions in data) — renamedRecord() owns that rule.
        if (docName(doc) !== filename) {
            await this.#ws.put(renamedRecord(doc, filename), this.#target(parent));
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

    // ── Folder operations ────────────────────────────────────────────────────
    // Moving or renaming a FOLDER is a tree operation, not a document one: the
    // node moves and every document filed under it comes along, untouched.

    async movePath(fromVPath, toVPath) {
        const from = norm(fromVPath);
        const to = norm(toVPath);
        if (this.#isTrashPath(from) || this.#isTrashPath(to)) { throw httpError(403, 'The trash is not a tree folder'); }
        if (!this.#tree.pathExists(from)) { throw httpError(404, 'Not Found'); }
        await this.#tree.movePath(from, to);
        return { moved: 'path' };
    }

    async copyPath(fromVPath, toVPath) {
        const from = norm(fromVPath);
        const to = norm(toVPath);
        if (this.#isTrashPath(from) || this.#isTrashPath(to)) { throw httpError(403, 'The trash is not a tree folder'); }
        if (!this.#tree.pathExists(from)) { throw httpError(404, 'Not Found'); }
        await this.#tree.copyPath(from, to, true);
        return { copied: 'path' };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    #isTrashPath(candidate) {
        return this.#tree.name === Workspace.DIRECTORY_TREE_NAME && norm(candidate) === Workspace.TRASH_PATH;
    }


    // Child folder names at `treePath`. The trash is a real path in this tree,
    // but it has its own root in the DAV layout — showing it here too would
    // offer two doors into the same folder, one of which ignores the trash
    // semantics.
    async #dirNames(treePath) {
        return (await this.#tree.listDirectories(treePath))
            .filter((name) => !this.#isTrashPath(path.posix.join(treePath, name)));
    }

    #page(treePath) {
        return (offset, limit) => this.#tree.list({ path: treePath, parse: true, limit, offset });
    }

    async #list(treePath) {
        return collectDocuments(this.#page(treePath), (count) => {
            logger.warn({ tree: this.#tree.name, path: treePath, shown: count, budget: LIST_BUDGET },
                'Listing truncated: this view holds more documents than one listing carries');
        });
    }

    // Resolved page by page, stopping at the match — a view can hold far more
    // documents than one page, and a name that only the tenth page carries has
    // to open like any other.
    async #findDoc(treePath, filename) {
        return findDocumentByName(this.#page(treePath), filename, await this.#dirNames(treePath));
    }

    // Write target selector: context trees tick layer bitmaps, directory trees
    // tick self-contained folder bitmaps.
    #target(parent) {
        return this.#tree.type === 'directory'
            ? { directory: this.#ws.getDirectoryTreeSelector(parent, this.#tree.name) }
            : { context: this.#ws.getContextTreeSelector(parent, this.#tree.name) };
    }
}
