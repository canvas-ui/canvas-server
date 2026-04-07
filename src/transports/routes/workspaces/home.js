'use strict';

import { promises as fs, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import crypto from 'crypto';
import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

const HOME_BACKEND_FEATURE = 'data/backend/home';

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

function resolveSafe(homePath, relPath) {
  const abs = path.resolve(homePath, relPath);
  const rel = path.relative(homePath, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
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

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

export default async function homeRoutes(fastify) {

  // ─────────────────────────────────────────────────────────────────────────
  // Filesystem browsing
  // ─────────────────────────────────────────────────────────────────────────

  fastify.get('/', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    return listDir(request.workspace.homePath, '.', reply);
  });

  fastify.get('/*', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    const workspace = request.workspace;
    const relPath = request.params['*'];
    if (!relPath) return listDir(workspace.homePath, '.', reply);

    const abs = resolveSafe(workspace.homePath, relPath);
    if (!abs) return reply.code(403).send(new ResponseObject().forbidden('Path traversal').getResponse());

    let stat;
    try { stat = await fs.stat(abs); }
    catch { return reply.code(404).send(new ResponseObject().notFound('Not found').getResponse()); }

    if (request.query.download !== undefined && !stat.isDirectory()) {
      reply.header('Content-Type', mime(abs));
      reply.header('Content-Length', stat.size);
      reply.header('Content-Disposition', `attachment; filename="${path.basename(abs)}"`);
      return reply.send(createReadStream(abs));
    }

    if (stat.isDirectory()) {
      return listDir(workspace.homePath, relPath, reply);
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

    const abs = resolveSafe(request.workspace.homePath, relPath);
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

    const abs = resolveSafe(request.workspace.homePath, dirPath);
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

    const abs = resolveSafe(request.workspace.homePath, relPath);
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
  // Promote files to SynapsD index
  // ─────────────────────────────────────────────────────────────────────────

  fastify.post('/actions/index', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
  }, async (request, reply) => {
    const workspace = request.workspace;
    if (!workspace.isActive) {
      return reply.code(400).send(new ResponseObject().badRequest('Workspace not active').getResponse());
    }

    const { files, context = '/' } = request.body || {};
    const contextTreeSelector = workspace.getContextTreeSelector(context);
    if (!Array.isArray(files) || files.length === 0) {
      return reply.code(400).send(new ResponseObject().badRequest('files array required').getResponse());
    }

    const results = { indexed: [], failed: [] };

    for (const filePath of files) {
      if (typeof filePath !== 'string') {
        results.failed.push({ path: filePath, error: 'invalid path' });
        continue;
      }

      const abs = resolveSafe(workspace.homePath, filePath);
      if (!abs) {
        results.failed.push({ path: filePath, error: 'path traversal' });
        continue;
      }

      try {
        const stat = await fs.stat(abs);
        const name = path.basename(filePath);
        const dataPath = `file://{WORKSPACE_ROOT}/home/${filePath}`;

        if (stat.isDirectory()) {
          await workspace.put({
            schema: 'data/abstraction/folder',
            data: { name, path: filePath, backend: 'home' },
            locations: [{ url: dataPath }],
          }, { context: contextTreeSelector, features: [HOME_BACKEND_FEATURE] });

          results.indexed.push({ path: filePath, type: 'folder' });
        } else {
          const checksum = await sha256File(abs);
          const checksumString = `sha256/${checksum}`;

          await workspace.put({
            schema: 'data/abstraction/file',
            checksumArray: [checksumString],
            data: { filename: name, size: stat.size, mime: mime(abs) },
            locations: [{ url: dataPath }],
          }, { context: contextTreeSelector, features: [HOME_BACKEND_FEATURE] });

          results.indexed.push({ path: filePath, type: 'file', checksum: checksumString });
        }
      } catch (err) {
        results.failed.push({ path: filePath, error: err.message });
      }
    }

    const r = new ResponseObject().success(results, `Indexed ${results.indexed.length} files`);
    return reply.code(r.statusCode).send(r.getResponse());
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  async function listDir(homePath, relPath, reply) {
    const abs = resolveSafe(homePath, relPath);
    if (!abs) return reply.code(403).send(new ResponseObject().forbidden('Path traversal').getResponse());

    let entries;
    try {
      const dirents = await fs.readdir(abs, { withFileTypes: true });
      entries = await Promise.all(dirents.map(async (d) => {
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
