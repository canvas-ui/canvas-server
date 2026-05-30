'use strict';

import { promises as fs, createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../../utils/log.js';
import TreeFS from './TreeFS.js';
import VirtualContextsFS from './VirtualContextsFS.js';

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
const encSeg = (s) => { try { return encodeURIComponent(s); } catch { return encodeURIComponent(s.replace(/[\uD800-\uDFFF]/g, '\uFFFD')); } };
const encSegments = (p) => p.split('/').map(s => s ? encSeg(s) : '').join('/');
const etag = (s) => `"${s.ino}-${s.size}-${Math.floor(s.mtimeMs)}"`;

// ── In-memory lock store (Class 2 WebDAV) ───────────────────────────────────

const locks = new Map();
const cleanLocks = () => { const now = Date.now(); for (const [t, l] of locks) if (l.expires < now) locks.delete(t); };
const XML_BODY_LIMIT = 1024 * 1024;

// ── Virtual root directories ────────────────────────────────────────────────

const ROOTS = [
  { name: 'Home', isDir: true, size: 0 },
  { name: 'Contexts', isDir: true, size: 0 },
  { name: 'Trees', isDir: true, size: 0 },
];

// ── WebDAV Handler ──────────────────────────────────────────────────────────

export class WebDAVHandler {
  constructor(resolvePath) {
    this._resolve = resolvePath;
  }

  async handle(res, { method, url, headers, body, userId, workspace: workspaceName }) {
    const resolved = await this._resolve(userId, workspaceName);
    if (!resolved) return send(res, 404, 'Workspace not found');

    const homePath = typeof resolved === 'string' ? resolved : resolved.homePath;
    const workspace = typeof resolved === 'string' ? null : (resolved.workspace || null);
    const contextManager = typeof resolved === 'string' ? null : (resolved.contextManager || null);

    const prefix = `/workspaces/${encodeURIComponent(workspaceName)}/dav`;
    const decoded = decodeURIComponent(url.split('?')[0]);
    const rel = decoded.startsWith(prefix) ? (decoded.slice(prefix.length) || '/') : '/';

    res.setHeader('DAV', '1, 2');
    res.setHeader('MS-Author-Via', 'DAV');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    try {
      // ── Route: DAV root → show 3 virtual directories ────────────────
      if (rel === '/') {
        return await this._handleRoot(res, { method, prefix, headers, body, workspace });
      }

      // ── Route: /Home/* → raw filesystem ─────────────────────────────
      if (rel === '/Home' || rel.startsWith('/Home/')) {
        const homeRel = rel === '/Home' ? '/' : rel.slice('/Home'.length);
        return await this._handleHome(res, { method, prefix: prefix + '/Home', rel: homeRel, homePath, headers, body, workspace });
      }

      // ── Route: /Contexts/* → per-context abstraction folders ────────
      if (rel === '/Contexts' || rel.startsWith('/Contexts/')) {
        if (!workspace?.isActive) return send(res, 503, 'Workspace not active');
        if (!contextManager) return send(res, 503, 'Context manager not available');
        const vRel = rel === '/Contexts' ? '/' : rel.slice('/Contexts'.length);
        const vfs = new VirtualContextsFS(workspace, userId, contextManager);
        return await this._handleVirtual(res, { method, prefix, rel, vRel, headers, body, vfs, treeType: 'contexts' });
      }

      // ── Route: /Trees/* → named tree views ───────────────────────────
      if (rel === '/Trees' || rel.startsWith('/Trees/')) {
        if (!workspace?.isActive) return send(res, 503, 'Workspace not active');
        const treesRel = rel === '/Trees' ? '/' : rel.slice('/Trees'.length);
        const parts = treesRel.split('/').filter(Boolean);

        if (parts.length === 0) {
          const trees = await workspace.listTrees();
          const vfs = {
            stat: async (vPath) => vPath === '/' ? { isDir: true, name: 'Trees', size: 0 } : null,
            readdir: async () => trees.map((tree) => ({ name: tree.name, isDir: true, size: 0 })),
            getContent: async () => null,
          };
          return await this._handleVirtual(res, { method, prefix, rel, vRel: '/', headers, body, vfs, treeType: 'trees' });
        }

        let tree = null;
        try {
          tree = workspace.getTree(parts[0]);
        } catch {
          return send(res, 404, 'Tree not found');
        }
        const treePath = '/' + parts.slice(1).join('/');
        const vfs = new TreeFS(workspace, tree);
        return await this._handleVirtual(res, {
          method,
          prefix,
          rel,
          vRel: parts.length > 1 ? treePath : '/',
          headers,
          body,
          vfs,
          treeType: tree.type,
        });
      }

      return send(res, 404, 'Not Found');
    } catch (err) {
      logger.error({ err, method, path: rel }, 'WebDAV request failed');
      if (!res.headersSent) {
        const code = err.statusCode || (err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500);
        send(res, code, code === 413 ? 'Payload Too Large' : undefined);
      }
    }
  }

  // ── DAV root (3 virtual directories) ──────────────────────────────────

  async _handleRoot(res, { method, prefix, headers, body }) {
    if (method === 'OPTIONS') return this._options({ res });
    if (method === 'GET') {
      const html = `<!DOCTYPE html><html><body><h1>WebDAV</h1><ul>${
        ROOTS.map(r => `<li><a href="${esc(encSeg(r.name))}/">${esc(r.name)}/</a></li>`).join('')
      }</ul></body></html>`;
      return sendBody(res, 200, html, 'text/html; charset=utf-8');
    }
    if (method !== 'PROPFIND') return send(res, 405, 'Method Not Allowed');

    await readBody(body, XML_BODY_LIMIT);
    const depth = headers['depth'] ?? '1';

    const entries = [virtualPropEntry({ isDir: true, name: '', size: 0 }, prefix, '/')];
    if (depth !== '0') {
      for (const root of ROOTS) {
        entries.push(virtualPropEntry(root, prefix, '/' + root.name));
      }
    }

    sendXml(res, 207, `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n${entries.join('\n')}\n</D:multistatus>`);
  }

  // ── /Home — raw filesystem methods ────────────────────────────────────

  async _handleHome(res, { method, prefix, rel, homePath, headers, body, workspace }) {
    const abs = path.resolve(homePath, '.' + rel);
    const relative = path.relative(homePath, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return send(res, 403, 'Forbidden');

    const ctx = { res, abs, rel, prefix, homePath, headers, body, workspace };

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
  }

  _options({ res }) {
    res.setHeader('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
    send(res, 200);
  }

  async _propfind({ res, abs, rel, prefix, headers, body }) {
    await readBody(body, XML_BODY_LIMIT);
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
      } catch { /* can't list */ }
    }

    sendXml(res, 207, `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n${entries.join('\n')}\n</D:multistatus>`);
  }

  async _proppatch({ res, abs, rel, prefix, body }) {
    await readBody(body, XML_BODY_LIMIT);
    try { await fs.stat(abs); }
    catch { return send(res, 404, 'Not Found'); }

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
    catch { /* good */ }

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

    const ifHeader = headers['if'];
    if (ifHeader) {
      const match = ifHeader.match(/<([^>]+)>/);
      if (match && locks.has(match[1])) {
        const lock = locks.get(match[1]);
        lock.expires = Date.now() + parseTimeout(headers['timeout']);
        return sendXml(res, 200, lockXml(lock, prefix, rel), { 'Lock-Token': `<${lock.token}>` });
      }
    }

    const bodyStr = await readBody(body, XML_BODY_LIMIT);
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

  // ── Virtual tree handlers ──────────────────────────────────────────────

  async _handleVirtual(res, { method, prefix, rel, vRel, workspace, headers, body, vfs: prebuiltVfs, treeType }) {
    const vfs = prebuiltVfs || new TreeFS(workspace, workspace.getDefaultContextTree());

    try {
      switch (method) {
        case 'OPTIONS':  return this._options({ res });
        case 'PROPFIND': return await this._vPropfind(res, { prefix, rel, vRel, headers, body, vfs, treeType });
        case 'PROPPATCH': return await this._vProppatch(res, { prefix, rel, vRel, headers, body, vfs });
        case 'GET':      return await this._vGet(res, { vRel, vfs, treeType });
        case 'HEAD':     return await this._vHead(res, { vRel, vfs });
        case 'PUT':      return await this._vPut(res, { vRel, body, vfs });
        case 'DELETE':   return await this._vDelete(res, { vRel, vfs });
        case 'MKCOL':    return await this._vMkcol(res, { vRel, vfs });
        case 'MOVE':     return await this._vMove(res, { vRel, vfs, prefix, headers });
        case 'LOCK':     return await this._vLock(res, { prefix, rel, headers, body });
        case 'UNLOCK':   return await this._unlock({ res, headers });
        default:         return send(res, 405, 'Method Not Allowed');
      }
    } catch (err) {
      logger.error({ err, method, path: vRel, treeType }, 'Virtual WebDAV request failed');
      if (!res.headersSent) {
        const code = err.statusCode || 500;
        send(res, code, err.message);
      }
    }
  }

  async _vPropfind(res, { prefix, rel, vRel, headers, body, vfs }) {
    await readBody(body, XML_BODY_LIMIT);
    const depth = headers['depth'] ?? '1';

    const info = await vfs.stat(vRel);
    if (!info) return send(res, 404, 'Not Found');

    const entries = [virtualPropEntry(info, prefix, rel)];

    if (info.isDir && depth !== '0') {
      const children = await vfs.readdir(vRel);
      if (children) {
        for (const child of children) {
          const childRel = rel.endsWith('/') ? rel + child.name : rel + '/' + child.name;
          entries.push(virtualPropEntry(child, prefix, childRel));
        }
      }
    }

    sendXml(res, 207, `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n${entries.join('\n')}\n</D:multistatus>`);
  }

  async _vGet(res, { vRel, vfs, treeType }) {
    const info = await vfs.stat(vRel);
    if (!info) return send(res, 404, 'Not Found');

    if (info.isDir) {
      const children = await vfs.readdir(vRel) || [];
      const label = { directory: 'Tree', contexts: 'Contexts', context: 'Tree', trees: 'Trees' }[treeType] || treeType;
      const html = `<!DOCTYPE html><html><body><h1>${esc(label)}: ${esc(vRel)}</h1><ul>${
        children.map(c => {
          const suffix = c.isDir ? '/' : '';
          return `<li><a href="${esc(encSeg(c.name))}${suffix}">${esc(c.name)}${suffix}</a></li>`;
        }).join('')
      }</ul></body></html>`;
      return sendBody(res, 200, html, 'text/html; charset=utf-8');
    }

    const content = await vfs.getContent(vRel);
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

  async _vHead(res, { vRel, vfs }) {
    const info = await vfs.stat(vRel);
    if (!info) return send(res, 404);

    res.writeHead(200, {
      'Content-Type': info.isDir ? 'httpd/unix-directory' : mime(vRel),
      'Content-Length': info.isDir ? 0 : (info.size || 0),
    });
    res.end();
  }

  async _vProppatch(res, { prefix, rel, vRel, body, vfs }) {
    await readBody(body, XML_BODY_LIMIT);
    const info = await vfs.stat(vRel);
    if (!info) return send(res, 404, 'Not Found');
    sendXml(res, 207,
      `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n` +
      `  <D:response>\n    <D:href>${esc(encSegments(prefix + rel))}</D:href>\n` +
      `    <D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat>\n` +
      `  </D:response>\n</D:multistatus>`);
  }

  async _vPut(res, { vRel, body, vfs }) {
    if (typeof vfs.put !== 'function') return send(res, 403, 'This virtual tree is read-only');
    const buf = await readBodyBuffer(body, 16 * 1024 * 1024);
    const result = await vfs.put(vRel, buf);
    send(res, result?.created === false ? 204 : 201);
  }

  async _vDelete(res, { vRel, vfs }) {
    if (typeof vfs.del !== 'function') return send(res, 403, 'This virtual tree is read-only');
    await vfs.del(vRel);
    send(res, 204);
  }

  async _vMkcol(res, { vRel, vfs }) {
    if (typeof vfs.mkcol !== 'function') return send(res, 403, 'This virtual tree is read-only');
    await vfs.mkcol(vRel);
    send(res, 201);
  }

  async _vMove(res, { vRel, vfs, prefix, headers }) {
    if (typeof vfs.put !== 'function' || typeof vfs.del !== 'function') return send(res, 403, 'This virtual tree is read-only');
    const dest = headers['destination'];
    if (!dest) return send(res, 400, 'Destination header required');
    let destUrl;
    try { destUrl = new URL(dest, `http://${headers['host']}`); }
    catch { return send(res, 400, 'Invalid Destination'); }
    const destDecoded = decodeURIComponent(destUrl.pathname);
    const destRel = destDecoded.startsWith(prefix) ? (destDecoded.slice(prefix.length) || '/') : null;
    if (!destRel) return send(res, 502, 'Destination outside scope');

    // Strip /Trees/<tree> or /Contexts prefix to get vfs-relative path
    const m = destRel.match(/^\/(Trees\/[^/]+|Contexts)(\/.*)?$/);
    if (!m) return send(res, 502, 'Destination not in same virtual tree');
    const destVRel = m[2] || '/';

    const content = await vfs.getContent(vRel);
    if (!content) return send(res, 404, 'Source not found');
    const buf = content.buffer || (content.stream ? await streamToBuffer(content.stream) : null);
    if (!buf) return send(res, 500);
    await vfs.put(destVRel, buf);
    await vfs.del(vRel);
    send(res, 201);
  }

  async _vLock(res, { prefix, rel, headers, body }) {
    cleanLocks();
    const bodyStr = await readBody(body, XML_BODY_LIMIT);
    const ownerMatch = bodyStr.match(/<(?:D:)?owner[^>]*>([\s\S]*?)<\/(?:D:)?owner>/i);
    const token = `urn:uuid:${crypto.randomUUID()}`;
    const lock = {
      token, path: rel,
      owner: ownerMatch ? ownerMatch[1].trim() : '',
      exclusive: true,
      depth: headers['depth'] || 'infinity',
      expires: Date.now() + parseTimeout(headers['timeout']),
    };
    locks.set(token, lock);
    sendXml(res, 200, lockXml(lock, prefix, rel), { 'Lock-Token': `<${token}>` });
  }
}

async function readBodyBuffer(body, maxBytes = Infinity) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) throw bodyTooLargeError();
    return body;
  }
  if (typeof body === 'string') return Buffer.from(body, 'utf-8');
  if (typeof body.pipe === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      total += chunk.length;
      if (total > maxBytes) { if (typeof body.destroy === 'function') body.destroy(); throw bodyTooLargeError(); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
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

function virtualPropEntry(entry, prefix, rel) {
  const isDir = entry.isDir;
  const href = esc(encSegments(prefix + rel) + (isDir && !rel.endsWith('/') ? '/' : ''));
  const name = esc(entry.name || path.basename(rel) || 'root');
  const now = new Date();
  const epoch = now.getTime();
  const props = [
    `<D:displayname>${name}</D:displayname>`,
    `<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>`,
    `<D:getlastmodified>${httpDate(now)}</D:getlastmodified>`,
    `<D:creationdate>${isoDate(now)}</D:creationdate>`,
    `<D:getetag>"v-${esc(name)}-${epoch}"</D:getetag>`,
  ];
  if (!isDir) {
    props.push(`<D:getcontentlength>${entry.size || 0}</D:getcontentlength>`);
    props.push(`<D:getcontenttype>${mime(rel)}</D:getcontenttype>`);
  }
  return `  <D:response>\n    <D:href>${href}</D:href>\n    <D:propstat>\n      <D:prop>\n        ${props.join('\n        ')}\n      </D:prop>\n      <D:status>HTTP/1.1 200 OK</D:status>\n    </D:propstat>\n  </D:response>`;
}

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

async function readBody(body, maxBytes = Infinity) {
  if (!body) return '';
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) throw bodyTooLargeError();
    return body.toString('utf-8');
  }
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > maxBytes) throw bodyTooLargeError();
    return body;
  }
  if (typeof body.pipe === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of body) {
      total += chunk.length;
      if (total > maxBytes) {
        if (typeof body.destroy === 'function') body.destroy();
        throw bodyTooLargeError();
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }
  return '';
}

function bodyTooLargeError() {
  const err = new Error('Payload Too Large');
  err.statusCode = 413;
  return err;
}

export default WebDAVHandler;
