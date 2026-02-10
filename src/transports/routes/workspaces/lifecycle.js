'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite, requireWorkspaceAdmin } from '../../middleware/workspace-acl.js';

/**
 * Workspace lifecycle routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceLifecycleRoutes(fastify, options) {
  async function resolveWorkspaceId(request, reply) {
    const identifier = request.params.id;
    const userId = request.user.id;
    const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const workspaceId = isWorkspaceId ? identifier : fastify.workspaceManager.resolveWorkspaceId(userId, identifier);
    if (!workspaceId) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }
    return workspaceId;
  }

  // Get workspace status
  fastify.get('/status', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
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
      // Workspace access already validated by middleware
      const workspace = request.workspace;
      const status = workspace.status;

      const responseObject = new ResponseObject().found({ status }, 'Workspace status retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get workspace status');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Open workspace
  fastify.post('/open', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
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
    // Check if the reply was already sent (defensive check)
    if (reply.sent) {
      fastify.log.warn(`Open workspace: Reply already sent for workspace ${request.params.id}`);
      return;
    }

    try {
      const workspaceId = await resolveWorkspaceId(request, reply);
      if (!workspaceId) return;

      const workspace = await fastify.workspaceManager.startWorkspace(workspaceId, request.user.id);
      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Emit WebSocket event for status change
      try {
        const payload = { workspaceId, status: workspace.status };
        // Canonical workspace event name(s)
        fastify.broadcastToUser(request.user.id, 'workspace:status:changed', payload);
        fastify.broadcastToUser(request.user.id, 'workspace.status.changed', payload);
        // Legacy (un-namespaced) event name
        fastify.broadcastToUser(request.user.id, 'status.changed', payload);
      } catch (wsError) {
        fastify.log.error(`Failed to broadcast workspace status change: ${wsError.message}`);
        // Continue since this shouldn't fail the request
      }

      const responseObject = new ResponseObject().success(workspace, 'Workspace opened successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      if (reply.sent) {
        fastify.log.error(`Error after reply already sent: ${error.message}`);
        return;
      }

      fastify.log.error(`Failed to open workspace: ${error.message}`);
      const responseObject = new ResponseObject().serverError('Failed to open workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Close workspace
  fastify.post('/close', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
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
      const workspaceId = await resolveWorkspaceId(request, reply);
      if (!workspaceId) return;

      // Get workspace before closing
      const workspace = await fastify.workspaceManager.getWorkspace(workspaceId, request.user.id);
      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Now stop the workspace
      const success = await fastify.workspaceManager.stopWorkspace(workspaceId, request.user.id);

      if (!success) {
        const responseObject = new ResponseObject().serverError('Failed to close workspace');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Get updated workspace data after closing (status should now be 'inactive')
      const updatedWorkspace = {
        ...workspace.toJSON(),
        status: 'inactive'
      };

      // Emit WebSocket event for status change
      {
        const payload = { workspaceId, status: 'inactive' };
        fastify.broadcastToUser(request.user.id, 'workspace:status:changed', payload);
        fastify.broadcastToUser(request.user.id, 'workspace.status.changed', payload);
        fastify.broadcastToUser(request.user.id, 'status.changed', payload);
      }

      const responseObject = new ResponseObject().success(updatedWorkspace, 'Workspace closed successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to close workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Start workspace
  fastify.post('/start', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
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
    let workspace;
    try {
      const workspaceId = await resolveWorkspaceId(request, reply);
      if (!workspaceId) return;

      workspace = await fastify.workspaceManager.startWorkspace(workspaceId, request.user.id);
      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Emit WebSocket event for status change
      {
        const payload = { workspaceId, status: 'active' };
        fastify.broadcastToUser(request.user.id, 'workspace:status:changed', payload);
        fastify.broadcastToUser(request.user.id, 'workspace.status.changed', payload);
        fastify.broadcastToUser(request.user.id, 'status.changed', payload);
      }

      const responseObject = new ResponseObject().success(workspace, 'Workspace started successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to start workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Stop workspace
  fastify.post('/stop', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
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
    let success;
    try {
      const workspaceId = await resolveWorkspaceId(request, reply);
      if (!workspaceId) return;

      success = await fastify.workspaceManager.stopWorkspace(workspaceId, request.user.id);
      if (!success) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Emit WebSocket event for status change
      {
        const payload = { workspaceId, status: 'inactive' };
        fastify.broadcastToUser(request.user.id, 'workspace:status:changed', payload);
        fastify.broadcastToUser(request.user.id, 'workspace.status.changed', payload);
        fastify.broadcastToUser(request.user.id, 'status.changed', payload);
      }

      const responseObject = new ResponseObject().success(true, 'Workspace stopped successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to stop workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
