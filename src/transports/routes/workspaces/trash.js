'use strict';

import ResponseObject from '../../ResponseObject.js';

/**
 * Trash — where a document goes when a filesystem-style delete (WebDAV,
 * canvas-fuse) removes its LAST placement, so nothing becomes reachable only
 * through the flat workspace-wide list. See docs/data-representation.md.
 *
 * Listing is an ordinary tree-path read; the interesting verbs are restore
 * (put it back where it was) and empty (the one sanctioned hard delete).
 */
export default async function workspaceTrashRoutes(fastify) {
  async function getWorkspaceInstance(request, reply) {
    const identifier = request.params.id;
    const userId = request.user.id;
    const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const workspaceId = isWorkspaceId ? identifier : await fastify.workspaceManager.resolveWorkspaceId(userId, identifier);

    if (!workspaceId) {
      const r = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(r.statusCode).send(r.getResponse());
      return null;
    }

    const workspace = await fastify.workspaceManager.getWorkspace(workspaceId, userId);
    if (!workspace) {
      const r = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(r.statusCode).send(r.getResponse());
      return null;
    }

    if (!workspace.isActive) {
      const r = new ResponseObject().workspaceNotActive();
      reply.code(r.statusCode).send(r.getResponse());
      return null;
    }

    return workspace;
  }

  const documentIdsBody = {
    type: 'object',
    required: ['documentIds'],
    properties: {
      documentIds: {
        type: 'array',
        items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        minItems: 1,
      },
    },
  };

  // GET /workspaces/:id/trash — documents in the trash, each with the
  // provenance a restore would use.
  fastify.get('/', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1 }, offset: { type: 'integer', minimum: 0 } },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) { return; }

      const { limit = null, offset = 0 } = request.query || {};
      const result = await workspace.listTrash({ limit, offset });
      const r = new ResponseObject().found(
        result.documents, 'Trash retrieved successfully', 200, result.count, result.totalCount,
      );
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError(error.message || 'Failed to list trash');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });

  // POST /workspaces/:id/trash/restore — re-file documents where they were.
  fastify.post('/restore', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: documentIdsBody,
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) { return; }

      const result = await workspace.restoreFromTrash(request.body.documentIds);
      const r = new ResponseObject().success(result, 'Documents restored from trash', 200, result.restored.length);
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError(error.message || 'Failed to restore from trash');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });

  // DELETE /workspaces/:id/trash — destroy everything in the trash (or the
  // given ids). The ONE place a filesystem-side delete destroys: purges the
  // index and cascades to canvas-owned stored:// blobs, never foreign
  // locations. Manual only — nothing purges the trash on a timer.
  fastify.delete('/', {
    onRequest: [fastify.authenticate],
    // No body schema: emptying the whole trash is a bodyless DELETE, and a
    // declared body schema makes Fastify reject exactly that call.
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) { return; }

      const requested = (request.body && typeof request.body === 'object' && !Array.isArray(request.body))
        ? request.body.documentIds
        : null;
      if (requested !== null && requested !== undefined && !Array.isArray(requested)) {
        const r = new ResponseObject().badRequest('documentIds must be an array');
        return reply.code(r.statusCode).send(r.getResponse());
      }

      const result = await workspace.emptyTrash({ documentIds: requested?.length ? requested : null });
      const r = new ResponseObject().success(result, 'Trash emptied', 200, result.destroyed.length);
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError(error.message || 'Failed to empty trash');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });
}
