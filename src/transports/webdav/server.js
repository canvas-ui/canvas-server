'use strict';

import { promises as fs, createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../../utils/log.js';

const logger = createLogger('webdav');

// ── MIME types ──────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain',
  '.md': 'text/markdown', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav',
};
const mime = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// ── XML / URL helpers ───────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const httpDate = (d) => new Date(d).toUTCString();
const isoDate = (d) => new Date(d).toISOString();
const encSegments = (p) => p.split('/').map(s => s ? encodeURIComponent(s) : '').join('/');
const etag = (s) => `"${s.ino}-${s.size}-${Math.floor(s.mtimeMs)}"`;

// ── In-memory lock store (Class 2 WebDAV) ───────────────────────────────────

const locks = new Map();
const cleanLocks = () => { const now = Date.now(); for (const [t, l] of locks) if (l.expires < now) locks.delete(t); };

// ── WebDAV Handler ──────────────────────────────────────────────────────────

export class WebDAVHandler {
  /** @param {(userId: string, workspace: string) => Promise<string|null>} resolvePath */
  constructor(resolvePath) {
    this._resolve = resolvePath;
  }

  /**
   * Main entry point — called from the Fastify route handler after auth.
   * @param {import('http').ServerResponse} res - raw Node.js response
   * @param {object} opts
   */
  async handle(res, { method, url, headers, body, userId, workspace }) {
    const homePath = await this._resolve(userId, workspace);
    if (!homePath) return send(res, 404, 'Workspace not found');

    const prefix = `/workspaces/${encodeURIComponent(workspace)}/dav`;
    const decoded = decodeURIComponent(url.split('?')[0]);
    const rel = decoded.startsWith(prefix) ? (decoded.slice(prefix.length) || '/') : '/';
    const abs = path.resolve(homePath, '.' + rel);

    // Path traversal guard
    const relative = path.relative(homePath, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return send(res, 403, 'Forbidden');

    res.setHeader('DAV', '1, 2');
    res.setHeader('MS-Author-Via', 'DAV');

    const ctx = { res, abs, rel, prefix, homePath, headers, body };

    try {
      switch (method) {
        case 'OPTIONS':   return this._options(ctx);
        case 'PROPFIND':  return await this._propfind(ctx);
        case 'PROPPATCH': return await this._proppatch(ctx);
        case 'GET':       return await this._get(ctx);
        case 'HEAD':      return await this._head(ctx);
        case 'PUT':       return await this._put(ctx);
        case 'DELETE':    return await this._delete(ctx);
        case 'MKCOL':     return await this._mkcol(ctx);
        case 'COPY':      return await this._copyMove(ctx, false);
        case 'MOVE':      return await this._copyMove(ctx, true);
        case 'LOCK':      return await this._lock(ctx);
        case 'UNLOCK':    return await this._unlock(ctx);
        default:          return send(res, 405, 'Method Not Allowed');
      }
    } catch (err) {
      logger.error({ err, method, path: rel }, 'WebDAV request failed');
      if (!res.headersSent) {
        const code = err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500;
        send(res, code);
      }
    }
  }

  // ── WebDAV method handlers ──────────────────────────────────────────────

  _options({ res }) {
    res.setHeader('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
    send(res, 200);
  }

  async _propfind({ res, abs, rel, prefix, headers }) {
    const depth = headers['depth'] ?? '1';

    let stat;
    try { stat = await fs.stat(abs); }
    catch { return send(res, 404, 'Not Found'); }

    const entries = [propEntry(stat, prefix, rel)];

    if (stat.isDirectory() && depth !== '0') {
      try {
        const children = await fs.readdir(abs, { withFileTypes: true });
        for (const child of children) {
          try {
            const childStat = await fs.stat(path.join(abs, child.name));
            entries.push(propEntry(childStat, prefix, path.posix.join(rel, child.name)));
          } catch { /* skip inaccessible */ }
        }
      } catch { /* can't list — return just the directory itself */ }
    }

    sendXml(res, 207, `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n${entries.join('\n')}\n</D:multistatus>`);
  }

  async _proppatch({ res, abs, rel, prefix }) {
    try { await fs.stat(abs); }
    catch { return send(res, 404, 'Not Found'); }

    // We don't persist custom properties — just ACK everything (same as rclone)
    sendXml(res, 207,
      `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n` +
      `  <D:response>\n    <D:href>${esc(encSegments(prefix + rel))}</D:href>\n` +
      `    <D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat>\n` +
      `  </D:response>\n</D:multistatus>`);
  }

  async _get({ res, abs }) {
    let stat;
    try { stat = await fs.stat(abs); }
    catch { return send(res, 404, 'Not Found'); }

    if (stat.isDirectory()) {
      const children = await fs.readdir(abs);
      const html = `<!DOCTYPE html><html><body><h1>Index</h1><ul>${children.map(c => `<li><a href="${esc(encodeURIComponent(c))}">${esc(c)}</a></li>`).join('')}</ul></body></html>`;
      return sendBody(res, 200, html, 'text/html; charset=utf-8');
    }

    res.writeHead(200, {
      'Content-Type': mime(abs),
      'Content-Length': stat.size,
      'ETag': etag(stat),
      'Last-Modified': httpDate(stat.mtime),
    });
    await pipeline(createReadStream(abs), res);
  }

  async _head({ res, abs }) {
    let stat;
    try { stat = await fs.stat(abs); }
    catch { return send(res, 404); }

    res.writeHead(200, {
      'Content-Type': stat.isDirectory() ? 'httpd/unix-directory' : mime(abs),
      'Content-Length': stat.isDirectory() ? 0 : stat.size,
      'ETag': etag(stat),
      'Last-Modified': httpDate(stat.mtime),
    });
    res.end();
  }

  async _put({ res, abs, body }) {
    let existed = true;
    try { await fs.stat(abs); } catch { existed = false; }

    await fs.mkdir(path.dirname(abs), { recursive: true });

    if (body && typeof body.pipe === 'function') {
      await pipeline(body, createWriteStream(abs));
    } else {
      await fs.writeFile(abs, body || '');
    }

    send(res, existed ? 204 : 201);
  }

  async _delete({ res, abs }) {
    try {
      const stat = await fs.stat(abs);
      await (stat.isDirectory() ? fs.rm(abs, { recursive: true }) : fs.unlink(abs));
      send(res, 204);
    } catch { send(res, 404, 'Not Found'); }
  }

  async _mkcol({ res, abs }) {
    try { await fs.stat(abs); return send(res, 405, 'Already exists'); }
    catch { /* good, doesn't exist */ }

    try { await fs.stat(path.dirname(abs)); }
    catch { return send(res, 409, 'Parent does not exist'); }

    await fs.mkdir(abs);
    send(res, 201);
  }

  async _copyMove({ res, abs, prefix, homePath, headers }, isMove) {
    const dest = headers['destination'];
    if (!dest) return send(res, 400, 'Destination header required');

    let destUrl;
    try { destUrl = new URL(dest, `http://${headers['host']}`); }
    catch { return send(res, 400, 'Invalid Destination'); }

    const destDecoded = decodeURIComponent(destUrl.pathname);
    const destRel = destDecoded.startsWith(prefix) ? (destDecoded.slice(prefix.length) || '/') : null;
    if (!destRel) return send(res, 502, 'Destination outside WebDAV scope');

    const destAbs = path.resolve(homePath, '.' + destRel);
    const destRelative = path.relative(homePath, destAbs);
    if (destRelative.startsWith('..') || path.isAbsolute(destRelative)) return send(res, 403, 'Forbidden');

    const overwrite = (headers['overwrite'] || 'T').toUpperCase() === 'T';
    let destExisted = true;
    try { await fs.stat(destAbs); } catch { destExisted = false; }

    if (destExisted && !overwrite) return send(res, 412, 'Destination exists and Overwrite is F');
    if (destExisted) await fs.rm(destAbs, { recursive: true });

    await fs.mkdir(path.dirname(destAbs), { recursive: true });

    if (isMove) {
      await fs.rename(abs, destAbs);
    } else {
      const stat = await fs.stat(abs);
      await (stat.isDirectory() ? fs.cp(abs, destAbs, { recursive: true }) : fs.copyFile(abs, destAbs));
    }

    send(res, destExisted ? 204 : 201);
  }

  async _lock({ res, abs, prefix, rel, headers, body }) {
    cleanLocks();

    // Lock refresh
    const ifHeader = headers['if'];
    if (ifHeader) {
      const match = ifHeader.match(/<([^>]+)>/);
      if (match && locks.has(match[1])) {
        const lock = locks.get(match[1]);
        lock.expires = Date.now() + parseTimeout(headers['timeout']);
        return sendXml(res, 200, lockXml(lock, prefix, rel), { 'Lock-Token': `<${lock.token}>` });
      }
    }

    // New lock
    const bodyStr = await readBody(body);
    const ownerMatch = bodyStr.match(/<(?:D:)?owner[^>]*>([\s\S]*?)<\/(?:D:)?owner>/i);
    const token = `urn:uuid:${crypto.randomUUID()}`;
    const lock = {
      token, path: rel,
      owner: ownerMatch ? ownerMatch[1].trim() : '',
      exclusive: !bodyStr.includes('<D:shared') && !bodyStr.includes('<shared'),
      depth: headers['depth'] || 'infinity',
      expires: Date.now() + parseTimeout(headers['timeout']),
    };
    locks.set(token, lock);

    // Create lock-null resource if it doesn't exist
    let created = false;
    try { await fs.stat(abs); }
    catch { await fs.mkdir(path.dirname(abs), { recursive: true }); await fs.writeFile(abs, ''); created = true; }

    sendXml(res, created ? 201 : 200, lockXml(lock, prefix, rel), { 'Lock-Token': `<${token}>` });
  }

  async _unlock({ res, headers }) {
    cleanLocks();
    const raw = headers['lock-token'];
    if (!raw) return send(res, 400, 'Lock-Token header required');

    const token = raw.replace(/^<|>$/g, '');
    if (!locks.delete(token)) return send(res, 409, 'Lock token not found');
    send(res, 204);
  }
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

function sendXml(res, code, xml, extraHeaders = {}) {
  const buf = Buffer.from(xml, 'utf-8');
  res.writeHead(code, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': buf.length, ...extraHeaders });
  res.end(buf);
}

// ── PROPFIND XML generation ─────────────────────────────────────────────────

function propEntry(stat, prefix, rel) {
  const isDir = stat.isDirectory();
  const href = esc(encSegments(prefix + rel) + (isDir && !rel.endsWith('/') ? '/' : ''));
  const name = esc(path.basename(rel) || '/');
  const props = [
    `<D:displayname>${name}</D:displayname>`,
    `<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>`,
    `<D:getlastmodified>${httpDate(stat.mtime)}</D:getlastmodified>`,
    `<D:creationdate>${isoDate(stat.birthtime)}</D:creationdate>`,
    `<D:getetag>${esc(etag(stat))}</D:getetag>`,
  ];
  if (!isDir) {
    props.push(`<D:getcontentlength>${stat.size}</D:getcontentlength>`);
    props.push(`<D:getcontenttype>${mime(rel)}</D:getcontenttype>`);
  }
  return `  <D:response>\n    <D:href>${href}</D:href>\n    <D:propstat>\n      <D:prop>\n        ${props.join('\n        ')}\n      </D:prop>\n      <D:status>HTTP/1.1 200 OK</D:status>\n    </D:propstat>\n  </D:response>`;
}

function lockXml(lock, prefix, rel) {
  const seconds = Math.max(0, Math.round((lock.expires - Date.now()) / 1000));
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:">\n  <D:lockdiscovery>\n    <D:activelock>\n` +
    `      <D:locktype><D:write/></D:locktype>\n` +
    `      <D:lockscope>${lock.exclusive ? '<D:exclusive/>' : '<D:shared/>'}</D:lockscope>\n` +
    `      <D:depth>${lock.depth}</D:depth>\n` +
    `      <D:owner>${lock.owner}</D:owner>\n` +
    `      <D:timeout>Second-${seconds}</D:timeout>\n` +
    `      <D:locktoken><D:href>${esc(lock.token)}</D:href></D:locktoken>\n` +
    `      <D:lockroot><D:href>${esc(encSegments(prefix + rel))}</D:href></D:lockroot>\n` +
    `    </D:activelock>\n  </D:lockdiscovery>\n</D:prop>`;
}

// ── Utilities ───────────────────────────────────────────────────────────────

function parseTimeout(header) {
  if (!header) return 3600_000;
  const m = header.match(/Second-(\d+)/);
  return m ? parseInt(m[1]) * 1000 : 3600_000;
}

async function readBody(body) {
  if (!body) return '';
  if (Buffer.isBuffer(body)) return body.toString('utf-8');
  if (typeof body === 'string') return body;
  if (typeof body.pipe === 'function') {
    const chunks = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
  }
  return '';
}

export default WebDAVHandler;
