'use strict';

import ResponseObject from '../ResponseObject.js';
import schemaRegistry from '../../services/synapsd/src/schemas/SchemaRegistry.js';

/**
 * Schema routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function schemaRoutes(fastify, options) {
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

  // List schemas by abstraction type
  fastify.get('/data/abstraction/:abstraction', {
    schema: {
      params: {
        type: 'object',
        required: ['abstraction'],
        properties: {
          abstraction: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const schemas = schemaRegistry.getSchema(`data/abstraction/${request.params.abstraction}`);
      const response = new ResponseObject().found(schemas, 'Schemas retrieved successfully', 200, schemas.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list schemas');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get JSON schema for a specific abstraction
  fastify.get('/data/abstraction/:abstraction.json', {
    schema: {
      params: {
        type: 'object',
        required: ['abstraction'],
        properties: {
          abstraction: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const schemaId = `data/abstraction/${request.params.abstraction}`;
      if (!schemaRegistry.hasSchema(schemaId)) {
        const response = new ResponseObject().notFound(`Schema not found: ${schemaId}`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const jsonSchema = schemaRegistry.getJsonSchema(schemaId);
      const response = new ResponseObject().found(jsonSchema, 'JSON schema retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to get JSON schema');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
