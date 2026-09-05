'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';
import { parseByteRange } from '../../lib/http-range.js';

/**
 * Keyed objects on a path-addressed storage backend — the hub side of a
 * device mirror (canvas-fuse --mirror, canvas-edge), documented in
 * docs/sync-protocol.md. Mounted under /workspaces/:id/backends next to the
 * unified backend routes:
 *
 *   GET    /:driver/:address/objects?prefix&cursor&limit   listing (key, sha256, size, mtime)
 *   GET    /:driver/:address/changes?since&limit           change feed; 410 when the cursor was trimmed
 *   HEAD   /:driver/:address/objects/*                     ETag / X-Canvas-* headers
 *   GET    /:driver/:address/objects/*                     bytes (Range, If-None-Match)
 *   PUT    /:driver/:address/objects/*                     write (If-Match / If-None-Match:* / X-Canvas-Sha256 …)
 *   DELETE /:driver/:address/objects/*                     delete (If-Match)
 *   POST   /:driver/:address/objects/rename                { from, to, ifMatch }
 *
 * Every mutation goes through the same succession path a local edit takes,
 * so the document behind an edited file keeps its placements, and lands in
 * the change log with the caller's `X-Canvas-Origin` — the mirror's own
 * device id — so it can tell its echoes from other writers' changes.
 */

// 20 GiB, streamed to disk — never buffered (matches blobs.js).
const OBJECT_BODY_LIMIT = 21474836480;

const REASON_STATUS = {
    'precondition-failed': [412, 'PRECONDITION_FAILED'],
    'checksum-mismatch': [422, 'CHECKSUM_MISMATCH'],
    'invalid-key': [400, 'INVALID_KEY'],
    'same-key': [400, 'INVALID_KEY'],
    'not-found': [404, 'NOT_FOUND'],
    'target-exists': [409, 'TARGET_EXISTS'],
    'unknown-backend': [404, 'BACKEND_NOT_FOUND'],
    'unsupported-backend': [400, 'UNSUPPORTED_BACKEND'],
    'read-only-target': [403, 'BACKEND_READ_ONLY'],
    'read-only-backend': [403, 'BACKEND_READ_ONLY'],
    'target-offline': [503, 'BACKEND_OFFLINE'],
    'source-offline': [503, 'BACKEND_OFFLINE'],
    'source-not-removable': [403, 'BACKEND_READ_ONLY'],
};

const arg = (v) => decodeURIComponent(String(v || ''));
// 'fs' is a UX alias for the local-folder driver; canonical name is 'file'.
const drv = (v) => { const d = arg(v); return d === 'fs' ? 'file' : d; };
const keyOf = (request) => String(request.params['*'] ?? '');

const parseMtime = (value) => {
    if (value == null || value === '') return null;
    const s = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
    const ms = Date.parse(s);
    return Number.isFinite(ms) ? ms : null;
};

const clampLimit = (value, fallback = 1000, max = 5000) => {
    const n = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(n, max);
};

const shortString = (value, max = 256) => {
    if (value == null) return undefined;
    const s = String(value).trim();
    return s ? s.slice(0, max) : undefined;
};

function send(reply, response, code = null) {
    if (code) response.code = code;
    // A byte route may already have typed the reply after the object; the
    // envelope is JSON regardless.
    reply.type('application/json');
    return reply.code(response.statusCode).send(response.getResponse());
}

// Typed failures from the stored layer ({ ok:false, reason }) → HTTP.
function sendFailure(reply, result) {
    const [statusCode, code] = REASON_STATUS[result?.reason] || [500, 'OBJECT_OPERATION_FAILED'];
    const payload = {};
    if (result?.current !== undefined) payload.current = result.current;
    if (result?.expected !== undefined) payload.expected = result.expected;
    if (result?.actual !== undefined) payload.actual = result.actual;
    if (result?.key !== undefined) payload.key = result.key;
    if (result?.detail !== undefined) payload.detail = result.detail;
    const message = result?.reason ? `Object operation failed: ${result.reason}` : 'Object operation failed';
    return send(reply, new ResponseObject().error(message, Object.keys(payload).length ? payload : null, statusCode), code);
}

// Thrown errors: the stored index attaches { code, statusCode } to the ones
// it means (unknown backend, internal/excluded key, read-only, …).
function sendError(request, reply, error) {
    const statusCode = Number(error?.statusCode) || 500;
    if (statusCode >= 500) request.log.error(error);
    return send(reply, new ResponseObject().error(error?.message || 'Internal error', null, statusCode), error?.code || undefined);
}

async function readRoutes(fastify) {
    // Listing — key order, paged by cursor.
    fastify.get('/:driver/:address/objects', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const page = await request.workspace.listBackendObjects(drv(request.params.driver), arg(request.params.address), {
                prefix: shortString(request.query?.prefix, 4096) || '',
                after: shortString(request.query?.cursor, 4096) || null,
                limit: clampLimit(request.query?.limit),
            });
            return send(reply, new ResponseObject().found(page, 'OK', 200, page.objects.length));
        } catch (error) { return sendError(request, reply, error); }
    });

    // Change feed.
    fastify.get('/:driver/:address/changes', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const since = Math.max(0, Number.parseInt(String(request.query?.since ?? '0'), 10) || 0);
            const page = await request.workspace.backendChanges(drv(request.params.driver), arg(request.params.address), {
                since,
                limit: clampLimit(request.query?.limit),
            });
            if (page.cursorTooOld) {
                // The reader missed trimmed entries — it must rebuild from the listing.
                return send(reply, new ResponseObject().error(
                    'Cursor is older than the retained change log; rebuild from the listing',
                    { since, head: page.head, oldest: page.oldest },
                    410,
                ), 'CURSOR_TOO_OLD');
            }
            return send(reply, new ResponseObject().found(page, 'OK', 200, page.changes.length));
        } catch (error) { return sendError(request, reply, error); }
    });

    const describe = (reply, stat) => {
        reply.header('ETag', `"${stat.sha256}"`);
        reply.header('X-Canvas-Sha256', stat.sha256 || '');
        reply.header('X-Canvas-Size', String(stat.size ?? ''));
        reply.header('X-Canvas-Mtime', stat.mtime != null ? String(stat.mtime) : '');
        if (stat.mtime != null) reply.header('Last-Modified', new Date(stat.mtime).toUTCString());
        if (stat.docId != null) reply.header('X-Canvas-Doc-Id', String(stat.docId));
        reply.header('Accept-Ranges', 'bytes');
        reply.header('Cache-Control', 'private, no-cache');
        reply.type(stat.mimeType || 'application/octet-stream');
    };

    const notModified = (request, stat) => {
        const inm = request.headers['if-none-match'];
        if (!inm || !stat.sha256) return false;
        return String(inm).split(',').map((t) => t.trim().replace(/^W\//, '').replace(/^"|"$/g, '').toLowerCase())
            .some((t) => t === '*' || t === stat.sha256.toLowerCase());
    };

    // Explicit HEAD (registered before GET so fastify does not synthesize one
    // that would run the streaming handler).
    fastify.head('/:driver/:address/objects/*', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const stat = await request.workspace.statBackendObject(drv(request.params.driver), arg(request.params.address), keyOf(request));
            if (!stat) return send(reply, new ResponseObject().notFound('Object not found'), 'NOT_FOUND');
            describe(reply, stat);
            if (notModified(request, stat)) return reply.code(304).send();
            reply.header('Content-Length', String(stat.size ?? 0));
            return reply.code(200).send();
        } catch (error) { return sendError(request, reply, error); }
    });

    fastify.get('/:driver/:address/objects/*', {
        onRequest: [fastify.authenticate, requireWorkspaceRead()],
    }, async (request, reply) => {
        try {
            const driver = drv(request.params.driver);
            const address = arg(request.params.address);
            const key = keyOf(request);
            const stat = await request.workspace.statBackendObject(driver, address, key);
            if (!stat) return send(reply, new ResponseObject().notFound('Object not found'), 'NOT_FOUND');
            describe(reply, stat);
            if (notModified(request, stat)) return reply.code(304).send();

            const range = parseByteRange(request.headers.range, stat.size);
            if (range === 'unsatisfiable') {
                reply.header('Content-Range', `bytes */${stat.size}`);
                return send(reply, new ResponseObject().error('Requested range not satisfiable', null, 416), 'RANGE_NOT_SATISFIABLE');
            }
            const { data, ranged } = await request.workspace.resolveBackendObject(driver, address, key, { stream: true, range: range || undefined });
            if (!data) return send(reply, new ResponseObject().notFound('Object bytes are not reachable'), 'NOT_FOUND');
            if (range && ranged) {
                reply.header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
                reply.header('Content-Length', String(range.end - range.start + 1));
                return reply.code(206).send(data);
            }
            reply.header('Content-Length', String(stat.size ?? 0));
            return reply.code(200).send(data);
        } catch (error) { return sendError(request, reply, error); }
    });

    fastify.delete('/:driver/:address/objects/*', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const result = await request.workspace.removeBackendObject(drv(request.params.driver), arg(request.params.address), keyOf(request), {
                ifMatch: shortString(request.headers['if-match']),
                origin: shortString(request.headers['x-canvas-origin'], 128),
            });
            if (!result?.ok) return sendFailure(reply, result);
            return send(reply, new ResponseObject().deleted({ key: result.key, sha256: result.sha256, seq: result.seq, docId: result.docId ?? null }, 'Object deleted'));
        } catch (error) { return sendError(request, reply, error); }
    });

    // Rename within the backend: same bytes, same document, new key.
    fastify.post('/:driver/:address/objects/rename', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
        schema: {
            body: {
                type: 'object',
                required: ['from', 'to'],
                properties: {
                    from: { type: 'string', minLength: 1 },
                    to: { type: 'string', minLength: 1 },
                    ifMatch: { type: 'string' },
                    origin: { type: 'string', maxLength: 128 },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const { from, to, ifMatch, origin } = request.body;
            const result = await request.workspace.renameBackendObject(drv(request.params.driver), arg(request.params.address), from, to, {
                ifMatch: shortString(ifMatch),
                origin: shortString(origin, 128) ?? shortString(request.headers['x-canvas-origin'], 128),
            });
            if (!result?.ok) return sendFailure(reply, result);
            return send(reply, new ResponseObject().updated({
                from: result.from, to: result.to, sha256: result.sha256, seq: result.seq, docId: result.docId ?? null, state: result.state,
            }, 'Object renamed'));
        } catch (error) { return sendError(request, reply, error); }
    });
}

async function byteRoutes(fastify) {
    // Whatever the client labels the bytes (image/jpeg, text/plain, json…),
    // hand the RAW stream to the handler: nothing here is a request document.
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser('*', { bodyLimit: OBJECT_BODY_LIMIT }, (_req, payload, done) => done(null, payload));

    fastify.put('/:driver/:address/objects/*', {
        onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    }, async (request, reply) => {
        try {
            const driver = drv(request.params.driver);
            const address = arg(request.params.address);
            const key = keyOf(request);
            const headers = request.headers;

            // Conflict inbox (the device's version of a key the hub changed
            // meanwhile) lands as a document in the managed store, never on
            // the key itself — wired by the sync conflicts service.
            if (headers['x-canvas-conflict-of']) {
                if (typeof request.workspace.createSyncConflict !== 'function') {
                    return send(reply, new ResponseObject().error('Conflict inbox is not available on this server', null, 501), 'NOT_IMPLEMENTED');
                }
                const conflict = await request.workspace.createSyncConflict({
                    backend: address,
                    key,
                    conflictOf: shortString(headers['x-canvas-conflict-of'], 4096),
                    mode: String(headers['x-canvas-conflict-mode'] || 'inbox').toLowerCase() === 'rename' ? 'rename' : 'inbox',
                    source: request.body,
                    sha256: shortString(headers['x-canvas-sha256'] || request.query?.sha256, 64),
                    baseSha256: shortString(headers['x-canvas-base-sha256'], 64),
                    device: shortString(headers['x-canvas-origin'], 128),
                    deviceName: shortString(headers['x-canvas-device-name'], 128),
                    mtime: parseMtime(headers['x-canvas-mtime']),
                    mimeType: headers['content-type'] && headers['content-type'] !== 'application/octet-stream' ? shortString(headers['content-type'], 128) : undefined,
                });
                if (conflict && conflict.ok === false) return sendFailure(reply, conflict);
                return send(reply, new ResponseObject().created(conflict, 'Conflict recorded'));
            }

            const contentType = shortString(headers['content-type'], 128);
            const options = {
                ifMatch: shortString(headers['if-match']),
                ifNoneMatch: shortString(headers['if-none-match']),
                sha256: shortString(headers['x-canvas-sha256'], 64)?.toLowerCase(),
                mtime: parseMtime(headers['x-canvas-mtime']),
                origin: shortString(headers['x-canvas-origin'], 128),
                mimeType: contentType && contentType !== 'application/octet-stream' && !contentType.startsWith('*') ? contentType.split(';')[0].trim() : undefined,
            };

            // Reference form: the bytes are already in the workspace's managed
            // store (resumable upload dedupe) — place them without re-sending.
            let source = request.body;
            const ref = shortString(request.query?.sha256, 64)?.toLowerCase();
            if (ref) {
                if (!/^[0-9a-f]{64}$/.test(ref)) return send(reply, new ResponseObject().badRequest('sha256 must be 64 hex characters'), 'INVALID_SHA256');
                const blob = await request.workspace.statBlobByChecksum(ref);
                if (!blob?.url) return send(reply, new ResponseObject().notFound('No blob with that sha256 in the managed store'), 'BLOB_NOT_FOUND');
                const resolved = await request.workspace.resolveStoredUrl(blob.url, { stream: true });
                if (!resolved?.data) return send(reply, new ResponseObject().notFound('Blob bytes are not reachable'), 'BLOB_NOT_FOUND');
                source = resolved.data;
                options.sha256 = ref;
                if (!options.mimeType && blob.mimeType) options.mimeType = blob.mimeType;
            }

            const result = await request.workspace.writeBackendObject(driver, address, key, source, options);
            if (!result?.ok) return sendFailure(reply, result);
            const payload = {
                key: result.key,
                sha256: result.sha256,
                size: result.size,
                mtime: result.mtime ?? null,
                seq: result.seq,
                docId: result.docId ?? null,
                previous: result.previous ? { sha256: result.previous.checksums?.sha256 ?? null } : null,
                unchanged: result.unchanged === true,
            };
            reply.header('ETag', `"${result.sha256}"`);
            const created = !result.unchanged && !result.previous;
            return send(reply, created
                ? new ResponseObject().created(payload, 'Object created')
                : new ResponseObject().updated(payload, result.unchanged ? 'Object unchanged' : 'Object replaced'));
        } catch (error) { return sendError(request, reply, error); }
    });
}

export default async function workspaceObjectRoutes(fastify) {
    fastify.register(readRoutes);
    fastify.register(byteRoutes);
}
