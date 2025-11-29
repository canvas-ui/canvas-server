'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite, requireWorkspaceAdmin } from '../../middleware/workspace-acl.js';
import { validateUser } from '../../auth/strategies.js';
import { resolveWorkspaceAddress } from '../../middleware/address-resolver.js';

/**
 * Main workspace routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceRoutes(fastify, options) {
  /**
   * Helper function to validate user is authenticated and has an email
   * @param {Object} request - Fastify request
   * @returns {boolean} true if valid, false if not
   */
  const validateUserWithResponse = (request, reply) => {
    if (!validateUser(request.user, ['id', 'email'])) {
        const response = new ResponseObject().unauthorized('Valid authentication required');
        reply.code(response.statusCode).send(response.getResponse());
        return false;
    }
    return true;
  };

  // Register sub-routes
  fastify.register(import('./documents.js'), {
    prefix: '/:id/documents',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./tree.js'), {
    prefix: '/:id/tree',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./lifecycle.js'), {
    prefix: '/:id',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./tokens.js'), {
    prefix: '/:id/tokens',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./shares.js'), {
    prefix: '/',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./dotfiles.js'), {
    prefix: '/:id/dotfiles',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./layers.js'), {
    prefix: '/:id/layers',
    onRequest: [resolveWorkspaceAddress]
  });

  // List all workspaces
  fastify.get('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {

    try {
      // Validate user is authenticated properly
      if (!validateUser(request.user, ['id', 'email'])) {
        const response = new ResponseObject().unauthorized('Valid authentication required');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspaces = await fastify.workspaceManager.listUserWorkspaces(request.user.id);

      // Return consistent ResponseObject format
      const response = new ResponseObject();
      return reply.code(200).send(response.found(workspaces, 'Workspaces retrieved successfully', 200, workspaces.length).getResponse());

    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list workspaces');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Create new workspace
  fastify.post('/', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string' },
          color: { type: 'string', pattern: '^#[0-9A-Fa-f]{3,6}$' },
          type: { type: 'string', enum: ['workspace', 'universe'] },
          metadata: { type: 'object' },
          acl: { type: 'object' },
          restApi: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    if (!validateUserWithResponse(request, reply)) {
        return;
    }
    try {
      const workspace = await fastify.workspaceManager.createWorkspace(
        request.user.id,
        request.body.name,
        {
          owner: request.user.id,
          type: request.body.type || 'workspace',
          label: request.body.label || request.body.name,
          description: request.body.description || '',
          color: request.body.color,
          metadata: request.body.metadata,
          acl: request.body.acl,
          restApi: request.body.restApi
        }
      );

      const responseObject = new ResponseObject().created(workspace, 'Workspace created successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      // Return the actual error message instead of a generic one
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to create workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Get workspace details
  fastify.get('/:id', {
    onRequest: [fastify.authenticate, resolveWorkspaceAddress, requireWorkspaceRead()],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Workspace and access info already validated by middleware
      const workspace = request.workspace;
      const access = request.workspaceAccess;

      const response = {
        workspace: workspace.toJSON(),
        access: {
          permissions: access.permissions,
          isOwner: access.isOwner,
          description: access.description
        }
      };

      // Include resource address if it was resolved from user/resource format
      if (request.originalAddress) {
        response.resourceAddress = request.originalAddress;
      } else {
        // Try to construct resource address from workspace data
        try {
          const resourceAddress = await fastify.workspaceManager.constructResourceAddress(workspace);
          if (resourceAddress) {
            response.resourceAddress = resourceAddress;
          }
        } catch (error) {
          // Ignore errors in address construction
        }
      }

      const responseObject = new ResponseObject().found(response, 'Workspace retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Update workspace
  fastify.patch('/:id', {
    onRequest: [fastify.authenticate, resolveWorkspaceAddress, requireWorkspaceAdmin()],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          description: { type: 'string' },
          color: { type: 'string', pattern: '^#[0-9A-Fa-f]{3,6}$' },
          locked: { type: 'boolean' },
          metadata: { type: 'object' },
          acl: { type: 'object' },
          restApi: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    if (!validateUserWithResponse(request, reply)) {
        return;
    }
    try {
      // Access already validated by middleware
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can modify workspace configuration');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const success = await fastify.workspaceManager.updateWorkspaceConfig(
        request.user.id,
        request.params.id,
        request.user.id,
        request.body
      );

      if (!success) {
        const responseObject = new ResponseObject().serverError('Failed to update workspace configuration');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(true, 'Workspace updated successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to update workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Delete workspace
  fastify.delete('/:id', {
    onRequest: [fastify.authenticate, resolveWorkspaceAddress, requireWorkspaceAdmin()],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    if (!validateUserWithResponse(request, reply)) {
        return;
    }
    try {
      // Prevent deletion of universe workspace
      if (request.params.id === 'universe') {
        const responseObject = new ResponseObject().forbidden('Universe workspace cannot be deleted');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Only owners can delete workspaces
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can delete workspaces');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const success = await fastify.workspaceManager.removeWorkspace(
        request.user.id,
        request.params.id,
        request.user.id,
        true // destroyData = true to actually delete the workspace files
      );

      if (!success) {
        const responseObject = new ResponseObject().serverError('Failed to delete workspace');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().deleted(null, 'Workspace deleted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to delete workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
