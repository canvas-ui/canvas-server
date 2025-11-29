'use strict';

import crypto from 'crypto';
import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceAdmin } from '../../middleware/workspace-acl.js';

/**
 * Workspace token sharing routes for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceTokenRoutes(fastify, options) {

  // Create a sharing token for the workspace
  fastify.post('/', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
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
        required: ['permissions'],
        properties: {
          permissions: {
            type: 'array',
            items: { type: 'string', enum: ['read', 'write', 'admin'] },
            minItems: 1
          },
          description: { type: 'string' },
          expiresAt: {
            oneOf: [
              { type: 'string', format: 'date-time' },
              { type: 'null' }
            ]
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Only owners can create sharing tokens
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can create sharing tokens');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const { permissions, description, expiresAt } = request.body;
      const workspace = request.workspace;

      // Generate new API token
      const tokenValue = `canvas-${crypto.randomBytes(24).toString('hex')}`;
      const tokenHash = `sha256:${crypto.createHash('sha256').update(tokenValue).digest('hex')}`;

      // Create token data
      const tokenData = {
        permissions,
        description: description || 'Workspace sharing token',
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt || null
      };

      // Update workspace ACL
      const currentACL = workspace.acl || { tokens: {} };
      currentACL.tokens = currentACL.tokens || {};
      currentACL.tokens[tokenHash] = tokenData;

      // Save the updated ACL
      const success = await fastify.workspaceManager.updateWorkspaceConfig(
        request.user.id,
        workspace.id,
        request.user.id,
        { acl: currentACL }
      );

      if (!success) {
        const responseObject = new ResponseObject().serverError('Failed to save workspace sharing token');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Return token info (including the actual token value)
      const responseData = {
        tokenHash,
        token: tokenValue, // Only returned on creation
        ...tokenData
      };

      const responseObject = new ResponseObject().created(responseData, 'Workspace sharing token created successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to create workspace sharing token');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // List all tokens for the workspace
  fastify.get('/', {
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
      // Only owners can list sharing tokens
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can list sharing tokens');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const workspace = request.workspace;
      const tokens = workspace.acl?.tokens || {};

      // Convert to array and hide sensitive data
      const tokenList = Object.entries(tokens).map(([tokenHash, tokenData]) => ({
        tokenHash,
        permissions: tokenData.permissions,
        description: tokenData.description,
        createdAt: tokenData.createdAt,
        expiresAt: tokenData.expiresAt,
        isExpired: tokenData.expiresAt ? new Date() > new Date(tokenData.expiresAt) : false
      }));

      const responseObject = new ResponseObject().found(tokenList, 'Workspace sharing tokens retrieved successfully', 200, tokenList.length);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to list workspace sharing tokens');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Update a specific token
  fastify.patch('/:tokenHash', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'tokenHash'],
        properties: {
          id: { type: 'string' },
          tokenHash: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        properties: {
          permissions: {
            type: 'array',
            items: { type: 'string', enum: ['read', 'write', 'admin'] },
            minItems: 1
          },
          description: { type: 'string' },
          expiresAt: {
            oneOf: [
              { type: 'string', format: 'date-time' },
              { type: 'null' }
            ]
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Only owners can update sharing tokens
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can update sharing tokens');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const { permissions, description, expiresAt } = request.body;
      const workspace = request.workspace;
      const tokenHash = request.params.tokenHash;

      const currentACL = workspace.acl || { tokens: {} };
      const tokens = currentACL.tokens || {};

      // Check if token exists
      if (!tokens[tokenHash]) {
        const responseObject = new ResponseObject().notFound('Sharing token not found');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Update token data
      const tokenData = tokens[tokenHash];
      if (permissions !== undefined) tokenData.permissions = permissions;
      if (description !== undefined) tokenData.description = description;
      if (expiresAt !== undefined) tokenData.expiresAt = expiresAt;
      tokenData.updatedAt = new Date().toISOString();

      // Save the updated ACL
      const success = await fastify.workspaceManager.updateWorkspaceConfig(
        request.user.id,
        workspace.id,
        request.user.id,
        { acl: currentACL }
      );

      if (!success) {
        const responseObject = new ResponseObject().serverError('Failed to update workspace sharing token');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Return updated token info (without the actual token value)
      const responseData = {
        tokenHash,
        permissions: tokenData.permissions,
        description: tokenData.description,
        createdAt: tokenData.createdAt,
        updatedAt: tokenData.updatedAt,
        expiresAt: tokenData.expiresAt
      };

      const responseObject = new ResponseObject().success(responseData, 'Workspace sharing token updated successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to update workspace sharing token');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Revoke (delete) a specific token
  fastify.delete('/:tokenHash', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'tokenHash'],
        properties: {
          id: { type: 'string' },
          tokenHash: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Only owners can revoke sharing tokens
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can revoke sharing tokens');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const workspace = request.workspace;
      const tokenHash = request.params.tokenHash;

      const currentACL = workspace.acl || { tokens: {} };
      const tokens = currentACL.tokens || {};

      // Check if token exists
      if (!tokens[tokenHash]) {
        const responseObject = new ResponseObject().notFound('Sharing token not found');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Remove the token
      delete tokens[tokenHash];

      // Save the updated ACL
      const success = await fastify.workspaceManager.updateWorkspaceConfig(
        request.user.id,
        workspace.id,
        request.user.id,
        { acl: currentACL }
      );

      if (!success) {
        const responseObject = new ResponseObject().serverError('Failed to revoke workspace sharing token');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().deleted(null, 'Workspace sharing token revoked successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to revoke workspace sharing token');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Get details of a specific token
  fastify.get('/:tokenHash', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'tokenHash'],
        properties: {
          id: { type: 'string' },
          tokenHash: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Only owners can view sharing token details
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can view sharing token details');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const tokenHash = request.params.tokenHash;
      const workspace = request.workspace;
      const tokens = workspace.acl?.tokens || {};

      // Check if token exists
      if (!tokens[tokenHash]) {
        const responseObject = new ResponseObject().notFound('Sharing token not found');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const tokenData = tokens[tokenHash];
      const responseData = {
        tokenHash,
        permissions: tokenData.permissions,
        description: tokenData.description,
        createdAt: tokenData.createdAt,
        updatedAt: tokenData.updatedAt,
        expiresAt: tokenData.expiresAt,
        isExpired: tokenData.expiresAt ? new Date() > new Date(tokenData.expiresAt) : false
      };

      const responseObject = new ResponseObject().found(responseData, 'Workspace sharing token details retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get workspace sharing token details');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
