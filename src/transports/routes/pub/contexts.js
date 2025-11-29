'use strict';

import ResponseObject from '../../ResponseObject.js';
import validator from 'validator';
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
   * Helper function to validate user and send response if invalid
   * @param {Object} request - Fastify request
   * @param {Object} reply - Fastify reply
   * @returns {boolean} true if valid, false if not
   */
  const validateUserWithResponse = (request, reply) => {
    if (!validateUser(request)) {
      const response = new ResponseObject().unauthorized('Valid authentication required');
      reply.code(response.statusCode).send(response.getResponse());
      return false;
    }
    return true;
  };

  /**
   * Helper function to check if targetUserId is an email and redirect to user ID if needed
   * @param {Object} request - Fastify request
   * @param {Object} reply - Fastify reply
   * @param {string} targetUserId - The targetUserId parameter from the route
   * @returns {Promise<string|null>} The resolved user ID if email was found, null if not an email or user not found
   */
  const resolveUserIdFromEmail = async (request, reply, targetUserId) => {
    // Check if targetUserId looks like an email
    if (!validator.isEmail(targetUserId)) {
      return null; // Not an email, return null to continue with original targetUserId
    }

    try {
      // Try to find user by email
      const user = await fastify.userManager.getUserByEmail(targetUserId);
      if (user && user.id) {
        // Redirect to the user ID-based URL
        const originalUrl = request.url;
        const newUrl = originalUrl.replace(`/${targetUserId}/`, `/${user.id}/`);

        fastify.log.info(`Redirecting email-based URL to user ID: ${originalUrl} -> ${newUrl}`);
        return reply.redirect(301, newUrl);
      }
    } catch (error) {
      // User not found by email, continue with original targetUserId
      fastify.log.debug(`User not found by email: ${targetUserId}`);
    }

    return null; // No redirect needed
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
      },
      querystring: {
        type: 'object',
        properties: {
          token: { type: 'string', description: "Access token" }
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
          token: { type: 'string' },
          featureArray: { type: 'array', items: { type: 'string' } },
          filterArray: { type: 'array', items: { type: 'string' } },
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

      const { featureArray = [], filterArray = [], includeServerContext, includeClientContext, limit, offset, page } = request.query;
      const options = { includeServerContext, includeClientContext, limit, offset, page };

      const dbResult = await access.context.listDocuments(
        access.accessType === 'user' ? access.userId : access.context.userId,
        featureArray,
        filterArray,
        options
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
      querystring: {
        type: 'object',
        properties: {
          token: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        required: ['documents'],
        properties: {
          documents: { type: 'array', minItems: 1 },
          featureArray: { type: 'array' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { contextId } = request.params;

      const access = await checkContextAccess(request, contextId, 'documentWrite');
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

      const { documents, featureArray = [] } = request.body;

      // Convert raw documents to proper format with schema
      const documentArray = documents.map(doc => ({
        schema: 'data/abstraction/note',
        data: doc
      }));

      const result = await access.context.insertDocumentArray(
        access.accessType === 'user' ? access.userId : access.context.userId,
        documentArray,
        featureArray
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
      querystring: {
        type: 'object',
        properties: {
          token: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        properties: {
          documents: { type: 'array', minItems: 1 },
          featureArray: { type: 'array' }
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

      const { documents, featureArray = [] } = request.body;
      if (!Array.isArray(documents) || documents.length === 0) {
        const response = new ResponseObject().badRequest('Request body must contain a non-empty array of documents to update.');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const result = await access.context.updateDocumentArray(
        access.accessType === 'user' ? access.userId : access.context.userId,
        documents,
        featureArray
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

  // ============================================================================
  // LEGACY ROUTES (For backward compatibility with user-based sharing)
  // ============================================================================

  // Legacy context routes with targetUserId parameter
  fastify.get('/:targetUserId/contexts/:contextId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['targetUserId', 'contextId'],
        properties: {
          targetUserId: { type: 'string', description: "The user ID of the context owner" },
          contextId: { type: 'string', description: "The ID of the context" }
        }
      }
    }
  }, async (request, reply) => {
    if (!validateUserWithResponse(request, reply)) {
      return;
    }

    // Check if targetUserId is an email and redirect if needed
    const redirectResult = await resolveUserIdFromEmail(request, reply, request.params.targetUserId);
    if (redirectResult) {
      return redirectResult; // Redirect has been sent
    }

    try {
      const accessingUserId = request.user.id;
      const ownerUserId = request.params.targetUserId;
      const contextId = request.params.contextId;
      const fullContextIdentifier = `${ownerUserId}/${contextId}`;

      const context = await fastify.contextManager.getContext(accessingUserId, fullContextIdentifier);

      if (!context) {
        const response = new ResponseObject().notFound(`Context '${fullContextIdentifier}' not found or not accessible by user '${accessingUserId}'.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const responseObject = new ResponseObject().found(
        context.toJSON(),
        'Context retrieved successfully'
      );
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Error in GET /users/${request.params.targetUserId}/contexts/${request.params.contextId}: ${error.message}`);
      if (error.message.startsWith('Access denied')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (error.message.includes('not found for user')) {
        const response = new ResponseObject().notFound(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().serverError('Failed to get context');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Grant access to a context (share) - Legacy route
  fastify.post('/:ownerUserId/contexts/:contextId/shares', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['ownerUserId', 'contextId'],
        properties: {
          ownerUserId: { type: 'string', description: "The user ID of the context owner (must be the authenticated user)" },
          contextId: { type: 'string', description: "The ID of the context to share" }
        }
      },
      body: {
        type: 'object',
        required: ['sharedWithUserId', 'accessLevel'],
        properties: {
          sharedWithUserId: { type: 'string', description: "User ID to share the context with" },
          accessLevel: { type: 'string', enum: ['documentRead', 'documentWrite', 'documentReadWrite'], description: "Access level to grant" }
        }
      }
    }
  }, async (request, reply) => {
    if (!validateUserWithResponse(request, reply)) {
      return;
    }

    // Check if ownerUserId is an email and redirect if needed
    const redirectResult = await resolveUserIdFromEmail(request, reply, request.params.ownerUserId);
    if (redirectResult) {
      return redirectResult; // Redirect has been sent
    }

    const requestingUserId = request.user.id;
    const ownerUserIdFromParams = request.params.ownerUserId;
    const contextId = request.params.contextId;
    const { sharedWithUserId, accessLevel } = request.body;

    if (requestingUserId !== ownerUserIdFromParams) {
      const response = new ResponseObject().forbidden('You can only share contexts that you own.');
      return reply.code(response.statusCode).send(response.getResponse());
    }

    try {
      const targetContextIdentifier = `${ownerUserIdFromParams}/${contextId}`;
      await fastify.contextManager.grantContextAccess(requestingUserId, targetContextIdentifier, sharedWithUserId, accessLevel);

      const response = new ResponseObject().success(
        { message: `Context '${targetContextIdentifier}' shared with '${sharedWithUserId}' at level '${accessLevel}'.` },
        'Context shared successfully'
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Error in POST /users/${ownerUserIdFromParams}/contexts/${contextId}/shares: ${error.message}`);
      if (error.message.startsWith('Access denied') || error.message.includes('not the owner')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (error.message.includes('not found')) {
        const response = new ResponseObject().notFound(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().serverError('Failed to share context', error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Revoke access to a context (unshare) - Legacy route
  fastify.delete('/:ownerUserId/contexts/:contextId/shares/:sharedWithUserId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['ownerUserId', 'contextId', 'sharedWithUserId'],
        properties: {
          ownerUserId: { type: 'string', description: "The user ID of the context owner (must be the authenticated user)" },
          contextId: { type: 'string', description: "The ID of the context" },
          sharedWithUserId: { type: 'string', description: "User ID whose access should be revoked" }
        }
      }
    }
  }, async (request, reply) => {
    if (!validateUserWithResponse(request, reply)) {
      return;
    }

    // Check if ownerUserId is an email and redirect if needed
    const redirectResult = await resolveUserIdFromEmail(request, reply, request.params.ownerUserId);
    if (redirectResult) {
      return redirectResult; // Redirect has been sent
    }

    const requestingUserId = request.user.id;
    const ownerUserIdFromParams = request.params.ownerUserId;
    const contextId = request.params.contextId;
    const sharedWithUserIdFromParams = request.params.sharedWithUserId;

    if (requestingUserId !== ownerUserIdFromParams) {
      const response = new ResponseObject().forbidden('You can only manage shares for contexts that you own.');
      return reply.code(response.statusCode).send(response.getResponse());
    }

    try {
      const targetContextIdentifier = `${ownerUserIdFromParams}/${contextId}`;
      await fastify.contextManager.revokeContextAccess(requestingUserId, targetContextIdentifier, sharedWithUserIdFromParams);

      const response = new ResponseObject().success(
        { message: `Access for '${sharedWithUserIdFromParams}' to context '${targetContextIdentifier}' has been revoked.` },
        'Context share revoked successfully'
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Error in DELETE /users/${ownerUserIdFromParams}/contexts/${contextId}/shares/${sharedWithUserIdFromParams}: ${error.message}`);
       if (error.message.startsWith('Access denied') || error.message.includes('not the owner')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (error.message.includes('not found')) {
        const response = new ResponseObject().notFound(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().serverError('Failed to revoke context share', error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
