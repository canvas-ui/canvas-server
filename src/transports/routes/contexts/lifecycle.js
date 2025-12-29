'use strict';

import ResponseObject from '../../ResponseObject.js';
import { validateUser } from '../../auth/strategies.js';
import { resolveContextAddress } from '../../middleware/address-resolver.js';

export default async function lifecycleRoutes(fastify, options) {
  // Add a pre-handler hook to ensure user is authenticated and valid for all context document routes
  fastify.addHook('preHandler', async (request, reply) => {
    try {
      // The `authenticate` hook should have already run and populated `request.user`
      // We just need to validate it has the required fields for our operations.
      validateUser(request.user, ['id']); // For context operations, we primarily need the user's ID.
    } catch (err) {
      // If validateUser throws, it means the user object is invalid.
      const response = new ResponseObject().unauthorized(err.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Lifecycle routes will be added here

  // List all contexts
  fastify.get('/', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {

    try {
      const contexts = await fastify.contextManager.listUserContexts(request.user.id);

      // Return consistent ResponseObject format
      const response = new ResponseObject();
      return reply.code(200).send(response.found(contexts, 'Contexts retrieved successfully', 200, contexts.length).getResponse());

    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to list contexts');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Create new context
  fastify.post('/', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: "User-defined ID for the new context. This will be sanitized." },
          url: { type: 'string', description: "The URL for the new context (e.g., universe://my-context-name). Defaults to '/' if not provided." },
          baseUrl: { type: 'string' },
          description: { type: 'string' },
          workspaceId: { type: 'string' },
          type: { type: 'string', enum: ['context', 'universe'] },
          metadata: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {

    try {
      const context = await fastify.contextManager.createContext(
        request.user.id,
        request.body.url || '/',
        {
          id: request.body.id,
          userId: request.user.id,
          type: request.body.type || 'context',
          workspaceId: request.body.workspaceId,
          description: request.body.description || '',
          metadata: request.body.metadata,
          baseUrl: request.body.baseUrl
        }
      );

      const response = new ResponseObject().created({ context }, 'Context created successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to create context', error.message);
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get context by ID
  // Note: The prefix for this group is '/', so this becomes GET /:id
  fastify.get('/:id', {
    onRequest: [fastify.authenticate, resolveContextAddress],
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
      const context = await fastify.contextManager.getContext(request.user.id, request.params.id);

      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID '${request.params.id}' not found or not accessible.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const responsePayload = context.toJSON();

      // Include resource address if it was resolved from user/resource format
      if (request.originalAddress) {
        responsePayload.resourceAddress = request.originalAddress;
      } else {
        // Try to construct resource address from context data
        try {
          const resourceAddress = await fastify.contextManager.constructResourceAddress(context);
          if (resourceAddress) {
            responsePayload.resourceAddress = resourceAddress;
          }
        } catch (error) {
          // Ignore errors in address construction
        }
      }

      const response = new ResponseObject().success(responsePayload, 'Context retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      if (error.message.startsWith('Access denied')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (error.message.includes('Invalid shared context identifier format') || error.message.includes('Expected ')) {
        const response = new ResponseObject().badRequest(`Invalid context ID format for this endpoint. Use /users/{ownerId}/contexts/{contextId} for shared contexts. Context ID '${request.params.id}' is not valid here.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to get context');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get context URL
  // Note: The prefix for this group is '/', so this becomes GET /:id/url
  fastify.get('/:id/url', {
    onRequest: [fastify.authenticate, resolveContextAddress],
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
      const context = await fastify.contextManager.getContext(request.user.id, request.params.id);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success({ url: context.url }, 'Context URL retrieved successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to get context URL');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Set context URL
  // Note: The prefix for this group is '/', so this becomes POST /:id/url
  fastify.post('/:id/url', {
    onRequest: [fastify.authenticate, resolveContextAddress],
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
        required: ['url'],
        properties: {
          url: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {

    try {
      const context = await fastify.contextManager.getContext(request.user.id, request.params.id);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await context.setUrl(request.body.url);
      const response = new ResponseObject().success({ url: context.url }, 'Context URL updated successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error(`Failed to set context URL: ${error.message}`);
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get context path
  // Note: The prefix for this group is '/', so this becomes GET /:id/path
  fastify.get('/:id/path', {
    onRequest: [fastify.authenticate, resolveContextAddress],
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
      const context = await fastify.contextManager.getContext(request.user.id, request.params.id);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success({ path: context.path }, 'Context path retrieved successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to get context path');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get context path array
  // Note: The prefix for this group is '/', so this becomes GET /:id/path-array
  fastify.get('/:id/path-array', {
    onRequest: [fastify.authenticate, resolveContextAddress],
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
      const context = await fastify.contextManager.getContext(request.user.id, request.params.id);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success({ pathArray: context.pathArray }, 'Context path array retrieved successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to get context path array');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Update context
  // Note: The prefix for this group is '/', so this becomes PUT /:id
  fastify.put('/:id', {
    onRequest: [fastify.authenticate, resolveContextAddress],
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
          description: { type: 'string' },
          metadata: { type: 'object' },
          acl: { type: 'object' },
          restApi: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {

    try {
      const context = await fastify.contextManager.updateContext(
        request.user.id,
        request.params.id,
        request.body
      );

      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().updated({ context }, 'Context updated successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to update context');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Delete context
  // Note: The prefix for this group is '/', so this becomes DELETE /:id
  fastify.delete('/:id', {
    onRequest: [fastify.authenticate, resolveContextAddress],
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
      const success = await fastify.contextManager.removeContext(request.user.id, request.params.id);
      if (!success) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().deleted(null, 'Context deleted successfully');
        return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().error('Failed to delete context');
        return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
