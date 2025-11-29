'use strict';

import ResponseObject from '../../ResponseObject.js';
import { extractToken } from './token-auth.js';

/**
 * Token Service - Centralized token operations
 */
class TokenService {
  constructor(workspaceManager, contextManager) {
    this.workspaceManager = workspaceManager;
    this.contextManager = contextManager;
  }

  /**
   * Generate token hash from raw token
   */
  async hashToken(token) {
    const crypto = await import('crypto');
    return `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
  }

  /**
   * Check if token is expired
   */
  isTokenExpired(tokenData) {
    return tokenData.expiresAt ? new Date() > new Date(tokenData.expiresAt) : false;
  }

  /**
   * Check if token usage limit is reached
   */
  isUsageLimitReached(tokenData) {
    return tokenData.maxUses ? (tokenData.currentUses || 0) >= tokenData.maxUses : false;
  }

  /**
   * Find resource by token - searches both workspaces and contexts
   */
  async findResourceByToken(token) {
    const tokenHash = await this.hashToken(token);

    // Search workspaces first
    const workspaceResult = await this.findWorkspaceByToken(tokenHash);
    if (workspaceResult) return workspaceResult;

    // Search contexts
    return await this.findContextByToken(tokenHash);
  }

  /**
   * Find workspace by token hash
   */
  async findWorkspaceByToken(tokenHash) {
    const allWorkspaces = this.workspaceManager.getAllWorkspacesWithKeys();

    for (const [indexKey, workspaceEntry] of Object.entries(allWorkspaces)) {
      const tokenData = workspaceEntry.acl?.tokens?.[tokenHash];
      if (tokenData) {
        return {
          resource: workspaceEntry,
          tokenData,
          resourceType: 'workspace',
          resourceId: workspaceEntry.id
        };
      }
    }
    return null;
  }

  /**
   * Find context by token hash
   */
  async findContextByToken(tokenHash) {
    // Use proper context manager API
    const result = this.contextManager.findContextByTokenHash(tokenHash);

    if (result) {
      return {
        resource: result,
        tokenData: result.tokenData,
        resourceType: 'context',
        resourceId: result.id
      };
    }
    return null;
  }

  /**
   * Validate token for specific resource and permission
   */
  async validateToken(token, resourceType, resourceId, requiredPermission) {
    const tokenHash = await this.hashToken(token);
    let resource = null;

    if (resourceType === 'workspace') {
      const result = await this.findWorkspaceByToken(tokenHash);
      if (result && result.resourceId === resourceId) {
        resource = result;
      }
    } else if (resourceType === 'context') {
      const result = await this.findContextByToken(tokenHash);
      if (result && result.resourceId === resourceId) {
        resource = result;
      }
    }

    if (!resource) {
      return { valid: false, reason: 'Token not found for resource' };
    }

    const { tokenData } = resource;

    // Check expiration
    if (this.isTokenExpired(tokenData)) {
      return { valid: false, reason: 'Token expired' };
    }

    // Check usage limits
    if (this.isUsageLimitReached(tokenData)) {
      return { valid: false, reason: 'Usage limit reached' };
    }

    // Check permissions
    if (!tokenData.permissions.includes(requiredPermission)) {
      return { valid: false, reason: 'Insufficient permissions' };
    }

    return {
      valid: true,
      resource: resource.resource,
      tokenData,
      resourceType,
      resourceId
    };
  }

  /**
   * Revoke token for user-owned resources
   */
  async revokeToken(token, userId) {
    const tokenHash = await this.hashToken(token);

    // Search user's workspaces
    const allWorkspaces = this.workspaceManager.getAllWorkspacesWithKeys();
    for (const [indexKey, workspaceEntry] of Object.entries(allWorkspaces)) {
      if (workspaceEntry.owner === userId && workspaceEntry.acl?.tokens?.[tokenHash]) {
        delete workspaceEntry.acl.tokens[tokenHash];

        await this.workspaceManager.updateWorkspaceConfig(
          userId,
          workspaceEntry.id,
          userId,
          { acl: workspaceEntry.acl }
        );

        return {
          revoked: true,
          resourceType: 'workspace',
          resourceId: workspaceEntry.id
        };
      }
    }

    // Search user's contexts using proper API
    const userContexts = this.contextManager.getContextsForUser(userId);
    for (const contextData of userContexts) {
      if (contextData.acl?.tokens?.[tokenHash]) {
        delete contextData.acl.tokens[tokenHash];

        const context = await this.contextManager.getContext(userId, contextData.id);
        if (context) {
          await context.updateACL(contextData.acl);
        }

        return {
          revoked: true,
          resourceType: 'context',
          resourceId: contextData.id
        };
      }
    }

    return { revoked: false, reason: 'Token not found or not owned by user' };
  }

  /**
   * Format token data for API response
   */
  formatTokenData(tokenData) {
    return {
      permissions: tokenData.permissions,
      description: tokenData.description,
      type: tokenData.type || 'standard',
      createdAt: tokenData.createdAt,
      expiresAt: tokenData.expiresAt,
      currentUses: tokenData.currentUses || 0,
      maxUses: tokenData.maxUses,
      isExpired: this.isTokenExpired(tokenData),
      isUsageLimitReached: this.isUsageLimitReached(tokenData)
    };
  }
}

/**
 * Public token management routes for shared resources
 */
export default async function pubTokenRoutes(fastify, options) {
  const tokenService = new TokenService(fastify.workspaceManager, fastify.contextManager);

  // Validate a token for any resource type
  fastify.post('/validate', {
    schema: {
      body: {
        type: 'object',
        required: ['token', 'resourceType', 'resourceId'],
        properties: {
          token: { type: 'string' },
          resourceType: { type: 'string', enum: ['workspace', 'context'] },
          resourceId: { type: 'string' },
          requiredPermission: {
            type: 'string',
            enum: ['read', 'write', 'admin', 'documentRead', 'documentWrite', 'documentReadWrite']
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { token, resourceType, resourceId, requiredPermission } = request.body;

      const result = await tokenService.validateToken(token, resourceType, resourceId, requiredPermission);

      if (!result.valid) {
        const response = new ResponseObject().forbidden(result.reason);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const responseData = {
        valid: true,
        resourceType,
        resourceId,
        requiredPermission,
        tokenData: tokenService.formatTokenData(result.tokenData)
      };

      const response = new ResponseObject().success(responseData, 'Token validation successful');
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(`Token validation error: ${error.message}`);
      const response = new ResponseObject().serverError('Token validation failed');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get token info
  fastify.get('/info', {
    schema: {
      querystring: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { token } = request.query;

      const result = await tokenService.findResourceByToken(token);

      if (!result) {
        const response = new ResponseObject().notFound('Token not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const responseData = {
        resourceType: result.resourceType,
        resourceId: result.resourceId,
        resourceName: result.resource.name || result.resource.label,
        tokenData: tokenService.formatTokenData(result.tokenData)
      };

      const response = new ResponseObject().found(responseData, 'Token info retrieved');
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(`Token info error: ${error.message}`);
      const response = new ResponseObject().serverError('Failed to get token info');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Revoke a token
  fastify.delete('/revoke', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      if (!request.user?.id) {
        const response = new ResponseObject().unauthorized('Authentication required');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const { token } = request.body;
      const result = await tokenService.revokeToken(token, request.user.id);

      if (!result.revoked) {
        const response = new ResponseObject().notFound(result.reason);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const responseData = {
        resourceType: result.resourceType,
        resourceId: result.resourceId
      };

      const response = new ResponseObject().success(responseData, 'Token revoked successfully');
      return reply.code(response.statusCode).send(response.getResponse());

    } catch (error) {
      fastify.log.error(`Token revocation error: ${error.message}`);
      const response = new ResponseObject().serverError('Failed to revoke token');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
