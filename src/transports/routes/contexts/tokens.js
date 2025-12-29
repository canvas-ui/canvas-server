'use strict';

import crypto from 'crypto';
import ResponseObject from '../../ResponseObject.js';

/**
 * Context token sharing routes for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function contextTokenRoutes(fastify, options) {

  // Create a sharing token for the context
  fastify.post('/:contextId/tokens', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['contextId'],
        properties: {
          contextId: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        required: ['permissions'],
        properties: {
          permissions: {
            type: 'array',
            items: { type: 'string', enum: ['documentRead', 'documentWrite', 'documentReadWrite'] },
            minItems: 1
          },
          description: { type: 'string' },
          expiresAt: {
            oneOf: [
              { type: 'string', format: 'date-time' },
              { type: 'null' }
            ]
          },
          type: {
            type: 'string',
            enum: ['standard', 'secret-link'],
            default: 'standard'
          },
          maxUses: { type: 'integer', minimum: 1 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { contextId } = request.params;
      const { permissions, description, expiresAt, type = 'standard', maxUses } = request.body;
      const userId = request.user.id;

      // Get the context to ensure user is the owner
      const context = await fastify.contextManager.getContext(userId, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context '${contextId}' not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Only owners can create sharing tokens
      if (context.userId !== userId) {
        const response = new ResponseObject().forbidden('Only context owners can create sharing tokens');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Generate new API token
      const tokenValue = `canvas-${crypto.randomBytes(24).toString('hex')}`;
      const tokenHash = `sha256:${crypto.createHash('sha256').update(tokenValue).digest('hex')}`;

      // Create token data
      const tokenData = {
        permissions,
        description: description || 'Context sharing token',
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt || null,
        type,
        currentUses: 0
      };

      // Add maxUses for secret-link type
      if (type === 'secret-link' && maxUses) {
        tokenData.maxUses = maxUses;
      }

      // Update context ACL
      const currentACL = context.acl || {};
      currentACL.tokens = currentACL.tokens || {};
      currentACL.tokens[tokenHash] = tokenData;

      // Save the updated ACL through the context
      await context.updateACL(currentACL);

      // Return token info (including the actual token value)
      const responseData = {
        tokenHash,
        token: tokenValue, // Only returned on creation
        ...tokenData
      };

      const response = new ResponseObject().created(responseData, 'Context sharing token created successfully');
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to create context sharing token');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // List all sharing tokens for the context
  fastify.get('/:contextId/tokens', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['contextId'],
        properties: {
          contextId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { contextId } = request.params;
      const userId = request.user.id;

      // Get the context to ensure user is the owner
      const context = await fastify.contextManager.getContext(userId, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context '${contextId}' not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Only owners can list sharing tokens
      if (context.userId !== userId) {
        const response = new ResponseObject().forbidden('Only context owners can list sharing tokens');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const acl = context.acl || {};
      const tokens = acl.tokens || {};

      // Convert tokens to array format without actual token values
      const tokenList = Object.entries(tokens).map(([tokenHash, tokenData]) => ({
        tokenHash,
        ...tokenData,
        // Remove sensitive data
        token: undefined
      }));

      const response = new ResponseObject().found(tokenList, 'Context sharing tokens retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list context sharing tokens');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Revoke a sharing token
  fastify.delete('/:contextId/tokens/:tokenHash', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['contextId', 'tokenHash'],
        properties: {
          contextId: { type: 'string' },
          tokenHash: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { contextId, tokenHash } = request.params;
      const userId = request.user.id;

      // Get the context to ensure user is the owner
      const context = await fastify.contextManager.getContext(userId, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context '${contextId}' not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Only owners can revoke sharing tokens
      if (context.userId !== userId) {
        const response = new ResponseObject().forbidden('Only context owners can revoke sharing tokens');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const currentACL = context.acl || {};
      const tokens = currentACL.tokens || {};

      if (!tokens[tokenHash]) {
        const response = new ResponseObject().notFound(`Token '${tokenHash}' not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Remove the token
      delete tokens[tokenHash];
      currentACL.tokens = tokens;

      // Save the updated ACL
      await context.updateACL(currentACL);

      const response = new ResponseObject().success({ tokenHash }, 'Context sharing token revoked successfully');
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to revoke context sharing token');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
