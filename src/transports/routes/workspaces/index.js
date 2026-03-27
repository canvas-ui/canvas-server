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
  const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');

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

  async function resolveWorkspaceForBinding(request) {
    if (request.workspace) {
      return request.workspace;
    }

    const identifier = request.params?.id;
    const userId = request.user?.id;
    if (!identifier || !userId) {
      return null;
    }

    const workspaceId = isUuid(identifier)
      ? identifier
      : await fastify.workspaceManager.resolveWorkspaceId(userId, identifier);

    if (!workspaceId) {
      return null;
    }

    return fastify.workspaceManager.getWorkspace(workspaceId, userId);
  }

  fastify.addHook('preHandler', async (request) => {
    const client = request.client;
    if (!client?.registeredDevice || !client.deviceId || !request.user?.id || !request.params?.id || !fastify.deviceRegistry) {
      return;
    }

    try {
      const workspace = await resolveWorkspaceForBinding(request);
      if (!workspace) {
        return;
      }

      let device = await fastify.deviceRegistry.touchDevice(request.user.id, client.deviceId);
      if (!device && client.authMode === 'device') {
        device = await fastify.deviceRegistry.upsertDevice(request.user.id, {
          deviceId: client.deviceId,
          name: client.deviceId,
          platform: client.deviceOs,
          type: client.deviceType || 'device',
        });
      }
      if (!device) {
        return;
      }

      await fastify.deviceRegistry.ensureWorkspaceBinding(workspace, device);
    } catch (error) {
      fastify.log.warn({ err: error, deviceId: client.deviceId, workspaceId: request.params?.id }, 'Failed to sync workspace device');
    }
  });

  // Register sub-routes
  fastify.register(import('./documents.js'), {
    prefix: '/:id/documents',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./trees.js'), {
    prefix: '/:id/trees',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./tree.js'), {
    prefix: '/:id/trees/:treeNameOrTreeId',
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
  fastify.register(import('./hooks.js'), {
    prefix: '/:id/hooks',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./devices.js'), {
    prefix: '/:id/devices',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./bitmaps.js'), {
    prefix: '/:id/bitmaps',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./services.js'), {
    prefix: '/:id/services',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./services-imap.js'), {
    prefix: '/:id/services/imap',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./home.js'), {
    prefix: '/:id/home',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./links.js'), {
    prefix: '/:id/links',
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

      const workspaces = await fastify.workspaceManager.listWorkspaces(request.user.id);

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
          icon: { type: ['string', 'null'] },
          homeScreen: { type: 'object' },
          type: { type: 'string', enum: ['workspace', 'universe'] },
          metadata: { type: 'object' },
          acl: { type: 'object' },
          links: { type: 'object' },
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
        request.body.name,
        request.user.id,
        {
          type: request.body.type || 'workspace',
          label: request.body.label || request.body.name,
          description: request.body.description || '',
          color: request.body.color,
          icon: request.body.icon,
          homeScreen: request.body.homeScreen,
          metadata: request.body.metadata,
          acl: request.body.acl,
          links: request.body.links,
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

      if (request.originalAddress) {
        response.resourceAddress = request.originalAddress;
      } else {
        try {
          response.resourceAddress = fastify.workspaceManager.constructWorkspaceReference(
            workspace.owner, workspace.name
          );
        } catch (_) {}
      }

      const responseObject = new ResponseObject().found(response, 'Workspace retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // List contexts for a workspace
  fastify.get('/:id/contexts', {
    onRequest: [fastify.authenticate, resolveWorkspaceAddress, requireWorkspaceRead()],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } }
      }
    }
  }, async (request, reply) => {
    try {
      const contexts = fastify.contextManager.getContextsForWorkspace(request.workspace.id);
      const response = new ResponseObject();
      return reply.code(200).send(response.found(contexts, 'Contexts retrieved successfully', 200, contexts.length).getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list workspace contexts');
      return reply.code(response.statusCode).send(response.getResponse());
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
          icon: { type: ['string', 'null'] },
          homeScreen: { type: 'object' },
          locked: { type: 'boolean' },
          metadata: { type: 'object' },
          acl: { type: 'object' },
          links: { type: 'object' },
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
        request.workspace.owner,
        request.workspace.id,
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
        request.workspace.id,
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
