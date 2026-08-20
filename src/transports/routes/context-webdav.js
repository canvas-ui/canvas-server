'use strict';

import path from 'path';
import VirtualNamedContextFS from '../webdav/VirtualNamedContextFS.js';
import { entryIdentity, isClientAbort, matchesEtag, parseRange, streamTo } from '../webdav/dav-http.js';
import ResponseObject from '../ResponseObject.js';
import { createLogger } from '../../utils/log.js';
import { throttleKey, isThrottled, recordFailure, clearFailures } from '../lib/basic-auth-throttle.js';

const logger = createLogger('context-webdav:routes');

const DAV_METHODS = ['GET', 'HEAD', 'PROPFIND'];
const XML_BODY_LIMIT = 1024 * 1024;

// ── XML / URL helpers ───────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const httpDate = (d) => new Date(d).toUTCString();
const isoDate = (d) => new Date(d).toISOString();
const encSegments = (p) => p.split('/').map(s => s ? encodeURIComponent(s) : '').join('/');

/**
 * Context WebDAV Routes — read-only DAV access to a named context's data.
 * Route: /contexts/:context/dav[/*]
 *
 * Shows folders per data abstraction (Notes, Tabs, Files, …) with documents inside.
 */
export default async function contextWebdavRoutes(fastify) {

    // ── Content-type parser (scoped to this plugin) ──────────────────────────

    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser('*', { bodyLimit: XML_BODY_LIMIT }, (_req, payload, done) => done(null, payload));

    // ── Auth preHandler ──────────────────────────────────────────────────────

    async function authenticate(request, reply) {
        const authHeader = request.headers.authorization;

        if (!authHeader) {
            reply.header('WWW-Authenticate', 'Basic realm="Canvas Context WebDAV"');
            return reply.code(401).send(new ResponseObject().unauthorized('Authentication required').getResponse());
        }

        let token = null;

        if (authHeader.startsWith('Bearer ')) {
            token = authHeader.substring(7);
        } else if (authHeader.startsWith('Basic ')) {
            try {
                const [username, password] = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8').split(':', 2);
                if (password?.startsWith('canvas-')) {
                    token = password;
                } else {
                    const tkey = throttleKey(request, username);
                    if (isThrottled(tkey)) {
                        return reply.code(429).send(new ResponseObject().tooManyRequests('Too many failed authentication attempts, try again later').getResponse());
                    }
                    const user = await fastify.users.getByEmail(username);
                    if (!user || !(await fastify.authService.verifyPassword(user.id, password))) {
                        recordFailure(tkey);
                        return reply.code(401).send(new ResponseObject().unauthorized('Invalid credentials').getResponse());
                    }
                    if (user.status && user.status !== 'active') {
                        recordFailure(tkey);
                        return reply.code(403).send(new ResponseObject().forbidden('User account is not active').getResponse());
                    }
                    clearFailures(tkey);
                    request.user = { id: user.id, name: user.name || user.email, email: user.email, userType: user.userType || 'user' };
                }
            } catch {
                return reply.code(401).send(new ResponseObject().unauthorized('Invalid credentials').getResponse());
            }
        } else {
            return reply.code(401).send(new ResponseObject().unauthorized('Unsupported auth scheme').getResponse());
        }

        if (token) {
            const result = await fastify.authService.verifyToken(token);
            if (!result?.valid) {
                return reply.code(401).send(new ResponseObject().unauthorized(result?.message || 'Invalid token').getResponse());
            }
            request.user = result.user;
        }

        if (!request.user) {
            return reply.code(401).send(new ResponseObject().unauthorized('Authentication failed').getResponse());
        }

        // Verify context access
        const contextId = request.params.context;
        try {
            const ctx = await fastify.contextManager.getContext(request.user.id, contextId);
            if (!ctx) {
                return reply.code(404).send(new ResponseObject().notFound('Context not found').getResponse());
            }
            request.contextInstance = ctx;
        } catch (err) {
            if (err.code === 'ACCESS_DENIED') {
                return reply.code(403).send(new ResponseObject().forbidden('Access denied').getResponse());
            }
            // WORKSPACE_NOT_READY (workspace starting) is retryable, not a 404.
            if (err.code === 'WORKSPACE_NOT_READY') {
                return reply.code(503).send(new ResponseObject().error(err.message, { retryable: true }, 503).getResponse());
            }
            return reply.code(404).send(new ResponseObject().notFound('Context not found').getResponse());
        }
    }

    // ── Route registration ──────────────────────────────────────────────────

    for (const url of ['/contexts/:context/dav', '/contexts/:context/dav/*']) {
        fastify.options(url, (request, reply) => {
            reply.header('DAV', '1');
            reply.header('Allow', 'OPTIONS, ' + DAV_METHODS.join(', '));
            reply.header('Access-Control-Allow-Origin', '*');
            reply.header('Access-Control-Allow-Methods', 'OPTIONS, ' + DAV_METHODS.join(', '));
            reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Depth');
            reply.header('Access-Control-Expose-Headers', 'DAV, Content-Type');
            reply.header('Access-Control-Max-Age', '86400');
            return reply.code(200).send();
        });

        fastify.route({
            method: DAV_METHODS,
            url,
            preHandler: authenticate,
            handler: async (request, reply) => {
                reply.hijack();
                await handleDav(reply.raw, {
                    method: request.method,
                    url: request.url,
                    headers: request.headers,
                    body: request.body,
                    context: request.contextInstance,
                    contextParam: request.params.context,
                });
            },
        });
    }

    logger.info('Context WebDAV routes registered at /contexts/:context/dav');
}

// ── DAV handler ─────────────────────────────────────────────────────────────

async function handleDav(res, { method, url, headers, body, context, contextParam }) {
    const prefix = `/contexts/${encodeURIComponent(contextParam)}/dav`;
    const decoded = decodeURIComponent(url.split('?')[0]);
    const rel = decoded.startsWith(prefix) ? (decoded.slice(prefix.length) || '/') : '/';

    res.setHeader('DAV', '1');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const vfs = new VirtualNamedContextFS(context);

    try {
        switch (method) {
            case 'OPTIONS':
                res.setHeader('Allow', 'OPTIONS, ' + DAV_METHODS.join(', '));
                return send(res, 200);
            case 'PROPFIND':
                return await propfind(res, vfs, prefix, rel, headers, body);
            case 'GET':
                return await get(res, vfs, rel, headers);
            case 'HEAD':
                return await head(res, vfs, rel);
            default:
                return send(res, 405, 'Method Not Allowed');
        }
    } catch (err) {
        if (isClientAbort(err)) return;
        logger.error({ err, method, path: rel }, 'Context WebDAV request failed');
        if (!res.headersSent) send(res, 500);
    }
}

// ── PROPFIND ────────────────────────────────────────────────────────────────

async function propfind(res, vfs, prefix, rel, headers, body) {
    await readBody(body, XML_BODY_LIMIT);
    const depth = headers['depth'] ?? '1';

    const info = await vfs.stat(rel);
    if (!info) return send(res, 404, 'Not Found');

    const entries = [propEntry(info, prefix, rel)];

    if (info.isDir && depth !== '0') {
        const children = await vfs.readdir(rel);
        if (children) {
            for (const child of children) {
                const childRel = rel.endsWith('/') ? rel + child.name : rel + '/' + child.name;
                entries.push(propEntry(child, prefix, childRel));
            }
        }
    }

    sendXml(res, 207, `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n${entries.join('\n')}\n</D:multistatus>`);
}

// ── GET ─────────────────────────────────────────────────────────────────────

async function get(res, vfs, rel, headers = {}) {
    const info = await vfs.stat(rel);
    if (!info) return send(res, 404, 'Not Found');

    if (info.isDir) {
        const children = await vfs.readdir(rel) || [];
        const html = `<!DOCTYPE html><html><body><h1>Context: ${esc(rel)}</h1><ul>${
            children.map(c => {
                const suffix = c.isDir ? '/' : '';
                return `<li><a href="${esc(encodeURIComponent(c.name))}${suffix}">${esc(c.name)}${suffix}</a></li>`;
            }).join('')
        }</ul></body></html>`;
        return sendBody(res, 200, html, 'text/html; charset=utf-8');
    }

    // The identity PROPFIND reported, on the body itself: a client validating
    // what it reads against what it was told has to get one answer, or it takes
    // the file for changed mid-read and abandons the transfer.
    const identity = entryIdentity(info);
    if (identity.ETag && matchesEtag(headers['if-none-match'], identity.ETag)) {
        res.writeHead(304, identity);
        return res.end();
    }

    // Seeking works here for the same reason it works on the workspace mount:
    // `stored` serves a byte window, and `ranged` says whether it really did.
    const wanted = parseRange(headers['range'], info.size);
    if (wanted?.unsatisfiable) {
        res.writeHead(416, { ...identity, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${info.size}` });
        return res.end();
    }

    // `doc` is what stat() already resolved — see TreeFS.getContent.
    const content = await vfs.getContent(rel, {
        ...(info.doc ? { doc: info.doc } : {}),
        ...(wanted ? { range: { start: wanted.start, end: wanted.end } } : {}),
    });
    if (!content) return send(res, 404, 'Not Found');

    if (content.stream) {
        const bodyHeaders = { ...identity, 'Content-Type': content.contentType, 'Accept-Ranges': 'bytes' };
        if (wanted && content.ranged) {
            res.writeHead(206, {
                ...bodyHeaders,
                'Content-Length': wanted.end - wanted.start + 1,
                'Content-Range': `bytes ${wanted.start}-${wanted.end}/${info.size}`,
            });
            return await streamTo(res, content.stream);
        }
        // Only when the size is actually known — `Content-Length: undefined`
        // is not a length, and the response has to fall back to chunked.
        if (Number.isFinite(content.size)) bodyHeaders['Content-Length'] = content.size;
        res.writeHead(200, bodyHeaders);
        await streamTo(res, content.stream);
    } else if (content.buffer) {
        res.writeHead(200, { ...identity, 'Content-Type': content.contentType, 'Content-Length': content.buffer.length });
        res.end(content.buffer);
    } else {
        send(res, 500);
    }
}

// ── HEAD ────────────────────────────────────────────────────────────────────

async function head(res, vfs, rel) {
    const info = await vfs.stat(rel);
    if (!info) return send(res, 404);

    const contentType = info.isDir ? 'httpd/unix-directory' : (info.contentType || 'application/octet-stream');
    res.writeHead(200, {
        ...entryIdentity(info),
        'Content-Type': contentType,
        'Content-Length': info.isDir ? 0 : (info.size || 0),
        ...(info.isDir ? {} : { 'Accept-Ranges': 'bytes' }),
    });
    res.end();
}

// ── Response helpers ────────────────────────────────────────────────────────

function send(res, code, text) {
    if (res.headersSent) return;
    res.writeHead(code, text ? { 'Content-Type': 'text/plain' } : undefined);
    res.end(text || '');
}

function sendBody(res, code, body, contentType) {
    const buf = Buffer.from(body, 'utf-8');
    res.writeHead(code, { 'Content-Type': contentType, 'Content-Length': buf.length });
    res.end(buf);
}

function sendXml(res, code, xml) {
    const buf = Buffer.from(xml, 'utf-8');
    res.writeHead(code, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': buf.length });
    res.end(buf);
}

// ── PROPFIND XML ────────────────────────────────────────────────────────────

/**
 * A file's identity has to be STABLE — the entry carries the document's own
 * mtime and ETag. A fresh stamp per PROPFIND tells the client the file changed
 * under it, which is how opening an image drew it once and then failed. A
 * collection has no body to drop and a stale listing is the worse failure, so
 * it keeps the volatile stamp and carries no ETag (RFC 4918 asks for one only
 * where there is an entity to compare).
 */
function propEntry(entry, prefix, rel) {
    const isDir = entry.isDir;
    const href = esc(encSegments(prefix + rel) + (isDir && !rel.endsWith('/') ? '/' : ''));
    const name = esc(entry.name || path.basename(rel) || 'root');
    const stamp = entry.mtime ? new Date(entry.mtime) : new Date();
    const contentType = entry.contentType || 'application/octet-stream';
    const props = [
        `<D:displayname>${name}</D:displayname>`,
        `<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>`,
        `<D:getlastmodified>${httpDate(stamp)}</D:getlastmodified>`,
        `<D:creationdate>${isoDate(stamp)}</D:creationdate>`,
    ];
    if (!isDir) {
        props.push(`<D:getetag>${esc(entry.etag || `"v-${name}-${entry.size || 0}"`)}</D:getetag>`);
        props.push(`<D:getcontentlength>${entry.size || 0}</D:getcontentlength>`);
        props.push(`<D:getcontenttype>${esc(contentType)}</D:getcontenttype>`);
    }
    return `  <D:response>\n    <D:href>${href}</D:href>\n    <D:propstat>\n      <D:prop>\n        ${props.join('\n        ')}\n      </D:prop>\n      <D:status>HTTP/1.1 200 OK</D:status>\n    </D:propstat>\n  </D:response>`;
}

// ── Utilities ───────────────────────────────────────────────────────────────

async function readBody(body, maxBytes = Infinity) {
    if (!body) return '';
    if (Buffer.isBuffer(body)) {
        if (body.length > maxBytes) throw Object.assign(new Error('Payload Too Large'), { statusCode: 413 });
        return body.toString('utf-8');
    }
    if (typeof body === 'string') {
        if (Buffer.byteLength(body) > maxBytes) throw Object.assign(new Error('Payload Too Large'), { statusCode: 413 });
        return body;
    }
    if (typeof body.pipe === 'function') {
        const chunks = [];
        let total = 0;
        for await (const chunk of body) {
            total += chunk.length;
            if (total > maxBytes) {
                if (typeof body.destroy === 'function') body.destroy();
                throw Object.assign(new Error('Payload Too Large'), { statusCode: 413 });
            }
            chunks.push(chunk);
        }
        return Buffer.concat(chunks).toString('utf-8');
    }
    return '';
}
