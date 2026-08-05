'use strict';

import { promises as fs, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';
import { internalPathMatcher } from '../../../core/workspace/lib/internal-paths.js';

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain',
  '.md': 'text/markdown', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wav': 'audio/wav',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const mime = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

// Resolve a client-supplied path against the workspace's home drive. Returns
// null for anything outside it AND for the workspace's own internals — in the
// `home` layout those live inside the exported tree, and browsing (let alone
// deleting) them is never a user operation.
function resolveSafe(workspace, relPath) {
  const homePath = workspace.homePath;
  const abs = path.resolve(homePath, relPath);
  const rel = path.relative(homePath, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (internalPathMatcher(homePath, workspace)(abs)) return null;
  return abs;
}

async function statEntry(abs, name) {
  const s = await fs.stat(abs);
  return {
    name,
    size: s.size,
    isDirectory: s.isDirectory(),
    mtime: s.mtime.toISOString(),
    ctime: s.birthtime.toISOString(),
  };
}

/**
 * Parse a `Range` header against a known size: null when there is nothing to
 * honour, `{ start, end }` inclusive, or `{ unsatisfiable: true }` for a window
 * outside the file (a 416, not a silent full body).
 */
function parseByteRange(header, size) {
  if (!header || !Number.isFinite(size)) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  }

  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end };
}

export default async function homeRoutes(fastify) {

  // ─────────────────────────────────────────────────────────────────────────
  // Filesystem browsing
  // ─────────────────────────────────────────────────────────────────────────

  fastify.get('/', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    return listDir(request.workspace, '.', reply);
  });

  fastify.get('/*', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    const workspace = request.workspace;
    const relPath = request.params['*'];
    if (!relPath) return listDir(workspace, '.', reply);

    const abs = resolveSafe(workspace, relPath);
    if (!abs) return reply.code(403).send(new ResponseObject().forbidden('Path traversal').getResponse());

    let stat;
    try { stat = await fs.stat(abs); }
    catch { return reply.code(404).send(new ResponseObject().notFound('Not found').getResponse()); }

    if (request.query.download !== undefined && !stat.isDirectory()) {
      reply.header('Content-Type', mime(abs));
      reply.header('Content-Disposition', `attachment; filename="${path.basename(abs)}"`);
      reply.header('Accept-Ranges', 'bytes');

      // Byte windows, so a player seeking in a large file doesn't re-read it
      // from the start and a reader after a header doesn't pull the whole
      // thing. Single ranges only — answering 200 to a multi-range request is
      // legal, and multipart/byteranges buys nothing for these clients.
      const range = parseByteRange(request.headers.range, stat.size);
      if (range?.unsatisfiable) {
        reply.header('Content-Range', `bytes */${stat.size}`);
        return reply.code(416).send();
      }
      if (range) {
        reply.header('Content-Length', range.end - range.start + 1);
        reply.header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
        return reply.code(206).send(createReadStream(abs, { start: range.start, end: range.end }));
      }

      reply.header('Content-Length', stat.size);
      return reply.send(createReadStream(abs));
    }

    if (stat.isDirectory()) {
      return listDir(workspace, relPath, reply);
    }

    const entry = await statEntry(abs, path.basename(relPath));
    entry.mime = mime(abs);
    const r = new ResponseObject().found(entry, 'File info');
    return reply.code(r.statusCode).send(r.getResponse());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // File upload
  // ─────────────────────────────────────────────────────────────────────────

  fastify.put('/*', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
  }, async (request, reply) => {
    const relPath = request.params['*'];
    if (!relPath) return reply.code(400).send(new ResponseObject().badRequest('Path required').getResponse());

    const abs = resolveSafe(request.workspace, relPath);
    if (!abs) return reply.code(403).send(new ResponseObject().forbidden('Path traversal').getResponse());

    await fs.mkdir(path.dirname(abs), { recursive: true });

    if (request.raw && typeof request.raw.pipe === 'function') {
      const { createWriteStream } = await import('fs');
      await pipeline(request.raw, createWriteStream(abs));
    } else {
      await fs.writeFile(abs, request.body || '');
    }

    const stat = await fs.stat(abs);
    const r = new ResponseObject().success({ path: relPath, size: stat.size }, 'File saved');
    return reply.code(r.statusCode).send(r.getResponse());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Create directory
  // ─────────────────────────────────────────────────────────────────────────

  fastify.post('/mkdir', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
  }, async (request, reply) => {
    const dirPath = request.body?.path;
    if (!dirPath || typeof dirPath !== 'string') {
      return reply.code(400).send(new ResponseObject().badRequest('path required in body').getResponse());
    }

    const abs = resolveSafe(request.workspace, dirPath);
    if (!abs) return reply.code(403).send(new ResponseObject().forbidden('Path traversal').getResponse());

    await fs.mkdir(abs, { recursive: true });
    const r = new ResponseObject().success({ path: dirPath }, 'Directory created');
    return reply.code(r.statusCode).send(r.getResponse());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Delete
  // ─────────────────────────────────────────────────────────────────────────

  fastify.delete('/*', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
  }, async (request, reply) => {
    const relPath = request.params['*'];
    if (!relPath) return reply.code(400).send(new ResponseObject().badRequest('Path required').getResponse());

    const abs = resolveSafe(request.workspace, relPath);
    if (!abs) return reply.code(403).send(new ResponseObject().forbidden('Path traversal').getResponse());

    try {
      const stat = await fs.stat(abs);
      await (stat.isDirectory() ? fs.rm(abs, { recursive: true }) : fs.unlink(abs));
      const r = new ResponseObject().success(true, 'Deleted');
      return reply.code(r.statusCode).send(r.getResponse());
    } catch {
      return reply.code(404).send(new ResponseObject().notFound('Not found').getResponse());
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  async function listDir(workspace, relPath, reply) {
    const abs = resolveSafe(workspace, relPath);
    if (!abs) return reply.code(403).send(new ResponseObject().forbidden('Path traversal').getResponse());
    const isInternal = internalPathMatcher(workspace.homePath, workspace);

    let entries;
    try {
      const dirents = await fs.readdir(abs, { withFileTypes: true });
      entries = await Promise.all(dirents.map(async (d) => {
        if (isInternal(path.join(abs, d.name))) return null;
        try { return await statEntry(path.join(abs, d.name), d.name); }
        catch { return null; }
      }));
      entries = entries.filter(Boolean);
    } catch {
      return reply.code(404).send(new ResponseObject().notFound('Directory not found').getResponse());
    }

    const r = new ResponseObject().found({ path: relPath === '.' ? '/' : relPath, entries }, 'Directory listing');
    return reply.code(r.statusCode).send(r.getResponse());
  }
}
