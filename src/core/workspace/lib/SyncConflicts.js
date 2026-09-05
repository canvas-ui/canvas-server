'use strict';

import path from 'path';
import { parseLocationUrl } from 'canvas-synapsd/src/utils/path-helpers.js';
import { BACKENDS_TREE_NAME } from '../../../utils/backend-documents.js';
import { normalizeObjectKey } from './WorkspaceStoredIndex.js';

/**
 * Conflict inbox for device mirrors.
 *
 * When a device and the hub both changed the same key since the device last
 * synced, the hub's version keeps the filename and the device's version lands
 * HERE: a file document in the managed store (`workspace:data`), tagged
 * `custom/sync/conflict`, related `derived-from` to the document currently at
 * the key. Nothing is overwritten. The user then resolves it: keep hub, keep
 * incoming, or keep both (the incoming copy gets a conflict-copy name). Every
 * resolution carries the original's tags, relations and curated placements
 * over to whatever survives, so a conflict never costs curation.
 *
 * `rename` mode (a mirror configured for Dropbox-style behaviour) skips the
 * inbox: the device writes its version straight to the conflict-copy key and
 * the hub only marks it.
 */

export const SYNC_CONFLICT_TAG = 'custom/sync/conflict';
export const CONFLICT_PREDICATE = 'derived-from';
const DATA_BACKEND = 'workspace:data';
const FILE_SCHEMA = 'data/schema/file';

function typed(message, code, statusCode = 400) {
    return Object.assign(new Error(message), { code, statusCode });
}

const stamp = (date = new Date()) => {
    const d = date instanceof Date ? date : new Date(date);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
};

/**
 * `Docs/contract.docx` → `Docs/contract (conflict from laptop 2026-09-05 1412).docx`.
 * Deterministic for one (key, device, minute) so a retried write lands on the
 * same name instead of a second sibling.
 */
export function conflictKey(key, deviceName = 'device', date = new Date()) {
    const dir = key.includes('/') ? key.slice(0, key.lastIndexOf('/') + 1) : '';
    const name = key.slice(dir.length);
    const dot = name.lastIndexOf('.');
    const hasExt = dot > 0;
    const stem = hasExt ? name.slice(0, dot) : name;
    const ext = hasExt ? name.slice(dot) : '';
    const who = String(deviceName || 'device').replace(/[/\\:*?"<>|]+/g, '-').trim() || 'device';
    return `${dir}${stem} (conflict from ${who} ${stamp(date)})${ext}`;
}

const sha256Of = (doc) => {
    const entry = (doc?.checksumArray || []).find((c) => String(c).startsWith('sha256/'));
    return entry ? entry.slice('sha256/'.length) : null;
};

export class SyncConflicts {
    #workspace;
    #getDb;
    #logger;

    constructor({ workspace, getDb, logger }) {
        if (!workspace || typeof getDb !== 'function') throw new Error('workspace and getDb are required');
        this.#workspace = workspace;
        this.#getDb = getDb;
        this.#logger = logger || console;
    }

    /**
     * Record a device's version of `key`. `mode:'inbox'` (default) stores the
     * bytes in the managed store and prompts; `mode:'rename'` writes them to
     * `key` (already the conflict-copy name chosen by the device) and marks
     * the resulting document — both related to the document at `conflictOf`.
     */
    async create({ backend = 'workspace:home', key, conflictOf = null, source, sha256 = null, baseSha256 = null, device = null, deviceName = null, mtime = null, mimeType = undefined, mode = 'inbox' } = {}) {
        const originalKey = normalizeObjectKey(conflictOf ?? key);
        if (!originalKey) throw typed(`Invalid conflict key: ${conflictOf ?? key}`, 'INVALID_KEY', 400);
        if (!source) throw typed('A body is required', 'EMPTY_BODY', 400);
        const ws = this.#workspace;
        const original = await ws.statBackendObject('file', backend, originalKey).catch(() => null);
        const marker = {
            conflictOf: originalKey,
            backend,
            device: device || null,
            deviceName: deviceName || device || null,
            ts: new Date().toISOString(),
            baseSha256: baseSha256 || null,
            hubSha256: original?.sha256 ?? null,
            deviceMtime: mtime ?? null,
            mode,
        };

        if (mode === 'rename') {
            const targetKey = normalizeObjectKey(key);
            if (!targetKey || targetKey === originalKey) throw typed('rename mode needs a distinct conflict-copy key', 'INVALID_KEY', 400);
            const written = await ws.writeBackendObject('file', backend, targetKey, source, {
                ifNoneMatch: '*', sha256: sha256 || undefined, mtime: mtime ?? undefined, origin: device || undefined, mimeType,
            });
            if (!written?.ok) return written;
            if (written.docId == null) throw typed('Conflict copy landed but its document is not indexed yet', 'DOCUMENT_PENDING', 503);
            await this.#mark(written.docId, { ...marker, conflictKey: targetKey }, original?.docId ?? null);
            const result = { mode, docId: written.docId, key: targetKey, conflictOf: originalKey, sha256: written.sha256, hubDocId: original?.docId ?? null, hubSha256: marker.hubSha256, seq: written.seq };
            ws.emit('sync.conflict.created', { workspaceId: ws.id, ...result, device: marker.device });
            return result;
        }

        const blob = await ws.persistBlob(source);
        if (sha256 && blob.checksum && String(sha256).toLowerCase() !== String(blob.checksum).toLowerCase()) {
            // The bytes are in the managed store now but unreferenced; the
            // caller sent something other than what it announced.
            throw typed(`Uploaded bytes hash to ${blob.checksum}, not ${sha256}`, 'CHECKSUM_MISMATCH', 422);
        }
        const checksum = `sha256/${blob.checksum}`;
        const db = this.#getDb();
        const existing = await db.getByChecksumString(checksum).catch(() => null);
        if (existing?.id && existing.metadata?.sync?.conflictOf === originalKey && !existing.metadata?.sync?.resolved) {
            // Retried upload of the same version — one inbox entry.
            return { mode, docId: existing.id, key: originalKey, conflictOf: originalKey, sha256: blob.checksum, hubDocId: original?.docId ?? null, hubSha256: marker.hubSha256, duplicate: true };
        }

        const metadata = {
            ...(existing?.metadata || {}),
            ...(blob.metadata || {}),
            size: blob.size,
            contentType: mimeType || blob.mimeType || existing?.metadata?.contentType || 'application/octet-stream',
            originalName: path.basename(originalKey),
            sync: marker,
        };
        const record = {
            ...(existing?.id ? { id: existing.id } : {}),
            schema: FILE_SCHEMA,
            checksumArray: [checksum],
            data: {},
            locations: Array.from(new Map([...(existing?.locations || []), { url: blob.url }].map((l) => [l.url, l])).values()),
            metadata,
            orphanedAt: null,
        };
        const docId = await ws.put(record, { context: null, features: [SYNC_CONFLICT_TAG] });
        if (original?.docId != null && original.docId !== docId) {
            await ws.assertRelation(docId, CONFLICT_PREDICATE, original.docId).catch((error) =>
                this.#logger.warn({ workspaceId: ws.id, docId, error: error.message }, 'Conflict relation not asserted'));
        }
        const result = { mode, docId, key: originalKey, conflictOf: originalKey, sha256: blob.checksum, url: blob.url, hubDocId: original?.docId ?? null, hubSha256: marker.hubSha256 };
        ws.emit('sync.conflict.created', { workspaceId: ws.id, ...result, device: marker.device });
        return result;
    }

    /** Every unresolved conflict, with what currently sits at its key. */
    async list() {
        const db = this.#getDb();
        const docs = await db.list({ features: { allOf: [SYNC_CONFLICT_TAG] } }).catch(() => []);
        const out = [];
        for (const doc of Array.isArray(docs) ? docs : []) {
            const sync = doc?.metadata?.sync || {};
            if (!sync.conflictOf || sync.resolved) continue;
            const backend = sync.backend || 'workspace:home';
            const hub = await this.#workspace.statBackendObject('file', backend, sync.conflictOf).catch(() => null);
            out.push({
                docId: doc.id,
                key: sync.conflictOf,
                backend,
                mode: sync.mode || 'inbox',
                conflictKey: sync.conflictKey || null,
                device: sync.device || null,
                deviceName: sync.deviceName || sync.device || null,
                ts: sync.ts || doc.createdAt || null,
                incoming: { sha256: sha256Of(doc), size: doc.metadata?.size ?? null, mtime: sync.deviceMtime ?? null },
                base: { sha256: sync.baseSha256 || null },
                hub: hub ? { sha256: hub.sha256, size: hub.size, mtime: hub.mtime, docId: hub.docId } : null,
                hubAtCreation: { sha256: sync.hubSha256 || null },
                resolvable: sync.mode !== 'rename',
            });
        }
        out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
        return out;
    }

    /**
     * Resolve one conflict:
     *   keep:'hub'      — discard the incoming version (bytes + document)
     *   keep:'incoming' — the incoming bytes replace the hub's at the key; the
     *                     displaced hub document is orphaned and its curation
     *                     (placements, tags, relations) moves to the survivor
     *   keep:'both'     — the incoming bytes land under a conflict-copy name
     *                     with a COPY of the original's curation
     */
    async resolve(docId, { keep } = {}) {
        if (!['hub', 'incoming', 'both'].includes(keep)) throw typed(`keep must be hub | incoming | both`, 'INVALID_RESOLUTION', 400);
        const ws = this.#workspace;
        const db = this.#getDb();
        const inbox = await db.getDocument(Number(docId)).catch(() => null);
        if (!inbox?.id) throw typed(`Conflict document ${docId} not found`, 'NOT_FOUND', 404);
        const sync = inbox.metadata?.sync;
        if (!sync?.conflictOf || sync.resolved) throw typed(`Document ${docId} is not an open conflict`, 'NOT_A_CONFLICT', 409);
        if (sync.mode === 'rename') throw typed('A rename-mode conflict is already on disk; delete or keep the copy instead', 'NOT_RESOLVABLE', 409);

        const backend = sync.backend || 'workspace:home';
        const key = sync.conflictOf;
        const hub = await ws.statBackendObject('file', backend, key).catch(() => null);
        const hubDocId = hub?.docId ?? null;
        const resolvedAt = new Date().toISOString();
        const base = { docId: inbox.id, key, backend, keep, hubDocId };

        if (keep === 'hub') {
            if (hubDocId != null) await ws.retractRelation(inbox.id, CONFLICT_PREDICATE, hubDocId).catch(() => {});
            await ws.destroyDocument(inbox);
            const result = { ...base, survivorDocId: hubDocId, resolvedAt };
            ws.emit('sync.conflict.resolved', { workspaceId: ws.id, ...result });
            return result;
        }

        const from = this.#managedLocation(inbox);
        if (!from) throw typed('The incoming bytes are no longer in the managed store', 'BYTES_MISSING', 409);

        if (keep === 'incoming') {
            const moved = await ws.transferDocumentBytes(inbox, { to: backend, mode: 'move', key, onConflict: 'overwrite', from });
            // The overwrite displaced the hub document (orphaned) and the
            // object:move carried `previous`, so placements already migrated;
            // tags and relations are explicit.
            if (hubDocId != null && hubDocId !== inbox.id) await this.#copyCuration(hubDocId, inbox.id, { placements: false });
            await this.#close(inbox, hubDocId, { resolved: keep, resolvedAt, resultKey: key });
            const result = { ...base, survivorDocId: inbox.id, resultKey: key, resolvedAt, transfer: moved?.state || 'complete' };
            ws.emit('sync.conflict.resolved', { workspaceId: ws.id, ...result });
            return result;
        }

        // keep === 'both'
        const copyKey = await this.#freeConflictKey(backend, key, sync.deviceName || sync.device, sync.ts);
        const moved = await ws.transferDocumentBytes(inbox, { to: backend, mode: 'move', key: copyKey, onConflict: 'rename', from });
        const landedKey = parseLocationUrl(moved?.to?.url || '')?.key || copyKey;
        if (hubDocId != null && hubDocId !== inbox.id) await this.#copyCuration(hubDocId, inbox.id, { placements: true });
        await this.#close(inbox, null, { resolved: keep, resolvedAt, resultKey: landedKey, conflictKey: landedKey });
        const result = { ...base, survivorDocId: inbox.id, resultKey: landedKey, resolvedAt, transfer: moved?.state || 'complete' };
        ws.emit('sync.conflict.resolved', { workspaceId: ws.id, ...result });
        return result;
    }

    // ── internals ────────────────────────────────────────────────────────────

    async #mark(docId, marker, hubDocId) {
        const ws = this.#workspace;
        await ws.put({ id: docId, metadata: { sync: marker } }, { context: null, features: [SYNC_CONFLICT_TAG] });
        if (hubDocId != null && hubDocId !== docId) {
            await ws.assertRelation(docId, CONFLICT_PREDICATE, hubDocId).catch((error) =>
                this.#logger.warn({ workspaceId: ws.id, docId, error: error.message }, 'Conflict relation not asserted'));
        }
    }

    #managedLocation(doc) {
        for (const loc of doc?.locations || []) {
            const p = parseLocationUrl(loc?.url);
            if (p?.scheme === 'stored' && p.backend === DATA_BACKEND) return { backend: DATA_BACKEND, key: p.key };
        }
        return null;
    }

    async #freeConflictKey(backend, key, deviceName, ts) {
        const wanted = conflictKey(key, deviceName, ts ? new Date(ts) : new Date());
        const taken = await this.#workspace.statBackendObject('file', backend, wanted).catch(() => null);
        if (!taken) return wanted;
        const dot = wanted.lastIndexOf('.');
        const slash = wanted.lastIndexOf('/');
        const hasExt = dot > slash + 1;
        for (let n = 2; n < 1000; n += 1) {
            const candidate = hasExt ? `${wanted.slice(0, dot)} ${n}${wanted.slice(dot)}` : `${wanted} ${n}`;
            if (!(await this.#workspace.statBackendObject('file', backend, candidate).catch(() => null))) return candidate;
        }
        throw typed('No free conflict-copy name', 'NO_FREE_KEY', 409);
    }

    // Tags, asserted relations and (optionally) placements from `fromId` onto
    // `toId`. Placements are copied only when the transfer did not already
    // migrate them (the overwrite path carries `previous`, the rename path does not).
    async #copyCuration(fromId, toId, { placements }) {
        const ws = this.#workspace;
        const db = this.#getDb();
        if (placements && typeof db.migrateDocumentMemberships === 'function') {
            await db.migrateDocumentMemberships(fromId, toId, { excludeTrees: [BACKENDS_TREE_NAME] }).catch((error) =>
                this.#logger.warn({ workspaceId: ws.id, fromId, toId, error: error.message }, 'Placement copy failed'));
        }
        const tags = typeof db.getBitmapsForDocument === 'function'
            ? await db.getBitmapsForDocument(fromId, 'tag/').catch(() => [])
            : [];
        if (tags.length) await ws.link(toId, { context: null, features: tags }).catch((error) =>
            this.#logger.warn({ workspaceId: ws.id, fromId, toId, error: error.message }, 'Tag copy failed'));

        let relations = null;
        try { relations = ws.listDocumentRelations(fromId); } catch { relations = null; }
        for (const edge of relations?.outgoing || []) {
            if (edge.meta?.src && edge.meta.src !== 'doc') continue;
            if (edge.to === toId || edge.to === fromId) continue;
            await ws.assertRelation(toId, edge.p, edge.to).catch(() => {});
        }
        for (const edge of relations?.incoming || []) {
            if (edge.meta?.src && edge.meta.src !== 'doc') continue;
            if (edge.from === toId || edge.from === fromId) continue;
            await ws.assertRelation(edge.from, edge.p, toId).catch(() => {});
        }
    }

    // Untag, record the outcome, drop the inbox → hub edge when the hub side
    // is gone (keep it for `both`: the copy IS derived from the original).
    async #close(inbox, retractFrom, outcome) {
        const ws = this.#workspace;
        if (retractFrom != null) await ws.retractRelation(inbox.id, CONFLICT_PREDICATE, retractFrom).catch(() => {});
        await ws.unlink(inbox.id, { context: null, features: [SYNC_CONFLICT_TAG] }).catch(() => {});
        await ws.put({ id: inbox.id, metadata: { sync: { ...(inbox.metadata?.sync || {}), ...outcome } } }, { context: null }).catch((error) =>
            this.#logger.warn({ workspaceId: ws.id, docId: inbox.id, error: error.message }, 'Conflict outcome not recorded'));
    }
}

export default SyncConflicts;
