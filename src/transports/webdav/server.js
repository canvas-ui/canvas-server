'use strict';

import { promises as fs, createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../../utils/log.js';
import { internalPathMatcher } from '../../core/workspace/lib/internal-paths.js';
import TreeFS from './TreeFS.js';
import { entryIdentity, isClientAbort, matchesEtag, parseRange, streamTo } from './dav-http.js';
import { isClientDropping, norm } from './vfs-shared.js';
import VirtualContextsFS from './VirtualContextsFS.js';
import TrashFS from './TrashFS.js';

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
  '.eml': 'message/rfc822',
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
  // Physically a path in the default directory tree; presented here because a
  // workspace is the "drive" and drag-to-trash needs a visible target.
  { name: 'Trash', isDir: true, size: 0 },
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
        return await this._handleHome(res, {
          method,
          prefix: prefix + '/Home',
          mountPrefix: prefix,
          rel: homeRel,
          homePath,
          headers,
          body,
          workspace,
          resolveTarget: (destRel) => this._resolveVirtual(destRel, { workspace, userId, contextManager, homePath }),
        });
      }

      // ── Route: /Contexts, /Trees, /Trash → index-backed virtual trees ──
      const target = await this._resolveVirtual(rel, { workspace, userId, contextManager, homePath });
      if (target?.error) return send(res, target.error.code, target.error.message);
      if (target) {
        return await this._handleVirtual(res, {
          method, prefix, rel, headers, body,
          vfs: target.vfs,
          vRel: target.vRel,
          treeType: target.treeType,
          resolveTarget: (destRel) => this._resolveVirtual(destRel, { workspace, userId, contextManager, homePath }),
        });
      }

      return send(res, 404, 'Not Found');
    } catch (err) {
      if (isClientAbort(err)) return;
      logger.error({ err, method, path: rel }, 'WebDAV request failed');
      if (!res.headersSent) {
        const code = err.statusCode || (err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500);
        send(res, code, code === 413 ? 'Payload Too Large' : undefined);
      }
    }
  }

  /**
   * Map a DAV path onto the virtual filesystem that serves it. One resolver for
   * both the request path and a MOVE's Destination, so a move can cross roots
   * (Trees → Trash, tree → tree) without the two disagreeing about what a path
   * means. Returns null for paths that are not index-backed (/, /Home).
   */
  async _resolveVirtual(rel, { workspace, userId, contextManager, homePath }) {
    const inRoot = (name) => rel === `/${name}` || rel.startsWith(`/${name}/`);
    const relTo = (name) => (rel === `/${name}` ? '/' : rel.slice(name.length + 1));

    // Home is a real filesystem, not an index-backed tree. It resolves to a
    // path rather than a vfs, so a MOVE between the two can tell that this is
    // the one case where bytes genuinely have to move.
    if (inRoot('Home')) {
      if (!homePath) return { error: { code: 502, message: 'Home is not available' } };
      const vRel = relTo('Home');
      const abs = path.resolve(homePath, '.' + vRel);
      const relative = path.relative(homePath, abs);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return { error: { code: 403, message: 'Forbidden' } };
      return { kind: 'home', abs, vRel };
    }

    if (inRoot('Contexts')) {
      if (!workspace?.isActive) return { error: { code: 503, message: 'Workspace not active' } };
      if (!contextManager) return { error: { code: 503, message: 'Context manager not available' } };
      return {
        vfs: new VirtualContextsFS(workspace, userId, contextManager),
        vRel: relTo('Contexts'),
        treeType: 'contexts',
      };
    }

    if (inRoot('Trash')) {
      if (!workspace?.isActive) return { error: { code: 503, message: 'Workspace not active' } };
      return { vfs: new TrashFS(workspace), vRel: relTo('Trash'), treeType: 'trash' };
    }

    if (inRoot('Trees')) {
      if (!workspace?.isActive) return { error: { code: 503, message: 'Workspace not active' } };
      const parts = relTo('Trees').split('/').filter(Boolean);

      if (parts.length === 0) {
        const trees = await workspace.listTrees();
        return {
          vfs: {
            stat: async (vPath) => vPath === '/' ? { isDir: true, name: 'Trees', size: 0 } : null,
            readdir: async () => trees.map((tree) => ({ name: tree.name, isDir: true, size: 0 })),
            getContent: async () => null,
          },
          vRel: '/',
          treeType: 'trees',
        };
      }

      let tree = null;
            void tree;
      try {
        tree = workspace.getTree(parts[0]);
      } catch {
        return { error: { code: 404, message: 'Tree not found' } };
      }
      if (!tree) return { error: { code: 404, message: 'Tree not found' } };

      return {
        vfs: new TreeFS(workspace, tree),
        vRel: parts.length > 1 ? '/' + parts.slice(1).join('/') : '/',
        treeType: tree.type,
      };
    }

    return null;
  }

  // ── DAV root (virtual directories) ──────────────────────────────────

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

  async _handleHome(res, { method, prefix, mountPrefix, rel, homePath, headers, body, workspace, resolveTarget }) {
    const abs = path.resolve(homePath, '.' + rel);
    const relative = path.relative(homePath, abs);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return send(res, 403, 'Forbidden');

    // The workspace's own runtime dirs (`.workspace/` in the home layout, where
    // the exported drive IS the workspace root) do not exist as far as DAV is
    // concerned: they are hidden from listings and unreachable by any method,
    // so a client cannot browse — or delete — the workspace out from under itself.
    const isHidden = internalPathMatcher(homePath, workspace);
    if (isHidden(abs)) return send(res, 404, 'Not Found');

    const ctx = { res, abs, rel, prefix, mountPrefix, homePath, headers, body, workspace, isHidden, resolveTarget };

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

  async _propfind({ res, abs, rel, prefix, headers, body, isHidden = () => false }) {
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
            if (isHidden(path.join(abs, child.name))) continue;
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

  async _get({ res, abs, headers = {}, isHidden = () => false }) {
    let stat;
    try { stat = await fs.stat(abs); }
    catch { return send(res, 404, 'Not Found'); }

    if (stat.isDirectory()) {
      const children = (await fs.readdir(abs)).filter((name) => !isHidden(path.join(abs, name)));
      const html = `<!DOCTYPE html><html><body><h1>Index</h1><ul>${children.map(c => `<li><a href="${esc(encodeURIComponent(c))}">${esc(c)}</a></li>`).join('')}</ul></body></html>`;
      return sendBody(res, 200, html, 'text/html; charset=utf-8');
    }

    const baseHeaders = {
      'Content-Type': mime(abs),
      'ETag': etag(stat),
      'Last-Modified': httpDate(stat.mtime),
      'Accept-Ranges': 'bytes',
    };

    // Without this a player seeking in a large file re-reads it from the start,
    // and anything that reads a header before deciding what to do downloads the
    // whole thing first.
    const range = parseRange(headers['range'], stat.size);
    if (range?.unsatisfiable) {
      res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    if (range) {
      const length = range.end - range.start + 1;
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Length': length,
        'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
      });
      return await streamTo(res, createReadStream(abs, { start: range.start, end: range.end }));
    }

    res.writeHead(200, { ...baseHeaders, 'Content-Length': stat.size });
    await streamTo(res, createReadStream(abs));
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

  async _copyMove({ res, abs, prefix, mountPrefix, homePath, headers, workspace, isHidden = () => false, resolveTarget }, isMove) {
    const dest = headers['destination'];
    if (!dest) return send(res, 400, 'Destination header required');

    let destUrl;
    try { destUrl = new URL(dest, `http://${headers['host']}`); }
    catch { return send(res, 400, 'Invalid Destination'); }

    const destDecoded = decodeURIComponent(destUrl.pathname);
    const destRel = destDecoded.startsWith(prefix) ? (destDecoded.slice(prefix.length) || '/') : null;

    // Leaving Home for an index-backed root is an INGEST: this is one of the
    // two places where bytes genuinely move rather than a membership changing.
    if (!destRel && mountPrefix && destDecoded.startsWith(mountPrefix)) {
      return await this._ingestFromHome(res, {
        abs, workspace, isMove,
        destRel: destDecoded.slice(mountPrefix.length) || '/',
        resolveTarget,
      });
    }

    if (!destRel) return send(res, 502, 'Destination outside WebDAV scope');

    const destAbs = path.resolve(homePath, '.' + destRel);
    const destRelative = path.relative(homePath, destAbs);
    if (destRelative.startsWith('..') || path.isAbsolute(destRelative)) return send(res, 403, 'Forbidden');
    if (isHidden(destAbs)) return send(res, 403, 'Forbidden');

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

  /**
   * Home → Trees/Contexts. The file's bytes are persisted into the local blob
   * store (content-addressed, so re-ingesting the same file resolves to the
   * same document) and filed at the destination path as a File document.
   */
  async _ingestFromHome(res, { abs, workspace, destRel, isMove, resolveTarget }) {
    const target = typeof resolveTarget === 'function' ? await resolveTarget(destRel) : null;
    if (!target || target.error || target.kind === 'home') return send(res, 502, 'Destination not in an index-backed tree');
    if (typeof target.vfs?.putFile !== 'function') return send(res, 403, 'This virtual tree cannot receive files');

    let stat;
    try { stat = await fs.stat(abs); }
    catch { return send(res, 404, 'Not Found'); }
    if (stat.isDirectory()) return send(res, 502, 'Only files can be filed into a tree');

    const blob = await workspace.persistBlob(createReadStream(abs));
    await target.vfs.putFile(target.vRel, blob);
    if (isMove) { await fs.rm(abs, { force: true }); }
    send(res, 201);
  }

  /**
   * Trees/Contexts → Home. The document's content is written into the home
   * drive as a real file. On MOVE the document is then unfiled with the normal
   * mount rule, so if that was its last placement it lands in the trash and
   * stays recoverable — and if the home backend indexes the new file, content
   * addressing resolves it back to the same document, which un-trashes it.
   */
  async _materializeToHome(res, { vfs, vRel, target, isMove, doc }) {
    const content = await vfs.getContent(vRel);
    if (!content) return send(res, 404, 'Source not found');

    await fs.mkdir(path.dirname(target.abs), { recursive: true });
    if (content.stream) {
      await pipeline(content.stream, createWriteStream(target.abs));
    } else if (content.buffer) {
      await fs.writeFile(target.abs, content.buffer);
    } else {
      return send(res, 500);
    }

    if (isMove && doc && typeof vfs.unlinkDoc === 'function') {
      await vfs.unlinkDoc(vRel, doc, { trashIfOrphaned: true });
    }
    send(res, 201);
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

  async _handleVirtual(res, { method, prefix, rel, vRel, workspace, headers, body, vfs: prebuiltVfs, treeType, resolveTarget }) {
    const vfs = prebuiltVfs || new TreeFS(workspace, workspace.getDefaultContextTree());

    try {
      switch (method) {
        case 'OPTIONS':  return this._options({ res });
        case 'PROPFIND': return await this._vPropfind(res, { prefix, rel, vRel, headers, body, vfs, treeType });
        case 'PROPPATCH': return await this._vProppatch(res, { prefix, rel, vRel, headers, body, vfs });
        case 'GET':      return await this._vGet(res, { vRel, vfs, treeType, headers });
        case 'HEAD':     return await this._vHead(res, { vRel, vfs });
        case 'PUT':      return await this._vPut(res, { vRel, body, vfs });
        case 'DELETE':   return await this._vDelete(res, { vRel, vfs, treeType });
        case 'MKCOL':    return await this._vMkcol(res, { vRel, vfs });
        case 'MOVE':     return await this._vMove(res, { vRel, vfs, prefix, headers, treeType, resolveTarget });
        case 'COPY':     return await this._vCopy(res, { vRel, vfs, prefix, headers, resolveTarget });
        case 'LOCK':     return await this._vLock(res, { prefix, rel, headers, body });
        case 'UNLOCK':   return await this._unlock({ res, headers });
        default:         return send(res, 405, 'Method Not Allowed');
      }
    } catch (err) {
      if (isClientAbort(err)) return;
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

  async _vGet(res, { vRel, vfs, treeType, headers = {} }) {
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

    // The same identity PROPFIND reported, on the body itself — a client that
    // validates what it is reading against what it was told has to see one
    // answer, or it treats the file as changed mid-read and abandons the GET.
    const identity = entryIdentity(info);
    if (identity.ETag && matchesEtag(headers['if-none-match'], identity.ETag)) {
      res.writeHead(304, identity);
      return res.end();
    }

    // Blob-backed documents can be served by the byte window `stored` already
    // supports, so seeking in a video filed in a canvas works like seeking in a
    // file. `ranged` reports whether the backend really honoured it.
    const wanted = parseRange(headers?.['range'], info.size);
    if (wanted?.unsatisfiable) {
      res.writeHead(416, { ...identity, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes */${info.size}` });
      return res.end();
    }

    // `doc` is what stat() already resolved — see TreeFS.getContent.
    const content = await vfs.getContent(vRel, {
        ...(info.doc ? { doc: info.doc } : {}),
        ...(wanted ? { range: { start: wanted.start, end: wanted.end } } : {}),
    });
    if (!content) return send(res, 404, 'Not Found');

    if (content.stream) {
      const bodyHeaders = { ...identity, 'Content-Type': content.contentType, 'Accept-Ranges': 'bytes' };
      if (wanted && content.ranged) {
        const length = wanted.end - wanted.start + 1;
        res.writeHead(206, {
          ...bodyHeaders,
          'Content-Length': length,
          'Content-Range': `bytes ${wanted.start}-${wanted.end}/${info.size}`,
        });
        return await streamTo(res, content.stream);
      }
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

  async _vHead(res, { vRel, vfs }) {
    const info = await vfs.stat(vRel);
    if (!info) return send(res, 404);

    // Everything a HEAD promises must be what the GET then delivers, identity
    // included — clients that HEAD before they GET compare the two.
    res.writeHead(200, {
      ...entryIdentity(info),
      'Content-Type': info.isDir ? 'httpd/unix-directory' : mime(vRel),
      'Content-Length': info.isDir ? 0 : (info.size || 0),
      ...(info.isDir ? {} : { 'Accept-Ranges': 'bytes' }),
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
    // Finder/Explorer sidecars are client bookkeeping, never documents. Accept
    // and drop them: a 403 would make a plain `cp -r` from a Mac look failed.
    if (isClientDropping(path.posix.basename(norm(vRel)))) {
      await readBodyBuffer(body, 16 * 1024 * 1024).catch(() => null);
      return send(res, 201);
    }
    const buf = await readBodyBuffer(body, 16 * 1024 * 1024);
    const result = await vfs.put(vRel, buf);
    send(res, result?.created === false ? 204 : 201);
  }

  async _vDelete(res, { vRel, vfs, treeType }) {
    if (typeof vfs.del !== 'function') return send(res, 403, 'This virtual tree is read-only');
    if (isClientDropping(path.posix.basename(norm(vRel)))) return send(res, 204);
    // Under a tree, `rm` detaches from the path and — if that was the last
    // placement — files the document into the trash, so nothing a delete
    // touches becomes unreachable. Contexts are a VIEW: detaching from one is
    // not deletion, so no trash there. Inside the trash, delete destroys.
    await vfs.del(vRel, { trashIfOrphaned: treeType === 'context' || treeType === 'directory' });
    send(res, 204);
  }

  async _vMkcol(res, { vRel, vfs }) {
    if (typeof vfs.mkcol !== 'function') return send(res, 403, 'This virtual tree is read-only');
    await vfs.mkcol(vRel);
    send(res, 201);
  }

  /**
   * MOVE is a change of membership, not a transfer of bytes: file the document
   * at the destination, unfile it at the source. Both halves are id-level, so a
   * 4GB blob moves as cheaply as a note, and because every virtual FS answers
   * the same two verbs it works across trees and across roots — including
   * Trees → Trash (remove it everywhere) and Trash → Trees (restore).
   */
  // Same tree AND same folder — i.e. the source and destination differ only in
  // filename, so the operation is a rename, not a move between places.
  _sameContainer(srcVfs, destVfs, srcVRel, destVRel) {
    const sameTree = Boolean(srcVfs?.treeId) && srcVfs.treeId === destVfs?.treeId;
    if (!sameTree) return false;
    return path.posix.dirname(norm(srcVRel)) === path.posix.dirname(norm(destVRel));
  }

  /** Parse a Destination header into a path relative to this DAV mount. */
  _destinationRel(headers, prefix) {
    const dest = headers['destination'];
    if (!dest) return { error: { code: 400, message: 'Destination header required' } };
    let destUrl;
    try { destUrl = new URL(dest, `http://${headers['host']}`); }
    catch { return { error: { code: 400, message: 'Invalid Destination' } }; }
    const decoded = decodeURIComponent(destUrl.pathname);
    if (!decoded.startsWith(prefix)) return { error: { code: 502, message: 'Destination outside scope' } };
    return { rel: decoded.slice(prefix.length) || '/' };
  }

  async _vMove(res, { vRel, vfs, prefix, headers, resolveTarget }) {
    const { rel: destRel, error } = this._destinationRel(headers, prefix);
    if (error) return send(res, error.code, error.message);

    if (isClientDropping(path.posix.basename(norm(vRel)))) return send(res, 201);

    const target = typeof resolveTarget === 'function' ? await resolveTarget(destRel) : null;
    if (!target || target.error) return send(res, 502, 'Destination not in an index-backed tree');

    const doc = typeof vfs.docAt === 'function' ? await vfs.docAt(vRel) : null;

    if (target.kind === 'home') {
      if (!doc) return send(res, 502, 'Only files can be moved into Home');
      return await this._materializeToHome(res, { vfs, vRel, target, isMove: true, doc });
    }

    // A folder is not a document: moving or renaming one is a tree operation,
    // and every document filed under it comes along untouched. Only possible
    // within one tree — across trees the nodes have nothing in common.
    if (!doc) {
      const info = typeof vfs.stat === 'function' ? await vfs.stat(vRel) : null;
      if (!info) return send(res, 404, 'Source not found');
      if (!info.isDir) return send(res, 404, 'Source not found');
      if (typeof vfs.movePath !== 'function' || vfs.treeId !== target.vfs?.treeId) {
        return send(res, 502, 'Folders can only be moved within the same tree');
      }
      await vfs.movePath(vRel, target.vRel);
      return send(res, 201);
    }

    if (typeof target.vfs.linkDoc !== 'function') {
      return send(res, 403, 'This virtual tree does not support moving');
    }

    await target.vfs.linkDoc(target.vRel, doc);

    // A rename in place (same container, same folder) is ONLY the rename —
    // unfiling the source here would remove the document from the very folder
    // it was just renamed in, which is what a file manager's F2 does all day.
    if (!this._sameContainer(vfs, target.vfs, vRel, target.vRel) && typeof vfs.unlinkDoc === 'function') {
      // The document is filed at the destination before it is unfiled here, so a
      // failure leaves it findable in both places rather than in neither. The
      // source unlink never trashes: it did not orphan anything.
      await vfs.unlinkDoc(vRel, doc, { trashIfOrphaned: false });
    }
    send(res, 201);
  }

  /**
   * COPY is the half of MOVE without the unlink — which is exactly what a
   * document already supports, because a document lives at as many paths as you
   * like. No bytes are duplicated: the same document gains a placement.
   */
  async _vCopy(res, { vRel, vfs, prefix, headers, resolveTarget }) {
    const { rel: destRel, error } = this._destinationRel(headers, prefix);
    if (error) return send(res, error.code, error.message);

    if (isClientDropping(path.posix.basename(norm(vRel)))) return send(res, 201);

    const target = typeof resolveTarget === 'function' ? await resolveTarget(destRel) : null;
    if (!target || target.error) return send(res, 502, 'Destination not in an index-backed tree');

    const doc = typeof vfs.docAt === 'function' ? await vfs.docAt(vRel) : null;

    if (target.kind === 'home') {
      if (!doc) return send(res, 502, 'Only files can be copied into Home');
      return await this._materializeToHome(res, { vfs, vRel, target, isMove: false, doc });
    }

    if (!doc) {
      const info = typeof vfs.stat === 'function' ? await vfs.stat(vRel) : null;
      if (!info?.isDir) return send(res, 404, 'Source not found');
      if (typeof vfs.copyPath !== 'function' || vfs.treeId !== target.vfs?.treeId) {
        return send(res, 502, 'Folders can only be copied within the same tree');
      }
      await vfs.copyPath(vRel, target.vRel);
      return send(res, 201);
    }

    if (typeof target.vfs.linkDoc !== 'function') {
      return send(res, 403, 'This virtual tree does not support copying');
    }

    // "Duplicate here" has no meaning in a content-addressed store: the copy
    // would resolve to the same document by checksum, and a document has one
    // name — so the operation would rename the original rather than duplicate
    // it. Say so instead of quietly doing the wrong thing.
    if (this._sameContainer(vfs, target.vfs, vRel, target.vRel)) {
      return send(res, 409, 'A document cannot be duplicated within the same folder — the copy is the same document');
    }

    await target.vfs.linkDoc(target.vRel, doc);
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

/**
 * A virtual entry as WebDAV properties.
 *
 * A FILE's identity has to be stable: the entry carries the document's own
 * mtime and ETag (see docMtime/docEtag), because a mount that answers every
 * PROPFIND with a fresh stamp is telling the client the file changed under it —
 * and a caching client reacts by dropping the GET it has in flight, which is
 * how opening an image drew it once and then failed.
 *
 * A COLLECTION has no body to drop, and a stale listing would be the worse
 * failure, so it keeps the volatile stamp and carries no ETag at all (RFC 4918
 * only asks for one where there is an entity to compare).
 */
function virtualPropEntry(entry, prefix, rel) {
  const isDir = entry.isDir;
  const href = esc(encSegments(prefix + rel) + (isDir && !rel.endsWith('/') ? '/' : ''));
  const name = esc(entry.name || path.basename(rel) || 'root');
  const stamp = entry.mtime ? new Date(entry.mtime) : new Date();
  const props = [
    `<D:displayname>${name}</D:displayname>`,
    `<D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>`,
    `<D:getlastmodified>${httpDate(stamp)}</D:getlastmodified>`,
    `<D:creationdate>${isoDate(stamp)}</D:creationdate>`,
  ];
  if (!isDir) {
    props.push(`<D:getetag>${esc(entry.etag || `"v-${name}-${entry.size || 0}"`)}</D:getetag>`);
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
