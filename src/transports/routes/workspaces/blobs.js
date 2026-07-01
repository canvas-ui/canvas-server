'use strict';

import ResponseObject from '../../ResponseObject.js';

// Raw-bytes upload into the workspace blob store (workspace:data). Two-step
// ingest: client POSTs bytes here → gets a stored://workspace:data/<key> URL,
// then POSTs a normal File document referencing that URL via /documents. The
// bytes become server-resident and therefore embeddable (unlike `ws add`, which
// only records a device file:// pointer).

const BLOB_BODY_LIMIT = 1073741824; // 1 GiB (matches server bodyLimit)

export default async function blobRoutes(fastify) {
  // Scoped to this plugin: parse binary bodies as a Buffer. Does not touch the
  // JSON parser used by sibling routes (application/json is unaffected).
  fastify.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: BLOB_BODY_LIMIT },
    (_req, body, done) => done(null, body),
  );

  async function getWorkspaceInstance(request, reply) {
    const identifier = request.params.id;
    const userId = request.user.id;
    const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const workspaceId = isWorkspaceId ? identifier : await fastify.workspaceManager.resolveWorkspaceId(userId, identifier);
    const workspace = workspaceId ? await fastify.workspaceManager.getWorkspace(workspaceId, userId) : null;
    if (!workspace) {
      const r = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(r.statusCode).send(r.getResponse());
      return null;
    }
    if (!workspace.isActive) {
      const r = new ResponseObject().badRequest('Workspace is not active. Start the workspace first.');
      reply.code(r.statusCode).send(r.getResponse());
      return null;
    }
    return workspace;
  }

  // POST /workspaces/:id/blobs  (body: raw bytes, Content-Type: application/octet-stream)
  fastify.post('/', {
    onRequest: [fastify.authenticateClient],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, async (request, reply) => {
    const workspace = await getWorkspaceInstance(request, reply);
    if (!workspace) { return; }

    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      const r = new ResponseObject().badRequest('Empty or non-binary body. Send bytes as application/octet-stream.');
      return reply.code(r.statusCode).send(r.getResponse());
    }

    try {
      const result = await workspace.persistBlob(body);
      const r = new ResponseObject().created(result, 'Blob stored');
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError(error.message || 'Failed to store blob');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });
}
