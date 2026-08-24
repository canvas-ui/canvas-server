'use strict';

import ResponseObject from '../../ResponseObject.js';

// Raw-bytes upload scoped to a context: persists into the backing workspace's
// blob store (workspace:data), returning a stored://workspace:data/<key>
// location. Symmetric to /workspaces/:id/blobs — "uploading to a context" =
// store bytes in its workspace, then link the File doc into the context path
// via the normal documents POST.
//
// Goes through Context.persistBlob, not the workspace directly: writing bytes
// is a write, and it answers to the same ACL the documents route does.

const BLOB_BODY_LIMIT = 21474836480; // 20 GiB — streamed to disk, never buffered

export default async function contextBlobRoutes(fastify) {
  fastify.addContentTypeParser(
    'application/octet-stream',
    { bodyLimit: BLOB_BODY_LIMIT },
    (_req, payload, done) => done(null, payload),
  );

  // POST /contexts/:id/blobs  (body: raw bytes, Content-Type: application/octet-stream)
  fastify.post('/', {
    onRequest: [fastify.authenticateClient],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (request, reply) => {
    const context = await fastify.contextManager.getContext(request.user.id, request.params.id);
    if (!context) {
      const r = new ResponseObject().notFound(`Context with ID ${request.params.id} not found`);
      return reply.code(r.statusCode).send(r.getResponse());
    }
    const body = request.body;
    if (!body) {
      const r = new ResponseObject().badRequest('Empty body. Send bytes as application/octet-stream.');
      return reply.code(r.statusCode).send(r.getResponse());
    }

    try {
      const result = await context.persistBlob(request.user.id, body);
      const r = new ResponseObject().created(result, 'Blob stored');
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      // Missing permission and a stopped workspace are different answers — the
      // caller can do something about the second one.
      if (error.code === 'ACCESS_DENIED') {
        const r = new ResponseObject().forbidden(error.message);
        return reply.code(r.statusCode).send(r.getResponse());
      }
      if (error.code === 'WORKSPACE_NOT_READY') {
        const r = new ResponseObject().workspaceNotActive();
        return reply.code(r.statusCode).send(r.getResponse());
      }
      fastify.log.error(error);
      const r = new ResponseObject().serverError(error.message || 'Failed to store blob');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });
}
