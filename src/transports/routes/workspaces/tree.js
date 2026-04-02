'use strict';

import ResponseObject from '../../ResponseObject.js';

export default async function workspaceTreeRoutes(fastify) {
  async function getWorkspaceInstance(request, reply) {
    const identifier = request.params.id;
    const userId = request.user.id;
    const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const workspaceId = isWorkspaceId ? identifier : fastify.workspaceManager.resolveWorkspaceId(userId, identifier);
    if (!workspaceId) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }
    const workspace = await fastify.workspaceManager.getWorkspace(workspaceId, userId);
    if (!workspace) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }
    return workspace;
  }

  async function getTreeInstance(request, reply, expectedType = null) {
    const workspace = await getWorkspaceInstance(request, reply);
    if (!workspace) { return null; }

    try {
      const tree = workspace.getTree(request.params.treeNameOrTreeId);
      if (expectedType && tree.type !== expectedType) {
        const responseObject = new ResponseObject().badRequest(`Tree "${tree.name}" is not a ${expectedType} tree`);
        reply.code(responseObject.statusCode).send(responseObject.getResponse());
        return null;
      }
      return { workspace, tree };
    } catch (error) {
      const responseObject = new ResponseObject().notFound(error.message || 'Tree not found');
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }
  }

  fastify.get('/', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply);
      if (!resolved) return;
      const responseObject = new ResponseObject().found(resolved.tree.buildJsonTree(), 'Workspace tree retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Get workspace tree error for ID ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError('Failed to get workspace tree');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.post('/paths', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          autoCreateLayers: { type: 'boolean' },
          data: { type: ['object', 'null'], default: null },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply);
      if (!resolved) return;
      const result = await resolved.tree.insertPath(
        request.body.path,
        request.body.data,
        request.body.autoCreateLayers === undefined ? true : request.body.autoCreateLayers,
      );
      const responseObject = new ResponseObject().created(result, 'Path inserted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Insert workspace path error for ID ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to insert path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.post('/paths/move', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          recursive: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply);
      if (!resolved) return;
      const result = await resolved.tree.movePath(request.body.from, request.body.to, request.body.recursive);
      const responseObject = new ResponseObject().success(result, 'Path moved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Move workspace path error for ID ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to move path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.post('/paths/copy', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          recursive: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply);
      if (!resolved) return;
      const result = await resolved.tree.copyPath(request.body.from, request.body.to, request.body.recursive);
      const responseObject = new ResponseObject().success(result, 'Path copied successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Copy workspace path error for ID ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to copy path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.delete('/paths', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          recursive: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply);
      if (!resolved) return;
      const result = await resolved.tree.removePath(request.query.path, request.query.recursive);
      const responseObject = new ResponseObject().success(result, 'Path removed successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Remove workspace path error for ID ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to remove path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.post('/layers/merge', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['layerId', 'targetLayers'],
        properties: {
          layerId: { type: 'string' },
          targetLayers: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply, 'context');
      if (!resolved) return;
      const result = await resolved.tree.mergeLayer(request.body.layerId, request.body.targetLayers);
      const responseObject = result.error
        ? new ResponseObject().badRequest(result.error)
        : new ResponseObject().success(result, 'Layer merged successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Merge layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to merge layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.post('/layers/subtract', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['layerId', 'targetLayers'],
        properties: {
          layerId: { type: 'string' },
          targetLayers: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const resolved = await getTreeInstance(request, reply, 'context');
      if (!resolved) return;
      const result = await resolved.tree.subtractLayer(request.body.layerId, request.body.targetLayers);
      const responseObject = result.error
        ? new ResponseObject().badRequest(result.error)
        : new ResponseObject().success(result, 'Layer subtracted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Subtract layer error for workspace ${request.params.id}: ${error.message}`);
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to subtract layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
