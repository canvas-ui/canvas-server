'use strict';

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import ResponseObject from '../../ResponseObject.js';
import {
  exportWorkspace,
  listExports,
  deleteExport,
  exportFilePath,
  importWorkspace,
} from '../../../core/workspace/lib/portability.js';

/**
 * Workspace export/import.
 *
 *  POST   /:id/export     archive a stopped workspace into the user's Exports dir
 *  GET    /exports        list the user's export archives (name, size, url)
 *  GET    /exports/:name  download an archive (streamed)
 *  DELETE /exports/:name  remove an archive
 *  POST   /import         register a server-side folder, or extract an archive
 *                         (body: { path } — absolute path, or { export } — archive name)
 */
export default async function portabilityRoutes(fastify) {
  const sendError = (reply, err) => {
    const statusCode = err.statusCode || 500;
    const response = new ResponseObject().error(err.message, null, statusCode);
    return reply.code(statusCode).send(response.getResponse());
  };

  fastify.post('/:id/export', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const item = await exportWorkspace(fastify.workspaceManager, {
        userId: request.user.id,
        userEmail: request.user.email,
        workspaceId: request.params.id,
      });
      const response = new ResponseObject().created({
        ...item,
        url: `/rest/v2/workspaces/exports/${encodeURIComponent(item.name)}`,
      }, 'Workspace exported');
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
        },
      },
    },
  }, async (request, reply) => {
    try {
      const { path: sourcePath, export: exportName } = request.body || {};
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
