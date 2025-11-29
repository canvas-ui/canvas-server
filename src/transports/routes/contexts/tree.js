'use strict';

import ResponseObject from '../../ResponseObject.js';
import { validateUser } from '../../auth/strategies.js';

export default async function treeRoutes(fastify, options) {
  // Add a pre-handler hook to ensure user is authenticated and valid
  fastify.addHook('preHandler', async (request, reply) => {
    try {
      validateUser(request.user, ['id']);
    } catch (err) {
      const response = new ResponseObject().unauthorized(err.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get context tree
  // Path: / (relative to /:id/tree)
  fastify.get('/', {
    onRequest: [fastify.authenticate],
    schema: {
      // params.id is implicitly available
    }
  }, async (request, reply) => {

    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspace = context.workspace;
      if (!workspace) {
        fastify.log.error(`Workspace not found or not loaded for context ${contextId}, user ${request.user.id}`);
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not available.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const treeData = workspace.jsonTree;

      if (treeData === undefined || treeData === null) {
        fastify.log.warn(`Received null or undefined jsonTree for context ${contextId} from workspace ${workspace.id}`);
        const response = new ResponseObject().error('Failed to retrieve valid tree data from workspace.');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success(treeData, 'Context tree retrieved successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Get tree error for context ${contextId}: ${error.message}`);
      if (error.message.includes('is not active or DB is not initialized') || error.message.includes('is not active. Cannot perform tree operation')) {
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not active. Cannot perform tree operation.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to get context tree');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Insert path into tree
  // Path: /paths (relative to /:id/tree)
  fastify.post('/paths', {
    onRequest: [fastify.authenticate],
    schema: {
      // params.id is implicitly available
      body: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          autoCreateLayers: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {

    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspace = context.workspace;
      if (!workspace) {
        fastify.log.error(`Workspace not found or not loaded for context ${contextId}, user ${request.user.id}`);
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not available.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const result = await workspace.insertPath(
        request.body.path,
        null,
        request.body.autoCreateLayers === undefined ? true : request.body.autoCreateLayers
      );

      const success = result === true || (typeof result === 'object' && result !== null);

      if (!success) {
        const response = new ResponseObject().error('Failed to insert tree path in workspace.');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().created(true, 'Tree path inserted successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Insert path error for context ${contextId}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not active. Cannot perform tree operation.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to insert tree path');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Remove path from tree
  // Path: /paths (relative to /:id/tree)
  fastify.delete('/paths', {
    onRequest: [fastify.authenticate],
    schema: {
      // params.id is implicitly available
      query: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          recursive: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {

    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspace = context.workspace;
      if (!workspace) {
        fastify.log.error(`Workspace not found or not loaded for context ${contextId}, user ${request.user.id}`);
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not available.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const success = await workspace.removePath(
        request.query.path,
        request.query.recursive || false
      );
      if (!success) {
        const response = new ResponseObject().error('Failed to remove tree path from workspace.');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().deleted({ success: true }, 'Tree path removed successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Remove path error for context ${contextId}: ${error.message}`);
       if (error.message.includes('is not active')) {
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not active. Cannot perform tree operation.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to remove tree path');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Move path in tree
  // Path: /paths/move (relative to /:id/tree)
  fastify.post('/paths/move', {
    onRequest: [fastify.authenticate],
    schema: {
      // params.id is implicitly available
      body: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          recursive: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {

    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspace = context.workspace;
      if (!workspace) {
        fastify.log.error(`Workspace not found or not loaded for context ${contextId}, user ${request.user.id}`);
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not available.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const success = await workspace.movePath(
        request.body.from,
        request.body.to,
        request.body.recursive || false
      );
      if (!success) {
        const response = new ResponseObject().error('Failed to move tree path in workspace.');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().success({ success: true }, 'Tree path moved successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Move path error for context ${contextId}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not active. Cannot perform tree operation.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to move tree path');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Copy path in tree
  // Path: /paths/copy (relative to /:id/tree)
  fastify.post('/paths/copy', {
    onRequest: [fastify.authenticate],
    schema: {
      // params.id is implicitly available
      body: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          recursive: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {

    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspace = context.workspace;
      if (!workspace) {
        fastify.log.error(`Workspace not found or not loaded for context ${contextId}, user ${request.user.id}`);
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not available.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const success = await workspace.copyPath(
        request.body.from,
        request.body.to,
        request.body.recursive || false
      );
      if (!success) {
        const response = new ResponseObject().error('Failed to copy tree path in workspace.');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().success({ success: true }, 'Tree path copied successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Copy path error for context ${contextId}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not active. Cannot perform tree operation.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to copy tree path');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Merge layer bitmaps upwards
  // Path: /paths/merge-up (relative to /:id/tree)
  fastify.post('/paths/merge-up', {
    onRequest: [fastify.authenticate],
    schema: {
      // params.id is implicitly available
      body: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {

    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspace = context.workspace;
      if (!workspace) {
        fastify.log.error(`Workspace not found or not loaded for context ${contextId}, user ${request.user.id}`);
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not available.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const success = await workspace.mergeUp(request.body.path);
      if (!success) {
        const response = new ResponseObject().error('Failed to merge layer bitmaps upwards in workspace.');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().success({ success: true }, 'Layer bitmaps merged upwards successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Merge up error for context ${contextId}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not active. Cannot perform tree operation.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to merge layer bitmaps upwards');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Merge layer bitmaps downwards
  // Path: /paths/merge-down (relative to /:id/tree)
  fastify.post('/paths/merge-down', {
    onRequest: [fastify.authenticate],
    schema: {
      // params.id is implicitly available
      body: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {

    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspace = context.workspace;
      if (!workspace) {
        fastify.log.error(`Workspace not found or not loaded for context ${contextId}, user ${request.user.id}`);
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not available.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const success = await workspace.mergeDown(request.body.path);
      if (!success) {
        const response = new ResponseObject().error('Failed to merge layer bitmaps downwards in workspace.');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().success({ success: true }, 'Layer bitmaps merged downwards successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Merge down error for context ${contextId}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not active. Cannot perform tree operation.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to merge layer bitmaps downwards');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Subtract layer bitmaps upwards
  fastify.post('/paths/subtract-up', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspace = context.workspace;
      if (!workspace) {
        fastify.log.error(`Workspace not found or not loaded for context ${contextId}, user ${request.user.id}`);
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not available.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const success = await workspace.subtractUp(request.body.path);
      if (!success) {
        const response = new ResponseObject().error('Failed to subtract layer bitmaps upwards in workspace.');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().success({ success: true }, 'Layer bitmaps subtracted upwards successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Subtract up error for context ${contextId}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not active. Cannot perform tree operation.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to subtract layer bitmaps upwards');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Subtract layer bitmaps downwards
  fastify.post('/paths/subtract-down', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspace = context.workspace;
      if (!workspace) {
        fastify.log.error(`Workspace not found or not loaded for context ${contextId}, user ${request.user.id}`);
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not available.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const success = await workspace.subtractDown(request.body.path);
      if (!success) {
        const response = new ResponseObject().error('Failed to subtract layer bitmaps downwards in workspace.');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().success({ success: true }, 'Layer bitmaps subtracted downwards successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Subtract down error for context ${contextId}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not active. Cannot perform tree operation.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to subtract layer bitmaps downwards');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Merge layer into target layers
  fastify.post('/layers/merge', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['layerId', 'targetLayers'],
        properties: {
          layerId: { type: 'string' },
          targetLayers: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspace = context.workspace;
      if (!workspace) {
        fastify.log.error(`Workspace not found or not loaded for context ${contextId}, user ${request.user.id}`);
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not available.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const result = await workspace.mergeLayer(request.body.layerId, request.body.targetLayers);
      if (result.error) {
        const response = new ResponseObject().badRequest(result.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success(result, 'Layer merged successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Merge layer error for context ${contextId}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not active. Cannot perform tree operation.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to merge layer');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Subtract layer from target layers
  fastify.post('/layers/subtract', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['layerId', 'targetLayers'],
        properties: {
          layerId: { type: 'string' },
          targetLayers: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspace = context.workspace;
      if (!workspace) {
        fastify.log.error(`Workspace not found or not loaded for context ${contextId}, user ${request.user.id}`);
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not available.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const result = await workspace.subtractLayer(request.body.layerId, request.body.targetLayers);
      if (result.error) {
        const response = new ResponseObject().badRequest(result.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success(result, 'Layer subtracted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(`Subtract layer error for context ${contextId}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const response = new ResponseObject().error(`Workspace for context ${contextId} is not active. Cannot perform tree operation.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to subtract layer');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
