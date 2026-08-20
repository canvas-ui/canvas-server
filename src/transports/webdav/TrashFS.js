'use strict';

import path from 'path';
import { docEntries, docName, fileEntry, httpError, norm, resolveDocContent } from './vfs-shared.js';

/**
 * The workspace trash as a flat folder.
 *
 * Physically this is one path (`Workspace.TRASH_PATH`) in the default directory
 * tree; presenting it at the DAV root is what makes the universal gesture work —
 * drag a file onto Trash to really remove it, drag it out to restore it.
 *
 * Deliberately flat: the trash is a holding area, not a hierarchy. It answers
 * the same two re-tag verbs as TreeFS (`linkDoc`/`unlinkDoc`), which is how
 * MOVE composes across roots without either side knowing about the other.
 */
export default class TrashFS {
    #ws;

    constructor(workspace) {
        this.#ws = workspace;
    }

    // ── Read ─────────────────────────────────────────────────────────────────

    async #docs() {
        const { documents } = await this.#ws.listTrash().catch(() => ({ documents: [] }));
        return documents || [];
    }

    async #findDoc(filename) {
        return (await this.#docs()).find((doc) => docName(doc) === filename) || null;
    }

    async stat(vPath) {
        const n = norm(vPath);
        if (n === '/') { return { isDir: true, name: 'Trash', size: 0 }; }

        const parts = n.split('/').filter(Boolean);
        if (parts.length !== 1) { return null; } // flat by design

        const doc = await this.#findDoc(parts[0]);
        return doc ? fileEntry(doc, parts[0]) : null;
    }

    async readdir(vPath) {
        if (norm(vPath) !== '/') { return null; }
        return docEntries(await this.#docs());
    }

    async getContent(vPath, options = {}) {
        const info = await this.stat(vPath);
        if (!info || info.isDir) { return null; }
        return resolveDocContent(this.#ws, info.doc, info.name, options);
    }

    // ── Write ────────────────────────────────────────────────────────────────

    /** Nothing is authored in the trash — it is only ever moved in or out. */
    async put() { throw httpError(403, 'The trash is not writable — move items into it instead'); }

    async mkcol() { throw httpError(403, 'The trash is flat'); }

    /**
     * DELETE inside the trash is the permanent one — same as a file manager's
     * "delete from trash". This is the ONLY filesystem path that destroys, and
     * it cascades to canvas-owned (`stored://`) blobs only.
     */
    async del(vPath) {
        const n = norm(vPath);
        if (n === '/') {
            await this.#ws.emptyTrash();
            return { deleted: 'all' };
        }

        const doc = await this.#findDoc(path.posix.basename(n));
        if (!doc) { throw httpError(404, 'Not Found'); }
        await this.#ws.emptyTrash({ documentIds: [doc.id] });
        return { deleted: 'doc' };
    }

    // ── Re-tag API (MOVE) ────────────────────────────────────────────────────

    async docAt(vPath) {
        const info = await this.stat(vPath);
        return info && !info.isDir ? info.doc : null;
    }

    /**
     * Dragging something ONTO the trash is the explicit "remove it, everywhere"
     * gesture — unlike a plain delete, which only detaches from one path. So
     * unfile it from every placement first, then trash it.
     */
    async linkDoc(_vPath, doc) {
        for (const placement of await this.#ws.listDocumentPlacements(doc.id)) {
            const tree = this.#ws.getTree(placement.treeId);
            if (!tree) { continue; }
            for (const treePath of placement.paths) {
                // The context root is not a placement anyone filed (see
                // Workspace #isFiled) and unlinking from it is refused anyway.
                if (placement.type === 'context' && treePath === '/') { continue; }
                const target = placement.type === 'directory'
                    ? { directory: this.#ws.getDirectoryTreeSelector(treePath, tree.name) }
                    : { context: this.#ws.getContextTreeSelector(treePath, tree.name) };
                // The last one carries the flag: that unlink is the one that
                // orphans the document, and it does the filing into the trash.
                await this.#ws.unlink(doc.id, target, { trashIfOrphaned: true });
            }
        }
        return { linked: true };
    }

    /**
     * Moving OUT of the trash restores. The re-filing at the destination is what
     * actually un-trashes it (Workspace drops the trash tick on any link to a
     * real path), so this only has to not fight it.
     */
    async unlinkDoc() { return { unlinked: true }; }
}
