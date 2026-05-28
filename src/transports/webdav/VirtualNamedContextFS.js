'use strict';

import path from 'path';
import { createReadStream } from 'fs';
import { stat as fsStat } from 'fs/promises';
import schemaRegistry from '../../services/synapsd/src/schemas/SchemaRegistry.js';
import { docName as sharedDocName, norm as sharedNorm, localPath as sharedLocalPath } from './vfs-shared.js';

/**
 * Virtual filesystem for a named context's WebDAV view.
 * Shows one folder per data abstraction containing documents of that type.
 * No tree traversal — flat folders only.
 *
 * /Notes/          → documents with feature 'data/abstraction/note'
 * /Tabs/           → documents with feature 'data/abstraction/tab'
 * /Files/          → documents with feature 'data/abstraction/file'
 * ...etc (dynamically derived from SchemaRegistry)
 */

// Build folder ↔ feature mapping from SchemaRegistry
const DATA_PREFIX = 'data/abstraction/';

function buildAbstractionMap() {
    const schemas = schemaRegistry.listSchemas(DATA_PREFIX);
    const map = new Map();
    for (const schemaId of schemas) {
        const slug = schemaId.slice(DATA_PREFIX.length);
        const folder = slug.charAt(0).toUpperCase() + slug.slice(1) + 's';
        map.set(folder, schemaId);
    }
    return map;
}

const FOLDER_MAP = buildAbstractionMap();

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
                return {
                    isDir: false, name: parts[1], size: sz,
                    contentType: docContentType(doc),
                    doc, localFile: local || null,
                };
            }
        }

        return null;
    }

    async readdir(vPath) {
        const n = norm(vPath);

        // Root → list abstraction folders (only those with documents)
        if (n === '/') {
            const folders = [];
            for (const [folder, feature] of FOLDER_MAP) {
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
                    contentType: docContentType(info.doc),
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
            entries.push({ name, isDir: false, size: sz, contentType: docContentType(doc) });
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
            return await this.#ctx.list(this.#ctx.userId, {
                attributes: { allOf: [feature] },
                options: { limit, parse: true },
            });
        } catch { return null; }
    }

    #localPath(doc) {
        return sharedLocalPath(doc, this.#ctx.workspace?.rootPath);
    }
}

// ── Module-level helpers ────────────────────────────────────────────────────

const norm = sharedNorm;
const docName = sharedDocName;

function docContentType(doc) {
    return doc.data?.mime || doc.metadata?.contentType || 'application/octet-stream';
}
