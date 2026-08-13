'use strict';

import ResponseObject from '../../ResponseObject.js';

export default async function workspaceTreesRoutes(fastify) {
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

  fastify.get('/', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const workspace = await getWorkspaceInstance(request, reply);
    if (!workspace) return reply;
    const trees = await workspace.listTrees(request.query?.type || null);
    const count = Array.isArray(trees) ? trees.length : 0;
    const responseObject = new ResponseObject().found(trees, 'Trees retrieved successfully', 200, count, count);
    return reply.code(responseObject.statusCode).send(responseObject.getResponse());
  });

  fastify.post('/', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['context', 'directory'] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;
      const tree = await workspace.createTree(request.body.name, request.body.type);
      const responseObject = new ResponseObject().created(tree, 'Tree created successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to create tree');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.patch('/:treeNameOrTreeId', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;
      const tree = await workspace.renameTree(request.params.treeNameOrTreeId, request.body.name);
      const responseObject = new ResponseObject().success(tree, 'Tree renamed successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      const responseObject = /reserved tree/i.test(error.message || '')
        ? new ResponseObject().conflict(error.message)
        : new ResponseObject().serverError(error.message || 'Failed to rename tree');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  fastify.delete('/:treeNameOrTreeId', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return reply;
      await workspace.destroyTree(request.params.treeNameOrTreeId);
      const responseObject = new ResponseObject().deleted(true, 'Tree deleted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      const responseObject = /reserved tree/i.test(error.message || '')
        ? new ResponseObject().conflict(error.message)
        : new ResponseObject().serverError(error.message || 'Failed to delete tree');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
