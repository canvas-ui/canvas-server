'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite, requireWorkspaceAdmin } from '../../middleware/workspace-acl.js';

/**
 * Workspace lifecycle routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceLifecycleRoutes(fastify, options) {
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
      const workspace = await fastify.workspaceManager.openWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Emit WebSocket event for status change
      try {
        fastify.broadcastToUser(request.user.id, 'status.changed', {
          workspaceId: request.params.id,
          status: workspace.status
        });
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
      // First get the workspace object before closing it
      const workspace = await fastify.workspaceManager.openWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Now close the workspace
      const success = await fastify.workspaceManager.closeWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

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
      fastify.broadcastToUser(request.user.id, 'status.changed', {
        workspaceId: request.params.id,
        status: 'inactive'
      });

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
      workspace = await fastify.workspaceManager.startWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Emit WebSocket event for status change
      fastify.broadcastToUser(request.user.id, 'status.changed', {
        workspaceId: request.params.id,
        status: 'active'
      });

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
      success = await fastify.workspaceManager.stopWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!success) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Emit WebSocket event for status change
      fastify.broadcastToUser(request.user.id, 'status.changed', {
        workspaceId: request.params.id,
        status: 'inactive'
      });

      const responseObject = new ResponseObject().success(true, 'Workspace stopped successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to stop workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
