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
export default async function pubWorkspaceRoutes(fastify, _options) {

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
  const checkWorkspaceAccess = async (request, workspaceIdentifier, requiredPermission) => {
    try {
      // First try token access
      const token = extractToken(request);
      if (token) {
        // Find workspace by searching all workspaces for this token
        const allWorkspaces = await fastify.workspaceManager.listWorkspaces();

        for (const workspaceEntry of allWorkspaces) {
          const isMatch = (workspaceEntry.id === workspaceIdentifier) || (workspaceEntry.name === workspaceIdentifier);
          if (isMatch) {
            const tokenAccess = checkTokenAccess(request, workspaceEntry.acl, requiredPermission);
            if (tokenAccess) {
              // Load the actual workspace instance
              const workspace = await fastify.workspaceManager.getWorkspace(workspaceEntry.id, workspaceEntry.owner);
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
        const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceIdentifier);
        const resolvedId = isWorkspaceId ? workspaceIdentifier : fastify.workspaceManager.resolveWorkspaceId(userId, workspaceIdentifier);
        if (!resolvedId) return null;

        // getWorkspaceOrThrow distinguishes "not found" / "access denied"
        // (fall through → null → 403) from "not ready" (503, retryable), which
        // must not be masked as a blanket access-denied.
        let workspace;
        try {
          workspace = await fastify.workspaceManager.getWorkspaceOrThrow(resolvedId, userId);
        } catch (err) {
          if (err?.statusCode === 503) throw err;
          workspace = null;
        }
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
      // Let a transient "workspace not ready" bubble up so the route can
      // return 503 instead of a misleading 403.
      if (error?.statusCode === 503) throw error;
      fastify.log.error(`Error checking workspace access: ${error.message}`);
      return null;
    }
  };

  // Start workspace
  fastify.post('/:workspaceId/start', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string', description: "Workspace ID or name" }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { workspaceId } = request.params;
      const userId = request.user.id;

      const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId);
      const resolvedId = isWorkspaceId ? workspaceId : fastify.workspaceManager.resolveWorkspaceId(userId, workspaceId);

      if (!resolvedId) {
        const response = new ResponseObject().notFound('Workspace not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await fastify.workspaceManager.startWorkspace(resolvedId, userId);
      const workspace = await fastify.workspaceManager.getWorkspace(resolvedId, userId);

      const responseObject = new ResponseObject().success(workspace.toJSON(), 'Workspace started successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Error starting workspace: ${error.message}`);
      const response = new ResponseObject().serverError(`Failed to start workspace: ${error.message}`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Stop workspace
  fastify.post('/:workspaceId/stop', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string', description: "Workspace ID or name" }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { workspaceId } = request.params;
      const userId = request.user.id;

      const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId);
      const resolvedId = isWorkspaceId ? workspaceId : fastify.workspaceManager.resolveWorkspaceId(userId, workspaceId);

      if (!resolvedId) {
        const response = new ResponseObject().notFound('Workspace not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await fastify.workspaceManager.stopWorkspace(resolvedId, userId);
      const workspace = await fastify.workspaceManager.getWorkspace(resolvedId, userId);

      const responseObject = new ResponseObject().success(workspace.toJSON(), 'Workspace stopped successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Error stopping workspace: ${error.message}`);
      const response = new ResponseObject().serverError(`Failed to stop workspace: ${error.message}`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get workspace information
  fastify.get('/:workspaceId', {
    schema: {
      params: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string', description: "Workspace ID" }
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
      const response = ResponseObject.fromError(error, 'Failed to get workspace');
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
          treeNameOrTreeId: { type: 'string' },
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

      const { limit, offset, page, treeNameOrTreeId = null } = request.query;
      const options = { limit, offset, page };

      // Use workspace's document listing capability
      const dbResult = await access.workspace.list({
        context: access.workspace.getContextTreeSelector('/', treeNameOrTreeId),
        attributes: { allOf: [] },
        filters: [],
        ...options,
      });

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
      const response = ResponseObject.fromError(error, 'Failed to list documents in workspace');
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
      body: {
        type: 'object',
        required: ['documents'],
        properties: {
          documents: { type: 'array', minItems: 1 },
          features: { type: 'array' },
          treeNameOrTreeId: { type: 'string' }
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

      const { documents, features = [], treeNameOrTreeId = null } = request.body;

      const documentArray = documents.map(doc => ({
        schema: 'data/schema/note',
        data: doc,
      }));

      const result = await access.workspace.putMany(documentArray, {
        context: access.workspace.getContextTreeSelector('/', treeNameOrTreeId),
        features,
      });

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

      const response = ResponseObject.fromError(error, 'Failed to insert documents into workspace');
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

      const tree = access.workspace.getDefaultContextTree().buildJsonTree();

      const response = new ResponseObject().found(
        tree,
        'Workspace tree retrieved successfully'
      );
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(`Error in GET /pub/workspaces/${request.params.workspaceId}/tree: ${error.message}`);
      const response = ResponseObject.fromError(error, 'Failed to get workspace tree');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
