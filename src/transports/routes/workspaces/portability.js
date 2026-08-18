'use strict';

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import ResponseObject from '../../ResponseObject.js';
import { env } from '../../../env.js';
import { requireWorkspaceRead } from '../../middleware/workspace-acl.js';
import {
  exportWorkspace,
  listExports,
  deleteExport,
  exportFilePath,
  importWorkspace,
  importWorkspaceFromRemote,
  saveUploadedArchive,
} from '../../../core/workspace/lib/portability.js';

/**
 * Workspace export/import.
 *
 *  GET    /token-info         which workspace the presented share token is bound to
 *  POST   /:id/export         archive a stopped workspace into the owner's Exports dir
 *  GET    /:id/exports        list that workspace's export archives
 *  GET    /:id/exports/:name  download one of that workspace's archives (streamed)
 *  DELETE /:id/exports/:name  remove one of that workspace's archives
 *  GET    /exports            list ALL the user's export archives (name, size, url)
 *  GET    /exports/:name      download an archive (streamed)
 *  DELETE /exports/:name      remove an archive
 *  POST   /import             body { path } — server-side folder or archive path,
 *                             { export } — local archive name, or
 *                             { url, token } — pull from a remote canvas-server
 *                             using a workspace share token
 *
 * The :id-scoped routes are read-gated via the workspace ACL — regular owners
 * always pass, and workspace share tokens pass for their bound workspace,
 * which is what lets another canvas-server pull a workspace with only a
 * share token (see importWorkspaceFromRemote). Export = full read, so 'read'
 * is the honest permission level.
 */
// Short-lived, HttpOnly cookie that lets the browser download an export
// archive directly. An archive is routinely GB-sized, so it must stream to
// disk via the browser's own download machinery — fetching it into a Blob to
// attach an Authorization header would pull the whole thing into memory, and
// putting a token in the URL would leak it into history and logs. Same shape
// as the media ticket on the document content route.
const EXPORT_COOKIE = 'cvs_export';
const EXPORT_TICKET_TTL = 3600; // seconds — a large download needs real time

function readCookie(request, name) {
  const raw = request.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const val = part.slice(eq + 1).trim();
    try { return decodeURIComponent(val); } catch { return val; }
  }
  return null;
}

// Ceiling for a single uploaded archive (4 GiB). The body is streamed straight
// to disk, never buffered, so this bounds disk use rather than memory.
const ARCHIVE_UPLOAD_LIMIT = 4 * 1024 * 1024 * 1024;

export default async function portabilityRoutes(fastify) {
  // Archive uploads arrive as a raw binary body (not multipart): the global
  // multipart limit is sized for small attachments, and a workspace export is
  // routinely orders of magnitude larger. Handing the stream through
  // unparsed keeps a multi-GB upload out of memory. Scoped to this plugin, so
  // JSON on the sibling workspace routes is unaffected.
  fastify.addContentTypeParser(
    ['application/gzip', 'application/x-gzip', 'application/x-bzip2', 'application/x-tar', 'application/octet-stream'],
    { bodyLimit: ARCHIVE_UPLOAD_LIMIT },
    (_req, payload, done) => done(null, payload),
  );

  // Bearer if present, otherwise a valid export ticket cookie. The route's
  // own ownership/ACL checks still run afterwards either way.
  async function authenticateExport(request, reply) {
    if (request.headers.authorization) {
      try { await fastify.authenticate(request, reply); return; } catch { /* try the ticket */ }
    }
    const token = readCookie(request, EXPORT_COOKIE);
    if (token) {
      try {
        const payload = fastify.jwt.verify(token);
        if (payload?.scope === 'export' && payload.sub && payload.email) {
          request.user = { id: payload.sub, email: payload.email };
          return;
        }
      } catch { /* fall through to 401 */ }
    }
    const r = new ResponseObject().unauthorized('Authentication required');
    return reply.code(r.statusCode).send(r.getResponse());
  }

  const sendError = (reply, err) => {
    const statusCode = err.statusCode || 500;
    const response = new ResponseObject().error(err.message, null, statusCode);
    return reply.code(statusCode).send(response.getResponse());
  };

  // Which workspace is this share token bound to? Lets a remote server (or
  // CLI) resolve {url, token} to a workspace without knowing its id.
  fastify.get('/token-info', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const binding = request.resourceToken;
    if (binding?.type !== 'workspace') {
      const response = new ResponseObject().badRequest('Present a workspace share token to resolve');
      return reply.code(response.statusCode).send(response.getResponse());
    }
    const response = new ResponseObject().found({
      workspaceId: binding.workspaceId,
      workspaceName: binding.workspaceName,
      permissions: binding.permissions,
    }, 'Token resolved');
    return reply.code(response.statusCode).send(response.getResponse());
  });

  // Owner email — exports live in the OWNER's Exports dir even when the
  // caller is a share-token principal (request.user is the owner then anyway).
  const ownerEmail = async (request) => {
    const owner = request.workspace?.owner;
    if (owner && owner !== request.user.id) {
      const user = await request.server.users.get(owner);
      return user?.email || request.user.email;
    }
    return request.user.email;
  };

  // An export archive belongs to a workspace when it was named after it.
  const belongsTo = (workspace, name) => name.startsWith(`${workspace.name}-`);

  fastify.post('/:id/export', {
    onRequest: [fastify.authenticate, requireWorkspaceRead({ allowIndexFallback: true })],
    schema: {
      body: {
        type: 'object',
        // Stopping a running workspace is a side effect on someone's live
        // session, so it is opt-in per request rather than implied by export.
        properties: { stop: { type: 'boolean', default: false } },
      },
    },
  }, async (request, reply) => {
    try {
      // Read is enough to export, but stopping a workspace interrupts whoever
      // is using it — that needs write. Otherwise a read-only share token
      // could shut down the owner's live workspace as a side effect of a pull.
      const wantsStop = request.body?.stop === true;
      const binding = request.resourceToken;
      if (wantsStop && binding?.type === 'workspace' && !binding.permissions?.includes('write')) {
        const response = new ResponseObject().forbidden('Stopping the workspace requires write permission');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const item = await exportWorkspace(fastify.workspaceManager, {
        userId: request.user.id,
        userEmail: await ownerEmail(request),
        workspaceId: request.params.id,
        stop: wantsStop,
      });
      const response = new ResponseObject().created({
        ...item,
        url: `/rest/v2/workspaces/${encodeURIComponent(request.params.id)}/exports/${encodeURIComponent(item.name)}`,
      }, 'Workspace exported');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get('/:id/exports', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    try {
      const items = (await listExports(fastify.workspaceManager, await ownerEmail(request)))
        .filter((item) => belongsTo(request.workspace, item.name))
        .map((item) => ({
          ...item,
          url: `/rest/v2/workspaces/${encodeURIComponent(request.params.id)}/exports/${encodeURIComponent(item.name)}`,
        }));
      const response = new ResponseObject().found(items, 'Exports retrieved', 200, items.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get('/:id/exports/:name', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    try {
      if (!belongsTo(request.workspace, request.params.name)) {
        const response = new ResponseObject().notFound(`Export not found: ${request.params.name}`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const file = exportFilePath(fastify.workspaceManager, await ownerEmail(request), request.params.name);
      const stat = await fsPromises.stat(file).catch(() => null);
      if (!stat?.isFile()) {
        const response = new ResponseObject().notFound(`Export not found: ${request.params.name}`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      reply.header('Content-Type', 'application/gzip');
      reply.header('Content-Length', stat.size);
      reply.header('Content-Disposition', `attachment; filename="${request.params.name}"`);
      return reply.send(fs.createReadStream(file));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.delete('/:id/exports/:name', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
  }, async (request, reply) => {
    try {
      if (!belongsTo(request.workspace, request.params.name)) {
        const response = new ResponseObject().notFound(`Export not found: ${request.params.name}`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const removed = await deleteExport(fastify.workspaceManager, await ownerEmail(request), request.params.name);
      const response = removed
        ? new ResponseObject().deleted({ name: request.params.name }, 'Export removed')
        : new ResponseObject().notFound(`Export not found: ${request.params.name}`);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.get('/exports', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const items = await listExports(fastify.workspaceManager, request.user.email);
      const payload = items.map((item) => ({
        ...item,
        url: `/rest/v2/workspaces/exports/${encodeURIComponent(item.name)}`,
      }));
      const response = new ResponseObject().found(payload, 'Exports retrieved', 200, payload.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * Mint the download ticket cookie (authed by bearer), so a plain browser
   * navigation to /exports/:name streams the archive straight to disk.
   * Scoped to this user's export routes only.
   */
  fastify.post('/exports/ticket', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const token = fastify.jwt.sign(
      { scope: 'export', sub: request.user.id, email: request.user.email },
      { expiresIn: `${EXPORT_TICKET_TTL}s` },
    );
    // Derive the cookie path from this request's own URL so it stays correct
    // regardless of the API mount prefix.
    const urlPath = request.url.split('?')[0];
    const cut = urlPath.indexOf('/exports');
    const cookiePath = cut >= 0 ? urlPath.slice(0, cut + '/exports'.length) : '/';
    const cookie = [
      `${EXPORT_COOKIE}=${encodeURIComponent(token)}`,
      `Path=${cookiePath}`,
      `Max-Age=${EXPORT_TICKET_TTL}`,
      'HttpOnly',
      'SameSite=Strict',
      request.protocol === 'https' ? 'Secure' : null,
    ].filter(Boolean).join('; ');
    reply.header('Set-Cookie', cookie);
    const response = new ResponseObject().success({ ttl: EXPORT_TICKET_TTL }, 'Export ticket issued');
    return reply.code(response.statusCode).send(response.getResponse());
  });

  fastify.get('/exports/:name', {
    onRequest: [authenticateExport],
  }, async (request, reply) => {
    try {
      const file = exportFilePath(fastify.workspaceManager, request.user.email, request.params.name);
      const stat = await fsPromises.stat(file).catch(() => null);
      if (!stat?.isFile()) {
        const response = new ResponseObject().notFound(`Export not found: ${request.params.name}`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      reply.header('Content-Type', 'application/gzip');
      reply.header('Content-Length', stat.size);
      reply.header('Content-Disposition', `attachment; filename="${request.params.name}"`);
      return reply.send(fs.createReadStream(file));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.delete('/exports/:name', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const removed = await deleteExport(fastify.workspaceManager, request.user.email, request.params.name);
      const response = removed
        ? new ResponseObject().deleted({ name: request.params.name }, 'Export removed')
        : new ResponseObject().notFound(`Export not found: ${request.params.name}`);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * Import from the user's local drive. The browser streams the archive here
   * and it lands in the user's own Exports dir — the client supplies a
   * filename, never a path, which is what keeps this scoped to the user's
   * home no matter what it sends.
   *
   * `?import=false` uploads only (the archive shows up in the Exports list);
   * the default also runs extract -> validate -> load and returns the
   * registered workspace.
   */
  fastify.post('/import/upload', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    let stored;
    try {
      const filename = request.query?.filename || 'upload.tar.gz';
      if (!request.body || typeof request.body.pipe !== 'function') {
        const response = new ResponseObject().badRequest('Send the archive as a binary request body');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      stored = await saveUploadedArchive(
        fastify.workspaceManager,
        request.user.email,
        filename,
        request.body,
      );

      if (request.query?.import === 'false') {
        const response = new ResponseObject().created(stored, 'Archive uploaded');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const entry = await importWorkspace(fastify.workspaceManager, {
        userId: request.user.id,
        userEmail: request.user.email,
        source: exportFilePath(fastify.workspaceManager, request.user.email, stored.name),
      });
      const response = new ResponseObject().created({ ...entry, archive: stored }, 'Workspace imported');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (err) {
      // A rejected archive is not worth keeping around; the upload only
      // existed to be imported.
      if (stored?.name) {
        await deleteExport(fastify.workspaceManager, request.user.email, stored.name).catch(() => {});
      }
      return sendError(reply, err);
    }
  });

  fastify.post('/import', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          export: { type: 'string' },
          url: { type: 'string' },
          token: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { path: sourcePath, export: exportName, url, token } = request.body || {};

      // Remote pull: {url, token} fetches the workspace from another
      // canvas-server instance using a workspace share token.
      if (url) {
        const entry = await importWorkspaceFromRemote(fastify.workspaceManager, {
          userId: request.user.id,
          userEmail: request.user.email,
          url,
          token,
          allowInsecure: env.workspace?.allowInsecureRemoteImport === true,
        });
        const response = new ResponseObject().created(entry, 'Workspace imported from remote');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const source = exportName
        ? exportFilePath(fastify.workspaceManager, request.user.email, exportName)
        : sourcePath;
      const entry = await importWorkspace(fastify.workspaceManager, {
        userId: request.user.id,
        userEmail: request.user.email,
        source,
      });
      const response = new ResponseObject().created(entry, 'Workspace imported');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
