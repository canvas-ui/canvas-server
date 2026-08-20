'use strict';

import schemaRegistry from 'canvas-synapsd/src/schemas/SchemaRegistry.js';
import {
    applyBodyToDoc, docEntries, docName, fileDocumentFromBlob, fileEntry, httpError,
    inferDocFromFile, norm, renamedRecord, resolveDocContent,
} from './vfs-shared.js';

/**
 * A named context as a folder.
 *
 * FLAT: the context's documents are its files, named as themselves. What you
 * see is what is filed here, and every gesture means the same thing it means
 * anywhere else on the mount — nothing is inferred from which folder you happen
 * to be standing in.
 *
 * That is a deliberate reversal. This view used to be one folder per schema
 * (`Notes/`, `Tabs/`, …), which made those folders saved queries wearing a
 * folder's clothes: `mkdir` was refused, a copy from `Notes/` into `Files/`
 * reported success and then listed nothing, and the same `.md` bytes were a
 * note here but a file under `Trees/**`. Grouping now lives in `.by-schema/` —
 * derived, read-only, and dotted like every other synthetic view.
 *
 * The flat shape is also what makes a context-bound browser addressable from a
 * file manager: `rm reddit.url` closes that tab, writing a `.url` opens one,
 * and editing one navigates it.
 */

const DATA_PREFIX = 'data/schema/';
const BY_SCHEMA = '.by-schema';

// Folder ↔ schema map for the derived view, built from the registry so a new
// schema gets a folder with no code change.
function buildAbstractionMap() {
    const map = new Map();
    for (const schemaId of schemaRegistry.listSchemas(DATA_PREFIX)) {
        // Folder name from the LAST id segment: ids are hierarchical
        // (data/schema/message/email) and a folder name cannot carry a '/'.
        const slug = schemaId.slice(DATA_PREFIX.length).split('/').pop();
        const folder = slug.charAt(0).toUpperCase() + slug.slice(1) + 's';
        // First registration wins on a last-segment collision — deterministic,
        // and it would only hide the later schema's folder, never corrupt one.
        if (!map.has(folder)) { map.set(folder, schemaId); }
    }
    return map;
}

const FOLDER_MAP = buildAbstractionMap();

export default class VirtualNamedContextFS {
    #ctx;

    constructor(context) { this.#ctx = context; }

    // ── Read ─────────────────────────────────────────────────────────────────

    async stat(vPath) {
        const parts = split(vPath);

        if (parts.length === 0) { return { isDir: true, name: this.#ctx.id || 'context', size: 0 }; }

        if (parts[0] === BY_SCHEMA) {
            if (parts.length === 1) { return { isDir: true, name: BY_SCHEMA, size: 0 }; }
            if (!FOLDER_MAP.has(parts[1])) { return null; }
            if (parts.length === 2) { return { isDir: true, name: parts[1], size: 0 }; }
            if (parts.length === 3) {
                const doc = await this.#findDoc(parts[2], FOLDER_MAP.get(parts[1]));
                return doc ? fileEntry(doc, parts[2]) : null;
            }
            return null;
        }

        if (parts.length !== 1) { return null; } // flat by design
        const doc = await this.#findDoc(parts[0]);
        return doc ? fileEntry(doc, parts[0]) : null;
    }

    async readdir(vPath) {
        const parts = split(vPath);

        if (parts.length === 0) {
            const files = docEntries(await this.#listDocs());
            // Dotted, so it stays out of `cp -r` and out of a file manager's
            // default view.
            return [{ name: BY_SCHEMA, isDir: true, size: 0 }, ...files];
        }

        if (parts[0] === BY_SCHEMA) {
            if (parts.length === 1) {
                const folders = [];
                for (const [folder, schema] of FOLDER_MAP) {
                    if ((await this.#listDocs(schema, 1)).length > 0) {
                        folders.push({ name: folder, isDir: true, size: 0 });
                    }
                }
                return folders;
            }
            if (parts.length === 2 && FOLDER_MAP.has(parts[1])) {
                return docEntries(await this.#listDocs(FOLDER_MAP.get(parts[1])));
            }
        }

        return null;
    }

    async getContent(vPath, options = {}) {
        const info = await this.stat(vPath);
        if (!info || info.isDir) { return null; }
        return resolveDocContent(this.#ctx.workspace, info.doc, info.name, options);
    }

    // ── Write ────────────────────────────────────────────────────────────────
    // A context is a VIEW: writing files a document INTO it, deleting detaches
    // it from the view. Nothing here destroys and nothing here trashes — the
    // document still lives wherever its trees put it.

    async put(vPath, body) {
        const filename = this.#writableName(vPath);

        const existing = await this.#findDoc(filename);
        if (existing) {
            const updated = applyBodyToDoc(existing, filename, body);
            if (updated) {
                await this.#ctx.put(this.#ctx.userId, { ...updated, data: { ...updated.data, filename } });
                return { created: false };
            }
            const blob = await this.#ctx.workspace.persistBlob(body);
            await this.#ctx.put(this.#ctx.userId, fileDocumentFromBlob(blob, filename, existing));
            return { created: false };
        }

        // The same rule as everywhere else on the mount: `.url` and
        // `.todo.json` carry a canvas meaning, anything else is a file.
        const inferred = inferDocFromFile(filename, body);
        if (inferred) {
            await this.#ctx.put(this.#ctx.userId, { schema: inferred.schema, data: { ...inferred.data, filename } });
            return { created: true };
        }

        const blob = await this.#ctx.workspace.persistBlob(body);
        await this.#ctx.put(this.#ctx.userId, fileDocumentFromBlob(blob, filename));
        return { created: true };
    }

    async del(vPath) {
        const filename = this.#writableName(vPath);
        const doc = await this.#findDoc(filename);
        if (!doc) { throw httpError(404, 'Not Found'); }
        // Detach from the view only — a context is a way of looking at
        // documents, not a place they live.
        await this.#ctx.unlink(this.#ctx.userId, doc.id);
        return { deleted: 'doc' };
    }

    async mkcol() {
        throw httpError(403, 'A context is a flat view; grouping lives under .by-schema/');
    }

    // ── Re-tag API (MOVE/COPY) ───────────────────────────────────────────────

    async docAt(vPath) {
        const info = await this.stat(vPath);
        return info && !info.isDir ? info.doc : null;
    }

    async linkDoc(vPath, doc) {
        const filename = this.#writableName(vPath);
        await this.#ctx.workspace.link(doc.id, {
            context: this.#ctx.workspace.getContextTreeSelector(this.#ctx.path || '/'),
        });
        if (docName(doc) !== filename) {
            await this.#ctx.put(this.#ctx.userId, renamedRecord(doc, filename));
        }
        return { linked: true };
    }

    async unlinkDoc(_vPath, doc) {
        await this.#ctx.unlink(this.#ctx.userId, doc.id);
        return { unlinked: true };
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /** The filename a write addresses; the derived view refuses writes. */
    #writableName(vPath) {
        const parts = split(vPath);
        if (parts[0] === BY_SCHEMA) {
            throw httpError(403, `${BY_SCHEMA}/ is a derived view — write to the context folder itself`);
        }
        if (parts.length !== 1) { throw httpError(403, 'A context is a flat view'); }
        return parts[0];
    }

    async #findDoc(filename, schema = null) {
        return (await this.#listDocs(schema)).find((doc) => docName(doc) === filename) || null;
    }

    async #listDocs(schema = null, limit = 1000) {
        try {
            const docs = await this.#ctx.list(this.#ctx.userId, {
                ...(schema ? { attributes: { allOf: [schema] } } : {}),
                options: { limit, parse: true },
            });
            return Array.isArray(docs) ? docs : [];
        } catch { return []; }
    }
}

function split(p) {
    return norm(p).split('/').filter(Boolean);
}

export { BY_SCHEMA, FOLDER_MAP };
