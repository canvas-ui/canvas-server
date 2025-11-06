'use strict';

import ResponseObject from '../../ResponseObject.js';

/**
 * Context email-based sharing routes for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function contextShareRoutes(fastify, options) {

  // Grant email-based access to a context
  fastify.post('/:id/shares', {
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
        required: ['userEmail', 'accessLevel'],
        properties: {
          userEmail: { type: 'string', format: 'email' },
          accessLevel: {
            type: 'string',
            enum: ['documentRead', 'documentWrite', 'documentReadWrite'],
            description: 'Access level to grant'
          },
          description: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { userEmail, accessLevel, description } = request.body;
      const { id: contextId } = request.params;
      const userId = request.user.id;

      // Get the context to ensure user is the owner
      const context = await fastify.contextManager.getContext(userId, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context '${contextId}' not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Only owners can create email-based shares
      if (context.userId !== userId) {
        const response = new ResponseObject().forbidden('Only context owners can create email-based shares');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Verify the user exists on this server
      try {
        const targetUser = await fastify.userManager.getUserByEmail(userEmail);
        if (!targetUser) {
          const response = new ResponseObject().notFound(`User with email '${userEmail}' not found on this server`);
          return reply.code(response.statusCode).send(response.getResponse());
        }
      } catch (error) {
        const response = new ResponseObject().notFound(`User with email '${userEmail}' not found on this server`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Grant access using the new method
      await context.grantAccessByEmail(userEmail, accessLevel, {
        description: description || `Shared context access for ${userEmail}`,
        grantedBy: userId
      });

      // Return share info
      const responseData = {
        userEmail,
        accessLevel,
        description: description || `Shared context access for ${userEmail}`,
        grantedAt: new Date().toISOString(),
        grantedBy: userId
      };

      const response = new ResponseObject().created(responseData, 'Context shared successfully with user');
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(`Failed to create context share: ${error.message}`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // List all email-based shares for the context
  fastify.get('/:id/shares', {
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
      const { id: contextId } = request.params;
      const userId = request.user.id;

      // Get the context
      const context = await fastify.contextManager.getContext(userId, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context '${contextId}' not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Only owners can list email-based shares
      if (context.userId !== userId) {
        const response = new ResponseObject().forbidden('Only context owners can list email-based shares');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const acl = context.acl || {};
      const users = acl.users || {};

      // Convert users to array format
      const shareList = Object.entries(users).map(([userEmail, shareData]) => ({
        userEmail,
        ...shareData
      }));

      const response = new ResponseObject().found(shareList, 'Context shares retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list context shares');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Revoke email-based access to a context
  fastify.delete('/:id/shares/:userEmail', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'userEmail'],
        properties: {
          id: { type: 'string' },
          userEmail: { type: 'string', format: 'email' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id: contextId, userEmail } = request.params;
      const userId = request.user.id;

      // Get the context
      const context = await fastify.contextManager.getContext(userId, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context '${contextId}' not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Only owners can revoke email-based shares
      if (context.userId !== userId) {
        const response = new ResponseObject().forbidden('Only context owners can revoke email-based shares');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const acl = context.acl || {};
      const users = acl.users || {};

      if (!users[userEmail]) {
        const response = new ResponseObject().notFound(`Share for user '${userEmail}' not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Revoke access
      await context.revokeAccessByEmail(userEmail);

      const response = new ResponseObject().success({ userEmail }, 'Context share revoked successfully');
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to revoke context share');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Update email-based access permissions
  fastify.put('/:id/shares/:userEmail', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'userEmail'],
        properties: {
          id: { type: 'string' },
          userEmail: { type: 'string', format: 'email' }
        }
      },
      body: {
        type: 'object',
        required: ['accessLevel'],
        properties: {
          accessLevel: {
            type: 'string',
            enum: ['documentRead', 'documentWrite', 'documentReadWrite'],
            description: 'Access level to grant'
          },
          description: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id: contextId, userEmail } = request.params;
      const { accessLevel, description } = request.body;
      const userId = request.user.id;

      // Get the context
      const context = await fastify.contextManager.getContext(userId, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context '${contextId}' not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Only owners can update email-based shares
      if (context.userId !== userId) {
        const response = new ResponseObject().forbidden('Only context owners can update email-based shares');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const acl = context.acl || {};
      const users = acl.users || {};

      if (!users[userEmail]) {
        const response = new ResponseObject().notFound(`Share for user '${userEmail}' not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Update the share
      await context.updateAccessByEmail(userEmail, accessLevel, {
        description: description !== undefined ? description : users[userEmail].description,
        updatedBy: userId
      });

      const responseData = {
        userEmail,
        accessLevel,
        description: description !== undefined ? description : users[userEmail].description,
        updatedAt: new Date().toISOString(),
        updatedBy: userId
      };

      const response = new ResponseObject().success(responseData, 'Context share updated successfully');
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to update context share');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}

