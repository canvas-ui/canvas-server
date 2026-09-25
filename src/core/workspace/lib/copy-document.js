import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const running = new Map();

/** Copy content, never source IDs, memberships, relationships or permissions. */
export async function copyDocumentContent(source, destination, documentId, spec) {
    const original = await source.get(documentId);
    if (!original) throw new Error('Source document not found');
    if (!/^data\/schema\/(file|note|tab|link|drawing|task|event|message)(\/|$)/.test(original.schema)) {
        throw new Error('This document schema is not supported for workspace copies');
    }
    const record = {
        schema: original.schema, schemaVersion: original.schemaVersion,
        data: structuredClone(original.data || {}), metadata: structuredClone(original.metadata || {}),
        comment: original.comment, timelines: structuredClone(original.timelines || []),
        features: (original.features || []).filter(feature => typeof feature === 'string' && feature.startsWith('tag/')),
        locations: [],
    };
    // Drawing identity belongs to the unchanged scene, not its PNG preview.
    if (original.schema === 'data/schema/drawing') record.checksumArray = [...(original.checksumArray || [])];
    // Legacy asserted features must not leak source device presence.
    delete record.metadata.features;
    // Embedded attachments are byte content, not document relationships.
    const copyBytes = async (url) => {
        const resolved = await source.resolveDocument(original, { stream: true, ...(url ? { url } : {}) });
        if (!resolved) throw new Error('Source file content is unavailable');
        try { return await destination.persistBlob(resolved.stream || resolved.buffer); }
        finally { resolved.stream?.destroy?.(); }
    };
    if (original.schema === 'data/schema/file' || original.locations?.length) {
        const blob = await copyBytes();
        if (!blob.checksum) throw new Error('Destination did not confirm the stored checksum');
        const sha256 = original.checksumArray?.find(value => value.startsWith('sha256/'));
        if (original.schema === 'data/schema/file' && sha256 && sha256 !== `sha256/${blob.checksum}`) throw new Error('Source bytes changed; refresh the source document and retry');
        record.locations = [{ url: blob.url }];
        if (original.schema === 'data/schema/file') record.checksumArray = [`sha256/${blob.checksum}`];
        record.metadata.size = blob.size;
        if (!record.metadata.filename) {
            const filename = original.locations?.map(location => location.url?.split('/').pop()).find(Boolean);
            if (filename) { try { record.metadata.filename = decodeURIComponent(filename); } catch { record.metadata.filename = filename; } }
        }
        if (original.locations?.some(location => location.url === record.data.url)) record.data.url = blob.url;
    }
    for (const attachment of record.data.attachments || []) {
        if (!attachment?.url || !/^(stored|file):\/\//.test(attachment.url)) continue;
        const blob = await copyBytes(attachment.url);
        attachment.url = blob.url;
        attachment.size = blob.size;
    }
    // No emitEvent override: destination ingestion and automation run normally.
    const id = await destination.put(record, spec);
    if (id == null || typeof id === 'object') throw new Error('Destination did not confirm document insertion');
    return { sourceId: documentId, destinationId: id };
}

/** Durable receipts make retries safe after a lost HTTP response. */
export async function copyDocumentOnce({ source, destination, documentId, spec, operationId, userId }) {
    const key = crypto.createHash('sha256').update(`${userId}:${operationId}`).digest('hex');
    const directory = path.join(destination.varPath, 'workspace-copies');
    const filename = path.join(directory, `${key}.json`);
    const fingerprint = JSON.stringify({ source: source.id, destination: destination.id, documentId, spec });
    const lockKey = `${destination.id}:${key}`;
    if (running.has(lockKey)) { await running.get(lockKey); return copyDocumentOnce({ source, destination, documentId, spec, operationId, userId }); }
    const work = (async () => {
        await fs.mkdir(directory, { recursive: true });
        let receipt;
        try { receipt = JSON.parse(await fs.readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (receipt) {
            if (receipt.fingerprint !== fingerprint) throw new Error('Copy request ID was already used for a different destination');
            return receipt.result;
        }
        const result = await copyDocumentContent(source, destination, documentId, spec);
        const temp = `${filename}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temp, JSON.stringify({ fingerprint, result }), { mode: 0o600 });
        await fs.rename(temp, filename);
        return result;
    })();
    running.set(lockKey, work);
    try { return await work; } finally { running.delete(lockKey); }
}
