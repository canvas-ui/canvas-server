'use strict';

import ResponseObject from '../../ResponseObject.js';

export default async function workspaceLayerRoutes(fastify, options) {
  async function getWorkspaceInstance(request, reply) {
    const workspace = await fastify.workspaceManager.getWorkspace(
      request.params.id,
      request.user.id
    );
    if (!workspace) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }
    return workspace;
  }

  // List all layers
  fastify.get('/', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const layers = await workspace.tree.listLayers();
      const payload = layers.map(l => l.toJSON ? l.toJSON() : l);
      const responseObject = new ResponseObject().found(payload, 'Layers retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`List layers error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError('Failed to list layers');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Get single layer by id
  fastify.get('/:layerId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'layerId'],
        properties: { id: { type: 'string' }, layerId: { type: 'string' } }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const layer = workspace.tree.getLayerById(request.params.layerId) || workspace.tree.getLayer(request.params.layerId);
      if (!layer) {
        const responseObject = new ResponseObject().notFound(`Layer not found: ${request.params.layerId}`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const responseObject = new ResponseObject().found(layer.toJSON ? layer.toJSON() : layer, 'Layer retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Get layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError('Failed to get layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Rename layer
  fastify.patch('/:layerId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'layerId'],
        properties: { id: { type: 'string' }, layerId: { type: 'string' } }
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const { name } = request.body || {};
      if (!name) {
        const responseObject = new ResponseObject().badRequest('New name required');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const layer = await workspace.tree.renameLayer(request.params.layerId, name);
      const responseObject = new ResponseObject().success(layer.toJSON ? layer.toJSON() : layer, 'Layer renamed successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Rename layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to rename layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Lock layer
  fastify.post('/:layerId/lock', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'layerId'],
        properties: { id: { type: 'string' }, layerId: { type: 'string' } }
      },
      body: {
        type: 'object',
        required: ['lockBy'],
        properties: {
          lockBy: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      await workspace.tree.lockLayer(request.params.layerId, request.body.lockBy);
      const responseObject = new ResponseObject().success(true, 'Layer locked successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Lock layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to lock layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Unlock layer
  fastify.post('/:layerId/unlock', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'layerId'],
        properties: { id: { type: 'string' }, layerId: { type: 'string' } }
      },
      body: {
        type: 'object',
        required: ['lockBy'],
        properties: {
          lockBy: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      await workspace.tree.unlockLayer(request.params.layerId, request.body.lockBy);
      const responseObject = new ResponseObject().success(true, 'Layer unlocked successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Unlock layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to unlock layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Remove layer from index (detach)
  fastify.delete('/:layerId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'layerId'],
        properties: { id: { type: 'string' }, layerId: { type: 'string' } }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const success = await workspace.tree.deleteLayer(request.params.layerId);
      if (!success) {
        const responseObject = new ResponseObject().badRequest('Failed to remove layer');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const responseObject = new ResponseObject().deleted(true, 'Layer removed successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Remove layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to remove layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
