'use strict';

import ResponseObject from '../../ResponseObject.js';
import {
  extractToken,
  checkTokenAccess,
  incrementTokenUsage
} from './token-auth.js';

/**
 * Public workspace routes for token-based sharing
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function pubWorkspaceRoutes(fastify, options) {

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
   * Helper function to check access to a workspace via token or user ACL
   * @param {Object} request - Fastify request
   * @param {string} workspaceId - Workspace ID
   * @param {string} requiredPermission - Required permission level
   * @returns {Promise<Object|null>} Access info if valid, null otherwise
   */
  const checkWorkspaceAccess = async (request, workspaceId, requiredPermission) => {
    try {
      // First try token access
      const token = extractToken(request);
      if (token) {
        // Find workspace by searching all workspaces for this token
        const allWorkspaces = fastify.workspaceManager.getAllWorkspacesWithKeys();

        for (const [indexKey, workspaceEntry] of Object.entries(allWorkspaces)) {
          const isMatch = (workspaceEntry.id === workspaceId) || (workspaceEntry.name === workspaceId);
          if (isMatch) {
            const tokenAccess = checkTokenAccess(request, workspaceEntry.acl, requiredPermission);
            if (tokenAccess) {
              // Load the actual workspace instance
              const workspace = await fastify.workspaceManager.getWorkspaceById(workspaceEntry.id);
              if (workspace) {
                return {
                  workspace,
                  workspaceEntry,
                  accessType: 'token',
                  tokenData: tokenAccess.tokenData,
                  token: tokenAccess.token
                };
              }
            }
          }
        }
      }

      // Try user-based access if authenticated
      if (validateUser(request)) {
        const userId = request.user.id;
        const workspace = await fastify.workspaceManager.getWorkspaceById(workspaceId, userId);
        if (workspace) {
          return {
            workspace,
            accessType: 'user',
            userId
          };
        }
      }

      return null;
    } catch (error) {
      fastify.log.error(`Error checking workspace access: ${error.message}`);
      return null;
    }
  };

  // Get workspace information
  fastify.get('/:workspaceId', {
    schema: {
      params: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string', description: "Workspace ID" }
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
      const { workspaceId } = request.params;

      const access = await checkWorkspaceAccess(request, workspaceId, 'read');
      if (!access) {
        const response = new ResponseObject().forbidden('Access denied to workspace');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Increment token usage if applicable
      if (access.accessType === 'token' && access.token) {
        await incrementTokenUsage(
          access.token,
          access.workspace.acl,
          async (newACL) => {
            await fastify.workspaceManager.updateWorkspaceConfig(
              access.workspace.owner,
              access.workspace.id,
              access.workspace.owner,
              { acl: newACL }
            );
          }
        );
      }

      const responseObject = new ResponseObject().found(
        access.workspace.toJSON(),
        'Workspace retrieved successfully'
      );
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());

    } catch (error) {
      fastify.log.error(`Error in GET /pub/workspaces/${request.params.workspaceId}: ${error.message}`);
      const response = new ResponseObject().serverError('Failed to get workspace');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get workspace documents
  fastify.get('/:workspaceId/documents', {
    schema: {
      params: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          page: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { workspaceId } = request.params;

      const access = await checkWorkspaceAccess(request, workspaceId, 'read');
      if (!access) {
        const response = new ResponseObject().forbidden('Access denied to workspace');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Increment token usage if applicable
      if (access.accessType === 'token' && access.token) {
        await incrementTokenUsage(
          access.token,
          access.workspace.acl,
          async (newACL) => {
            await fastify.workspaceManager.updateWorkspaceConfig(
              access.workspace.owner,
              access.workspace.id,
              access.workspace.owner,
              { acl: newACL }
            );
          }
        );
      }

      const { limit, offset, page } = request.query;
      const options = { limit, offset, page };

      // Use workspace's document listing capability
      const dbResult = await access.workspace.listDocuments(
        access.accessType === 'user' ? access.userId : access.workspace.owner,
        [], // featureArray
        [], // filterArray
        options
      );

      if (dbResult.error) {
        fastify.log.error(`Workspace error in listDocuments: ${dbResult.error}`);
        const response = new ResponseObject().serverError('Failed to list documents in workspace');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().found(
        dbResult,
        'Documents retrieved successfully from workspace',
        200,
        dbResult.count,
        dbResult.totalCount
      );
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(`Error in GET /pub/workspaces/${request.params.workspaceId}/documents: ${error.message}`);
      const response = new ResponseObject().serverError('Failed to list documents in workspace');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Insert documents into workspace
  fastify.post('/:workspaceId/documents', {
    schema: {
      params: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string' }
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
      const { workspaceId } = request.params;

      const access = await checkWorkspaceAccess(request, workspaceId, 'write');
      if (!access) {
        const response = new ResponseObject().forbidden('Access denied to workspace');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Increment token usage if applicable
      if (access.accessType === 'token' && access.token) {
        await incrementTokenUsage(
          access.token,
          access.workspace.acl,
          async (newACL) => {
            await fastify.workspaceManager.updateWorkspaceConfig(
              access.workspace.owner,
              access.workspace.id,
              access.workspace.owner,
              { acl: newACL }
            );
          }
        );
      }

      const { documents, featureArray = [] } = request.body;

      // Convert raw documents to proper format with schema
      const documentArray = documents.map(doc => ({
        schema: 'data/abstraction/note',
        data: doc
      }));

      const result = await access.workspace.insertDocumentArray(
        documentArray,
        '/', // contextSpec - use root context
        featureArray
      );

      const response = new ResponseObject().created(
        result,
        'Documents inserted successfully into workspace',
        201,
        Array.isArray(result) ? result.length : undefined
      );
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(`Error in POST /pub/workspaces/${request.params.workspaceId}/documents: ${error.message}`);

      if (error.failedItem) {
        const response = new ResponseObject().badRequest(
          `Failed to insert document at index ${error.failedIndex}: ${error.message}`,
          error.failedItem
        );
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().serverError('Failed to insert documents into workspace');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get workspace tree
  fastify.get('/:workspaceId/tree', {
    schema: {
      params: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          path: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { workspaceId } = request.params;

      const access = await checkWorkspaceAccess(request, workspaceId, 'read');
      if (!access) {
        const response = new ResponseObject().forbidden('Access denied to workspace');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Increment token usage if applicable
      if (access.accessType === 'token' && access.token) {
        await incrementTokenUsage(
          access.token,
          access.workspace.acl,
          async (newACL) => {
            await fastify.workspaceManager.updateWorkspaceConfig(
              access.workspace.owner,
              access.workspace.id,
              access.workspace.owner,
              { acl: newACL }
            );
          }
        );
      }

      const { path = '/' } = request.query;

      // Use workspace's tree listing capability
      const tree = await access.workspace.listTree(path);

      const response = new ResponseObject().found(
        tree,
        'Workspace tree retrieved successfully'
      );
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(`Error in GET /pub/workspaces/${request.params.workspaceId}/tree: ${error.message}`);
      const response = new ResponseObject().serverError('Failed to get workspace tree');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
