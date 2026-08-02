'use strict';

import ResponseObject from '../../ResponseObject.js';
import { validateUser } from '../../auth/strategies.js';
import { stripDeviceFeatureTags } from '../../../utils/device-features.js';

/**
 * Context Dotfile routes handler for the API
 * Provides CRUD operations for dotfile documents (schema: data/abstraction/dotfile)
 * at route prefix /contexts/:id/dotfiles
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function contextDotfileRoutes(fastify, options) {
  function buildAttributes(query) {
    const { allOf, noneOf, anyOf } = query;
    if (!allOf?.length && !noneOf?.length && !anyOf?.length) return undefined;
    const attrs = {};
    if (allOf?.length) attrs.allOf = allOf;
    if (noneOf?.length) attrs.noneOf = noneOf;
    if (anyOf?.length) attrs.anyOf = anyOf;
    return attrs;
  }


  // Ensure user is authenticated & basic validation for every request in this plugin
  fastify.addHook('preHandler', async (request, reply) => {
    try {
      validateUser(request.user, ['id']);
    } catch (err) {
      const response = new ResponseObject().unauthorized(err.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * List dotfile documents within the context
   * GET /contexts/:id/dotfiles
   */
  fastify.get('/', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          allOf: { type: 'array', items: { type: 'string' }, default: [] },
          noneOf: { type: 'array', items: { type: 'string' }, default: [] },
          anyOf: { type: 'array', items: { type: 'string' }, default: [] },
          filters: { type: 'array', items: { type: 'string' }, default: [] },
          includeServerContext: { type: 'boolean' },
          includeClientContext: { type: 'boolean' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          page: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    const contextId = request.params.id;
    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const attrs = buildAttributes(request.query) || {};
      const allOf = ['data/abstraction/dotfile', ...(attrs.allOf || [])];

      const dbResult = await context.list(request.user.id, {
        attributes: { ...attrs, allOf },
        filters: request.query.filters || [],
        options: {
          includeServerContext: request.query.includeServerContext,
          includeClientContext: request.query.includeClientContext,
          limit: request.query.limit,
          offset: request.query.offset,
          page: request.query.page,
          parse: true,
        },
      });

      if (dbResult.error) {
        fastify.log.error(`SynapsD error in listDocuments: ${dbResult.error}`);
        const response = new ResponseObject().error('Failed to list dotfiles due to a database error.', dbResult.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success(dbResult, 'Dotfiles retrieved successfully', 200, dbResult.count);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to list dotfiles');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Create dotfile documents
   * POST /contexts/:id/dotfiles
   */
  fastify.post('/', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['dotfiles'],
        properties: {
              features: { type: 'array', items: { type: 'string' }, default: [] },
          dotfiles: {
            oneOf: [
              { type: 'object' },
              { type: 'array', items: { type: 'object' } }
            ]
          }
        }
      }
    }
  }, async (request, reply) => {
    const contextId = request.params.id;
    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const dotfilesInput = request.body.dotfiles;
      const dotfileArray = Array.isArray(dotfilesInput) ? dotfilesInput : [dotfilesInput];
      const documentArray = dotfileArray.map(df => ({
        schema: 'data/abstraction/dotfile',
        data: df
      }));

      const result = await context.putMany(request.user.id, documentArray, ['data/abstraction/dotfile', ...stripDeviceFeatureTags(request.body.features || [])]);

      const response = new ResponseObject().created(result, 'Dotfiles inserted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to insert dotfiles');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Update dotfile documents
   * PUT /contexts/:id/dotfiles
   */
  fastify.put('/', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['documents'],
        properties: {
          documents: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id'],
              properties: {
                id: { type: 'string' }
              }
            }
          },
          features: { type: 'array', items: { type: 'string' }, default: [] }
        }
      }
    }
  }, async (request, reply) => {
    const contextId = request.params.id;
    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const result = await context.putMany(request.user.id, request.body.documents, ['data/abstraction/dotfile', ...stripDeviceFeatureTags(request.body.features || [])]);
      const response = new ResponseObject().updated(result, 'Dotfiles updated successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to update dotfiles');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Delete dotfile documents
   * DELETE /contexts/:id/dotfiles
   */
  fastify.delete('/', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'array',
        items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        minItems: 1
      }
    }
  }, async (request, reply) => {
    const contextId = request.params.id;
    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const docIds = Array.isArray(request.body) ? request.body : [request.body];
      const success = await context.deleteMany(request.user.id, docIds);

      const response = success ?
        new ResponseObject().deleted(null, 'Dotfiles deleted successfully') :
        new ResponseObject().badRequest('Failed to delete dotfiles');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to delete dotfiles');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
