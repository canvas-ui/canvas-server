'use strict';

import ResponseObject from '../ResponseObject.js';
import schemaRegistry from 'canvas-synapsd/src/schemas/SchemaRegistry.js';

/**
 * Schema routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function schemaRoutes(fastify, _options) {
  // List all data schemas
  fastify.get('/', {
  }, async (request, reply) => {
    try {
      const schemas = schemaRegistry.listSchemas('data');
      const response = new ResponseObject().found(schemas, 'Schemas retrieved successfully', 200, schemas.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list schemas');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Schema descriptor / JSON Schema for one id. A splat, not a named param:
  // schema ids are hierarchical (`data/schema/message/email` spans two
  // segments, which `:param` cannot match). `<id>.json` serves the derived
  // JSON Schema; the bare id serves the registration descriptor — the old
  // handler returned the CLASS, which JSON-serializes to `{}`.
  fastify.get('/data/schema/*', {
    schema: {
      params: {
        type: 'object',
        required: ['*'],
        properties: {
          '*': { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const splat = request.params['*'] || '';
      const wantsJson = splat.endsWith('.json');
      const tail = wantsJson ? splat.slice(0, -'.json'.length) : splat;
      // A derived subtype bitmap key (data/schema/application/flatpak) is not a
      // registered id — answer with its nearest registered ancestor rather than
      // a 404, so bitmap-derived links stay resolvable.
      const requestedId = `data/schema/${tail}`;
      const schemaId = schemaRegistry.hasSchema(requestedId)
        ? requestedId
        : schemaRegistry.resolveSchemaId(requestedId);

      if (!schemaId) {
        const response = new ResponseObject().notFound(`Schema not found: ${requestedId}`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const payload = wantsJson
        ? schemaRegistry.getJsonSchema(schemaId)
        : schemaRegistry.getSchemaDescriptor(schemaId);
      const message = wantsJson ? 'JSON schema retrieved successfully' : 'Schema retrieved successfully';
      const response = new ResponseObject().found(payload, message);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to get schema');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
