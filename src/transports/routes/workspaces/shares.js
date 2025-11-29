'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceAdmin } from '../../middleware/workspace-acl.js';

/**
 * Workspace email-based sharing routes for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceShareRoutes(fastify, options) {

  // Grant email-based access to a workspace
  fastify.post('/:id/shares', {
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
        required: ['userEmail', 'permissions'],
        properties: {
          userEmail: { type: 'string', format: 'email' },
          permissions: {
            type: 'array',
            items: { type: 'string', enum: ['read', 'write', 'admin'] },
            minItems: 1
          },
          description: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Only owners can create email-based shares
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can create email-based shares');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const { userEmail, permissions, description } = request.body;
      const workspace = request.workspace;

      // Verify the user exists on this server
      try {
        const targetUser = await fastify.userManager.getUserByEmail(userEmail);
        if (!targetUser) {
          const responseObject = new ResponseObject().notFound(`User with email '${userEmail}' not found on this server`);
          return reply.code(responseObject.statusCode).send(responseObject.getResponse());
        }
      } catch (error) {
        const responseObject = new ResponseObject().notFound(`User with email '${userEmail}' not found on this server`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Create user share data
      const shareData = {
        permissions,
        description: description || `Shared workspace access for ${userEmail}`,
        grantedAt: new Date().toISOString(),
        grantedBy: request.user.id
      };

      // Update workspace ACL
      const currentACL = workspace.acl || { tokens: {} };
      currentACL.users = currentACL.users || {};
      currentACL.users[userEmail] = shareData;

      // Save the updated ACL
      const success = await fastify.workspaceManager.updateWorkspaceConfig(
        request.user.id,
        workspace.id,
        request.user.id,
        { acl: currentACL }
      );

      if (!success) {
        const responseObject = new ResponseObject().serverError('Failed to save workspace share');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Return share info
      const responseData = {
        userEmail,
        ...shareData
      };

      const responseObject = new ResponseObject().created(responseData, 'Workspace shared successfully with user');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to create workspace share');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // List all email-based shares for the workspace
  fastify.get('/:id/shares', {
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
      // Only owners can list email-based shares
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can list email-based shares');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const workspace = request.workspace;
      const acl = workspace.acl || {};
      const users = acl.users || {};
      
      // Convert users to array format
      const shareList = Object.entries(users).map(([userEmail, shareData]) => ({
        userEmail,
        ...shareData
      }));

      const responseObject = new ResponseObject().found(shareList, 'Workspace shares retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to list workspace shares');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Revoke email-based access to a workspace
  fastify.delete('/:id/shares/:userEmail', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
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
      // Only owners can revoke email-based shares
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can revoke email-based shares');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const { userEmail } = request.params;
      const workspace = request.workspace;

      const currentACL = workspace.acl || {};
      const users = currentACL.users || {};

      if (!users[userEmail]) {
        const responseObject = new ResponseObject().notFound(`Share for user '${userEmail}' not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Remove the share
      delete users[userEmail];
      currentACL.users = users;

      // Save the updated ACL
      const success = await fastify.workspaceManager.updateWorkspaceConfig(
        request.user.id,
        workspace.id,
        request.user.id,
        { acl: currentACL }
      );

      if (!success) {
        const responseObject = new ResponseObject().serverError('Failed to save workspace share changes');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success({ userEmail }, 'Workspace share revoked successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to revoke workspace share');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Update email-based access permissions
  fastify.put('/:id/shares/:userEmail', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
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
        required: ['permissions'],
        properties: {
          permissions: {
            type: 'array',
            items: { type: 'string', enum: ['read', 'write', 'admin'] },
            minItems: 1
          },
          description: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Only owners can update email-based shares
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can update email-based shares');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const { userEmail } = request.params;
      const { permissions, description } = request.body;
      const workspace = request.workspace;

      const currentACL = workspace.acl || {};
      const users = currentACL.users || {};

      if (!users[userEmail]) {
        const responseObject = new ResponseObject().notFound(`Share for user '${userEmail}' not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Update the share
      users[userEmail] = {
        ...users[userEmail],
        permissions,
        description: description !== undefined ? description : users[userEmail].description,
        updatedAt: new Date().toISOString(),
        updatedBy: request.user.id
      };

      currentACL.users = users;

      // Save the updated ACL
      const success = await fastify.workspaceManager.updateWorkspaceConfig(
        request.user.id,
        workspace.id,
        request.user.id,
        { acl: currentACL }
      );

      if (!success) {
        const responseObject = new ResponseObject().serverError('Failed to save workspace share changes');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseData = {
        userEmail,
        ...users[userEmail]
      };

      const responseObject = new ResponseObject().success(responseData, 'Workspace share updated successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());

    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to update workspace share');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
