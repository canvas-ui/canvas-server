'use strict';

import path from 'path';
import { pipeline } from 'stream/promises';
import VirtualNamedContextFS from '../webdav/VirtualNamedContextFS.js';
import ResponseObject from '../ResponseObject.js';
import { createLogger } from '../../utils/log.js';

const logger = createLogger('context-webdav:routes');

const DAV_METHODS = ['GET', 'HEAD', 'PROPFIND'];
const XML_BODY_LIMIT = 1024 * 1024;

// ── XML / URL helpers ───────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const httpDate = (d) => new Date(d).toUTCString();
const isoDate = (d) => new Date(d).toISOString();
const encSegments = (p) => p.split('/').map(s => s ? encodeURIComponent(s) : '').join('/');

const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain',
    '.md': 'text/markdown', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip',
};
const mime = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

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
                    const user = await fastify.users.getByEmail(username);
                    if (!user || !(await fastify.authService.verifyPassword(user.id, password))) {
                        return reply.code(401).send(new ResponseObject().unauthorized('Invalid credentials').getResponse());
                    }
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
            if (err.message.includes('Access denied')) {
                return reply.code(403).send(new ResponseObject().forbidden('Access denied').getResponse());
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

    const vfs = new VirtualNamedContextFS(context);

    try {
        switch (method) {
            case 'OPTIONS':
                res.setHeader('Allow', 'OPTIONS, ' + DAV_METHODS.join(', '));
                return send(res, 200);
            case 'PROPFIND':
                return await propfind(res, vfs, prefix, rel, headers, body);
            case 'GET':
                return await get(res, vfs, rel);
            case 'HEAD':
                return await head(res, vfs, rel);
            default:
                return send(res, 405, 'Method Not Allowed');
        }
    } catch (err) {
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

async function get(res, vfs, rel) {
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

    const content = await vfs.getContent(rel);
    if (!content) return send(res, 404, 'Not Found');

    if (content.stream) {
        res.writeHead(200, { 'Content-Type': content.contentType, 'Content-Length': content.size });
        await pipeline(content.stream, res);
    } else if (content.buffer) {
        res.writeHead(200, { 'Content-Type': content.contentType, 'Content-Length': content.buffer.length });
        res.end(content.buffer);
    } else {
        send(res, 500);
    }
}

// ── HEAD ────────────────────────────────────────────────────────────────────

async function head(res, vfs, rel) {
    const info = await vfs.stat(rel);
    if (!info) return send(res, 404);

    res.writeHead(200, {
        'Content-Type': info.isDir ? 'httpd/unix-directory' : mime(rel),
        'Content-Length': info.isDir ? 0 : (info.size || 0),
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

function propEntry(entry, prefix, rel) {
    const isDir = entry.isDir;
    const href = esc(encSegments(prefix + rel) + (isDir && !rel.endsWith('/') ? '/' : ''));
    const name = esc(entry.name || path.basename(rel) || 'root');
    const now = new Date();
    const props = [
        `<D:displayname>${name}</D:displayname>`,
        `<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>`,
        `<D:getlastmodified>${httpDate(now)}</D:getlastmodified>`,
        `<D:creationdate>${isoDate(now)}</D:creationdate>`,
        `<D:getetag>"v-${esc(name)}"</D:getetag>`,
    ];
    if (!isDir) {
        props.push(`<D:getcontentlength>${entry.size || 0}</D:getcontentlength>`);
        props.push(`<D:getcontenttype>${mime(rel)}</D:getcontenttype>`);
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
