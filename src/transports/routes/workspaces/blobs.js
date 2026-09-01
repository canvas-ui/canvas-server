'use strict';

import ResponseObject from '../../ResponseObject.js';

// Raw-bytes upload into the workspace blob store (workspace:data). Two-step
// ingest: client POSTs bytes here → gets a stored://workspace:data/<key> URL,
// then POSTs a normal File document referencing that URL via /documents. The
// bytes become server-resident and therefore inferdable (unlike `ws add`, which
// only records a device file:// pointer).

const BLOB_BODY_LIMIT = 21474836480; // 20 GiB — streamed to disk, never buffered in RAM

export default async function blobRoutes(fastify) {
  // Scoped to this plugin: hand the RAW request stream to the handler (no
  // buffering) so large blobs stream straight through stored → cacache/temp file
  // without ever materializing in memory. Mirrors the webdav upload parser.
  // application/json on sibling routes is unaffected.
  fastify.addContentTypeParser(
    'application/octet-stream',
    { bodyLimit: BLOB_BODY_LIMIT },
    (_req, payload, done) => done(null, payload),
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
      const r = new ResponseObject().workspaceNotActive();
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
    if (!workspace) { return reply; }

    // request.body is the raw Readable stream (or a Buffer for tiny bodies).
    const body = request.body;
    if (!body) {
      const r = new ResponseObject().badRequest('Empty body. Send bytes as application/octet-stream.');
      return reply.code(r.statusCode).send(r.getResponse());
    }

    try {
      // stored streams a Readable to a temp file + cacache (hash-on-the-fly);
      // a Buffer is hashed in memory. Either way persistBlob returns the location.
      const result = await workspace.persistBlob(body);
      const r = new ResponseObject().created(result, 'Blob stored');
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError(error.message || 'Failed to store blob');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });

  // POST /workspaces/:id/blobs/exists  (body: { checksums: ["<sha256 hex>", ...] })
  // Batch existence check against the content-addressed store, so clients can
  // hash locally and skip re-sending bytes the workspace already holds
  // (resumable multi-file uploads). Payload maps each requested checksum to
  // the persistBlob-shaped result, or null when the bytes are absent.
  fastify.post('/exists', {
    onRequest: [fastify.authenticateClient],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['checksums'],
        properties: {
          checksums: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            items: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const workspace = await getWorkspaceInstance(request, reply);
    if (!workspace) { return reply; }

    try {
      const result = {};
      for (const checksum of new Set(request.body.checksums)) {
        result[checksum] = await workspace.statBlobByChecksum(checksum);
      }
      const r = new ResponseObject().found(result, 'Blob existence checked');
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError(error.message || 'Failed to check blobs');
      return reply.code(r.statusCode).send(r.getResponse());
    }
  });
}
