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
      const workspace = request.workspace;
      const responseObject = new ResponseObject().found({ status: workspace.status }, 'Workspace status retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get workspace status');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Get workspace stats (SynapsD database statistics)
  fastify.get('/stats', {
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
      const workspace = request.workspace;
      if (!workspace.isActive) {
        const responseObject = new ResponseObject().badRequest('Workspace is not active');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const stats = await workspace.getStats();
      const responseObject = new ResponseObject().found(stats, 'Workspace stats retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get workspace stats');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Get database stats (SynapsD internals: FTS + dense-vector + embedder/queue).
  // Lives under the /db namespace — future dump/snapshot routes belong here too.
  fastify.get('/db/stats', {
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
      const workspace = request.workspace;
      if (!workspace.isActive) {
        const responseObject = new ResponseObject().badRequest('Workspace is not active');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const stats = await workspace.getStats();
      const responseObject = new ResponseObject().found(stats, 'Database stats retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get database stats');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Live-tune search knobs (image relevance floor). Persisted to workspace.json
  // and applied to the running DB without a restart. { imageMaxDistance: number|null }.
  fastify.put('/db/tuning', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: { imageMaxDistance: { type: ['number', 'null'] } },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = request.workspace;
      if (!workspace.isActive) {
        const r = new ResponseObject().badRequest('Workspace is not active');
        return reply.code(r.statusCode).send(r.getResponse());
      }
      const result = await workspace.setSearchTuning(request.body || {});
      const r = new ResponseObject().success(result, 'Search tuning updated');
      return reply.code(r.statusCode).send(r.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const r = new ResponseObject().serverError('Failed to update search tuning');
      return reply.code(r.statusCode).send(r.getResponse());
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
