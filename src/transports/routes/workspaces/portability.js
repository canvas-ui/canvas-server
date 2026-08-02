'use strict';

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead } from '../../middleware/workspace-acl.js';
import {
  exportWorkspace,
  listExports,
  deleteExport,
  exportFilePath,
  importWorkspace,
  importWorkspaceFromRemote,
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
export default async function portabilityRoutes(fastify) {
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
  }, async (request, reply) => {
    try {
      const item = await exportWorkspace(fastify.workspaceManager, {
        userId: request.user.id,
        userEmail: await ownerEmail(request),
        workspaceId: request.params.id,
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

  fastify.get('/exports/:name', {
    onRequest: [fastify.authenticate],
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
