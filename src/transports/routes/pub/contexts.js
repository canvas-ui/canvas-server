'use strict';

import ResponseObject from '../../ResponseObject.js';
import {
  extractToken,
  checkTokenAccess,
  incrementTokenUsage
} from './token-auth.js';

/**
 * Public context routes for token-based and user-based sharing
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function pubContextRoutes(fastify, options) {
  function buildAttributes(query) {
    const { allOf, noneOf, anyOf } = query;
    if (!allOf?.length && !noneOf?.length && !anyOf?.length) return undefined;
    const attrs = {};
    if (allOf?.length) attrs.allOf = allOf;
    if (noneOf?.length) attrs.noneOf = noneOf;
    if (anyOf?.length) attrs.anyOf = anyOf;
    return attrs;
  }


  /**
   * Helper function to validate user is authenticated and has an id
   * @param {Object} request - Fastify request
   * @returns {boolean} true if valid, false if not
   */
  const validateUser = (request) => {
    const user = request.user;
    return !!(user && user.id);
  };

  /**
   * Helper function to check access to a context via token or user ACL
   * @param {Object} request - Fastify request
   * @param {string} contextId - Context ID or full identifier
   * @param {string} requiredPermission - Required permission level
   * @returns {Promise<Object|null>} Access info if valid, null otherwise
   */
  const checkContextAccess = async (request, contextId, requiredPermission) => {
    try {
      // First try token access
      const token = extractToken(request);

      if (token) {
        // Find the context using the proper public API
        const contextInfo = await fastify.contextManager.findContextById(contextId);

        if (contextInfo) {
          // Load the actual context instance to get fresh ACL data
          try {
            const context = await fastify.contextManager.getContext(contextInfo.userId, contextId);
            if (context) {
              // Use fresh ACL from the loaded context instance
              const tokenAccess = checkTokenAccess(request, context.acl, requiredPermission);

              if (tokenAccess) {
                return {
                  context,
                  contextData: contextInfo.contextData,
                  accessType: 'token',
                  tokenData: tokenAccess.tokenData,
                  token: tokenAccess.token
                };
              }
            }
          } catch (error) {
            // Continue to next approach if context loading fails
          }
        }
      }

      // Try user-based access if authenticated
      if (validateUser(request)) {
        const userId = request.user.id;
        try {
          const context = await fastify.contextManager.getContext(userId, contextId);
          if (context) {
            return {
              context,
              accessType: 'user',
              userId
            };
          }
        } catch (error) {
          // Context not accessible to this user, continue
        }
      }

      return null;
    } catch (error) {
      fastify.log.error(`Error checking context access: ${error.message}`);
      return null;
    }
  };

  // Get a specific context
  fastify.get('/:contextId', {
    schema: {
      params: {
        type: 'object',
        required: ['contextId'],
        properties: {
          contextId: { type: 'string', description: "Context ID" }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { contextId } = request.params;

      const access = await checkContextAccess(request, contextId, 'documentRead');
      if (!access) {
        const response = new ResponseObject().forbidden('Access denied to context');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Increment token usage if applicable
      if (access.accessType === 'token' && access.token) {
        await incrementTokenUsage(
          access.token,
          access.context.acl,
          async (newACL) => {
            await access.context.updateACL(newACL);
          }
        );
      }

      const responseObject = new ResponseObject().found(
        access.context.toJSON(),
        'Context retrieved successfully'
      );
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());

    } catch (error) {
      fastify.log.error(`Error in GET /pub/contexts/${request.params.contextId}: ${error.message}`);
      const response = new ResponseObject().serverError('Failed to get context');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // List documents in a specific context
  fastify.get('/:contextId/documents', {
    schema: {
      params: {
        type: 'object',
        required: ['contextId'],
        properties: {
          contextId: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          allOf: { type: 'array', items: { type: 'string' }, default: [] },
          noneOf: { type: 'array', items: { type: 'string' }, default: [] },
          anyOf: { type: 'array', items: { type: 'string' }, default: [] },
          filters: { type: 'array', items: { type: 'string' } },
          includeServerContext: { type: 'boolean' },
          includeClientContext: { type: 'boolean' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          page: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { contextId } = request.params;

      const access = await checkContextAccess(request, contextId, 'documentRead');
      if (!access) {
        const response = new ResponseObject().forbidden('Access denied to context');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Increment token usage if applicable
      if (access.accessType === 'token' && access.token) {
        await incrementTokenUsage(
          access.token,
          access.context.acl,
          async (newACL) => {
            await access.context.updateACL(newACL);
          }
        );
      }

      const { filters = [], includeServerContext, includeClientContext, limit, offset, page } = request.query;
      const attributes = buildAttributes(request.query);
      const options = { includeServerContext, includeClientContext, limit, offset, page };

      const dbResult = await access.context.find(
        access.accessType === 'user' ? access.userId : access.context.userId,
        {
          attributes,
          filters,
          options,
        }
      );

      if (dbResult.error) {
        fastify.log.error(`Context error in listDocuments: ${dbResult.error}`);
        const response = new ResponseObject().serverError('Failed to list documents in context');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().found(
        dbResult,
        'Documents retrieved successfully from context',
        200,
        dbResult.count,
        dbResult.totalCount
      );
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(`Error in GET /pub/contexts/${request.params.contextId}/documents: ${error.message}`);
      const response = new ResponseObject().serverError('Failed to list documents in context');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Insert documents into a specific context
  fastify.post('/:contextId/documents', {
    schema: {
      params: {
        type: 'object',
        required: ['contextId'],
        properties: {
          contextId: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        required: ['documents'],
        properties: {
          documents: { type: 'array', minItems: 1 },
          features: { type: 'array' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { contextId } = request.params;

      const access = await checkContextAccess(request, contextId, 'documentAppend');
      if (!access) {
        const response = new ResponseObject().forbidden('Access denied to context');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (access.accessType === 'token' && access.token) {
        await incrementTokenUsage(
          access.token,
          access.context.acl,
          async (newACL) => {
            await access.context.updateACL(newACL);
          }
        );
      }

      const { documents, features = [] } = request.body;

      // Convert raw documents to proper format with schema
      const documentArray = documents.map(doc => ({
        schema: 'data/abstraction/note',
        data: doc
      }));

      const result = await access.context.putMany(
        access.accessType === 'user' ? access.userId : access.context.userId,
        documentArray,
        features
      );

      const response = new ResponseObject().created(
        result,
        'Documents inserted successfully',
        201,
        Array.isArray(result) ? result.length : undefined
      );
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(`Error in POST /pub/contexts/${request.params.contextId}/documents: ${error.message}`);

      if (error.failedItem) {
        const response = new ResponseObject().badRequest(
          `Failed to insert document at index ${error.failedIndex}: ${error.message}`,
          error.failedItem
        );
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().serverError('Failed to insert documents into context');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Update documents in a specific context
  fastify.put('/:contextId/documents', {
    schema: {
      params: {
        type: 'object',
        required: ['contextId'],
        properties: {
          contextId: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        properties: {
          documents: { type: 'array', minItems: 1 },
          features: { type: 'array' }
        },
        required: ['documents']
      }
    }
  }, async (request, reply) => {
    try {
      const { contextId } = request.params;

      const access = await checkContextAccess(request, contextId, 'documentReadWrite');
      if (!access) {
        const response = new ResponseObject().forbidden('Access denied to context');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Increment token usage if applicable
      if (access.accessType === 'token' && access.token) {
        await incrementTokenUsage(
          access.token,
          access.context.acl,
          async (newACL) => {
            await access.context.updateACL(newACL);
          }
        );
      }

      const { documents, features = [] } = request.body;
      if (!Array.isArray(documents) || documents.length === 0) {
        const response = new ResponseObject().badRequest('Request body must contain a non-empty array of documents to update.');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const result = await access.context.putMany(
        access.accessType === 'user' ? access.userId : access.context.userId,
        documents,
        features
      );

      const response = new ResponseObject().success(result, 'Documents updated successfully in context');
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(`Error in PUT /pub/contexts/${request.params.contextId}/documents: ${error.message}`);

      if (error.failedItem) {
        const response = new ResponseObject().badRequest(
          `Failed to update document at index ${error.failedIndex}: ${error.message}`,
          error.failedItem
        );
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().serverError('Failed to update documents in context');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
