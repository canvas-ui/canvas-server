'use strict';

import ResponseObject from '../../ResponseObject.js';

/**
 * Workspace tree routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceTreeRoutes(fastify, options) {
  // Helper to get workspace and handle common errors
  async function getWorkspaceInstance(request, reply) {
    const workspace = await fastify.workspaceManager.getWorkspace(
      request.user.id, // Use user.id for consistency with new indexing system
      request.params.id,
      request.user.id
    );
    if (!workspace) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }
    // Workspace methods have internal #ensureActiveForTreeOp, which will throw if not active.
    return workspace;
  }

  // Get workspace tree
  fastify.get('/', {
    onRequest: [fastify.authenticate],
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
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return; // Error already sent

      const treeJsonString = workspace.jsonTree; // Use the getter
      if (treeJsonString === undefined || treeJsonString === null) {
        fastify.log.warn(`Received null or undefined jsonTree for workspace ${request.params.id}`);
        const responseObject = new ResponseObject().serverError('Failed to retrieve valid tree data from workspace.');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      let treeData;
      try {
        treeData = treeJsonString;
      } catch (parseError) {
        fastify.log.error(`Failed to parse tree JSON for workspace ${request.params.id}: ${parseError.message}. JSON: ${treeJsonString}`);
        const responseObject = new ResponseObject().serverError('Failed to parse tree data from workspace.');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(treeData, 'Workspace tree retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Get workspace tree error for ID ${request.params.id}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const errResponse = new ResponseObject().serverError(`Workspace ${request.params.id} is not active. Cannot perform tree operation.`);
        return reply.code(errResponse.statusCode).send(errResponse.getResponse());
      }
      const responseObject = new ResponseObject().serverError('Failed to get workspace tree');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Insert path (Added for consistency, mirrors Contexts tree.js)
  // Workspace.js has insertPath(path, data = null, autoCreateLayers = true)
  fastify.post('/paths', {
    onRequest: [fastify.authenticate],
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
        required: ['path'],
        properties: {
          path: { type: 'string' },
          autoCreateLayers: { type: 'boolean' },
          data: { type: ['object', 'null'], default: null } // data for the node
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const result = await workspace.insertPath(
        request.body.path,
        request.body.data, // Pass data from request
        request.body.autoCreateLayers === undefined ? true : request.body.autoCreateLayers
      );
      const success = result === true || (typeof result === 'object' && result !== null);

      if (!success) {
        const responseObject = new ResponseObject().serverError('Failed to insert tree path in workspace.');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }
      const responseObject = new ResponseObject().created(true, 'Path inserted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Insert workspace path error for ID ${request.params.id}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const errResponse = new ResponseObject().serverError(`Workspace ${request.params.id} is not active. Cannot perform tree operation.`);
        return reply.code(errResponse.statusCode).send(errResponse.getResponse());
      }
      const responseObject = new ResponseObject().serverError('Failed to insert path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Move path
  fastify.post('/paths/move', {
    onRequest: [fastify.authenticate],
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
        required: ['from', 'to'], // Changed from sourcePath, targetPath to from, to
        properties: {
          from: { type: 'string' }, // Was sourcePath
          to: { type: 'string' },   // Was targetPath
          recursive: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const success = await workspace.movePath(request.body.from, request.body.to, request.body.recursive);
      if (!success) {
        const responseObject = new ResponseObject().badRequest('Failed to move path in workspace.');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(true, 'Path moved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Move workspace path error for ID ${request.params.id}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const errResponse = new ResponseObject().serverError(`Workspace ${request.params.id} is not active. Cannot perform tree operation.`);
        return reply.code(errResponse.statusCode).send(errResponse.getResponse());
      }
      const responseObject = new ResponseObject().serverError('Failed to move path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Copy path
  fastify.post('/paths/copy', {
    onRequest: [fastify.authenticate],
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
        required: ['from', 'to'], // Changed from sourcePath, targetPath to from, to
        properties: {
          from: { type: 'string' }, // Was sourcePath
          to: { type: 'string' },   // Was targetPath
          recursive: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const success = await workspace.copyPath(request.body.from, request.body.to, request.body.recursive);
      if (!success) {
        const responseObject = new ResponseObject().badRequest('Failed to copy path in workspace.');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(true, 'Path copied successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Copy workspace path error for ID ${request.params.id}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const errResponse = new ResponseObject().serverError(`Workspace ${request.params.id} is not active. Cannot perform tree operation.`);
        return reply.code(errResponse.statusCode).send(errResponse.getResponse());
      }
      const responseObject = new ResponseObject().serverError('Failed to copy path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Remove path
  // Using query parameter for path to be removed for DELETE
  fastify.delete('/paths', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          recursive: { type: 'boolean', default: false }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const success = await workspace.removePath(request.query.path, request.query.recursive);
      if (!success) {
        const responseObject = new ResponseObject().badRequest('Failed to remove path from workspace.');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(true, 'Path removed successfully'); // Or .deleted()
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Remove workspace path error for ID ${request.params.id}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const errResponse = new ResponseObject().serverError(`Workspace ${request.params.id} is not active. Cannot perform tree operation.`);
        return reply.code(errResponse.statusCode).send(errResponse.getResponse());
      }
      const responseObject = new ResponseObject().serverError('Failed to remove path');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Merge layer bitmaps upwards
  fastify.post('/paths/merge-up', {
    onRequest: [fastify.authenticate],
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
        required: ['path'],
        properties: {
          path: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const success = await workspace.mergeUp(request.body.path);
      if (!success) {
        const responseObject = new ResponseObject().badRequest('Failed to merge layer bitmaps upwards in workspace.');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(true, 'Layer bitmaps merged upwards successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Merge up workspace error for ID ${request.params.id}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const errResponse = new ResponseObject().serverError(`Workspace ${request.params.id} is not active. Cannot perform tree operation.`);
        return reply.code(errResponse.statusCode).send(errResponse.getResponse());
      }
      const responseObject = new ResponseObject().serverError('Failed to merge layer bitmaps upwards');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Merge layer bitmaps downwards
  fastify.post('/paths/merge-down', {
    onRequest: [fastify.authenticate],
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
        required: ['path'],
        properties: {
          path: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const success = await workspace.mergeDown(request.body.path);
      if (!success) {
        const responseObject = new ResponseObject().badRequest('Failed to merge layer bitmaps downwards in workspace.');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(true, 'Layer bitmaps merged downwards successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Merge down workspace error for ID ${request.params.id}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const errResponse = new ResponseObject().serverError(`Workspace ${request.params.id} is not active. Cannot perform tree operation.`);
        return reply.code(errResponse.statusCode).send(errResponse.getResponse());
      }
      const responseObject = new ResponseObject().serverError('Failed to merge layer bitmaps downwards');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Subtract layer bitmaps upwards
  fastify.post('/paths/subtract-up', {
    onRequest: [fastify.authenticate],
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
        required: ['path'],
        properties: {
          path: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const success = await workspace.subtractUp(request.body.path);
      if (!success) {
        const responseObject = new ResponseObject().badRequest('Failed to subtract layer bitmaps upwards in workspace.');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(true, 'Layer bitmaps subtracted upwards successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Subtract up workspace error for ID ${request.params.id}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const errResponse = new ResponseObject().serverError(`Workspace ${request.params.id} is not active. Cannot perform tree operation.`);
        return reply.code(errResponse.statusCode).send(errResponse.getResponse());
      }
      const responseObject = new ResponseObject().serverError('Failed to subtract layer bitmaps upwards');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Subtract layer bitmaps downwards
  fastify.post('/paths/subtract-down', {
    onRequest: [fastify.authenticate],
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
        required: ['path'],
        properties: {
          path: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const success = await workspace.subtractDown(request.body.path);
      if (!success) {
        const responseObject = new ResponseObject().badRequest('Failed to subtract layer bitmaps downwards in workspace.');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(true, 'Layer bitmaps subtracted downwards successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Subtract down workspace error for ID ${request.params.id}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const errResponse = new ResponseObject().serverError(`Workspace ${request.params.id} is not active. Cannot perform tree operation.`);
        return reply.code(errResponse.statusCode).send(errResponse.getResponse());
      }
      const responseObject = new ResponseObject().serverError('Failed to subtract layer bitmaps downwards');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Merge layer into target layers
  fastify.post('/layers/merge', {
    onRequest: [fastify.authenticate],
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
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const result = await workspace.mergeLayer(request.body.layerId, request.body.targetLayers);
      if (result.error) {
        const responseObject = new ResponseObject().badRequest(result.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(result, 'Layer merged successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Merge layer error for workspace ${request.params.id}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const errResponse = new ResponseObject().serverError(`Workspace ${request.params.id} is not active. Cannot perform tree operation.`);
        return reply.code(errResponse.statusCode).send(errResponse.getResponse());
      }
      const responseObject = new ResponseObject().serverError('Failed to merge layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Subtract layer from target layers
  fastify.post('/layers/subtract', {
    onRequest: [fastify.authenticate],
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
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const result = await workspace.subtractLayer(request.body.layerId, request.body.targetLayers);
      if (result.error) {
        const responseObject = new ResponseObject().badRequest(result.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(result, 'Layer subtracted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(`Subtract layer error for workspace ${request.params.id}: ${error.message}`);
      if (error.message.includes('is not active')) {
        const errResponse = new ResponseObject().serverError(`Workspace ${request.params.id} is not active. Cannot perform tree operation.`);
        return reply.code(errResponse.statusCode).send(errResponse.getResponse());
      }
      const responseObject = new ResponseObject().serverError('Failed to subtract layer');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // [duplicate removed]
}
