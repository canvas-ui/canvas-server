'use strict';

import ResponseObject from '../../ResponseObject.js';

export default async function workspaceBitmapRoutes(fastify, options) {
  async function getWorkspaceInstance(request, reply) {
    const identifier = request.params.id;
    const userId = request.user.id;
    const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const workspaceId = isWorkspaceId ? identifier : await fastify.workspaceManager.resolveWorkspaceId(userId, identifier);

    if (!workspaceId) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }

    const workspace = await fastify.workspaceManager.getWorkspace(workspaceId, userId);
    if (!workspace) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }

    if (!workspace.isActive) {
      const responseObject = new ResponseObject().badRequest('Workspace is not active. Start the workspace first.');
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }

    return workspace;
  }

  // GET /workspaces/:id/bitmaps
  // Returns bitmap metadata list; optionally include bitmap IDs.
  fastify.get('/', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          includeData: { type: 'boolean', default: false },
          includeRaw: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      if (request.query.includeRaw === true) {
        const responseObject = new ResponseObject().badRequest('includeRaw is only supported for exact bitmap paths at /bitmaps/<key>');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const bitmaps = await workspace.listBitmaps('', {
        includeData: request.query.includeData === true
      });
      const responseObject = new ResponseObject().found(bitmaps, 'Bitmaps retrieved successfully', 200, bitmaps.length, bitmaps.length);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to list bitmaps');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // GET /workspaces/:id/bitmaps/*
  // Path traversal semantics:
  // - Prefix path (e.g. "data") => list metadata for matching bitmap keys
  // - Exact key path (e.g. "data/abstraction/tab") => return that bitmap metadata
  // Use includeData=true to include full bitmap IDs.
  fastify.get('/*', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', '*'],
        properties: {
          id: { type: 'string' },
          '*': { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          includeData: { type: 'boolean', default: false },
          includeRaw: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const bitmapPath = request.params['*'];
      const includeData = request.query.includeData === true;
      const includeRaw = request.query.includeRaw === true;
      const exact = await workspace.getBitmap(bitmapPath, { includeData });

      if (includeRaw) {
        if (!exact) {
          const responseObject = new ResponseObject().notFound(`Bitmap "${bitmapPath}" not found (includeRaw requires exact key match)`);
          return reply.code(responseObject.statusCode).send(responseObject.getResponse());
        }

        const rawBuffer = await workspace.getBitmapRawBuffer(bitmapPath);
        const safeName = bitmapPath.replace(/[^a-z0-9._-]+/gi, '_') || 'bitmap';
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Disposition', `attachment; filename="${safeName}.roar"`);
        reply.header('X-Bitmap-Key', exact.key);
        return reply.send(rawBuffer);
      }

      // Exact key wins, prefix list as fallback (JSON mode only).
      if (exact) {
        const responseObject = new ResponseObject().found(exact, 'Bitmap retrieved successfully');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const prefixed = await workspace.listBitmaps(bitmapPath, { includeData });
      if (!prefixed.length) {
        const responseObject = new ResponseObject().notFound(`No bitmap found for path "${bitmapPath}"`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(prefixed, 'Bitmap prefix retrieved successfully', 200, prefixed.length, prefixed.length);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get bitmap path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
