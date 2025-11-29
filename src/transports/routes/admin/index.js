'use strict';

import ResponseObject from '../../ResponseObject.js';
import { validateUser } from '../../auth/strategies.js';

/**
 * Admin routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function adminRoutes(fastify, options) {

  /**
   * Middleware to check if user is admin
   */
  const requireAdmin = async (request, reply) => {
    if (!validateUser(request.user, ['id', 'email'])) {
      const response = new ResponseObject().unauthorized('Valid authentication required');
      return reply.code(response.statusCode).send(response.getResponse());
    }

    try {
      const user = await fastify.userManager.getUser(request.user.id);
      if (!user.isAdmin()) {
        const response = new ResponseObject().forbidden('Admin access required');
        return reply.code(response.statusCode).send(response.getResponse());
      }
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to verify admin privileges');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  };

  // User Management Routes

  // List all users (admin only)
  fastify.get('/users', {
    onRequest: [fastify.authenticate, requireAdmin]
  }, async (request, reply) => {
    try {
      const { status, userType } = request.query;
      const users = await fastify.userManager.listUsers({ status, userType });

      const response = new ResponseObject().found(users, 'Users retrieved successfully', 200, users.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list users');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Create user (admin only)
  fastify.post('/users', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'email'],
        properties: {
          name: {
            type: 'string',
            minLength: 3,
            maxLength: 39,
            pattern: '^[a-z0-9_-]+$',
            description: 'Username (3-39 chars, lowercase letters, numbers, underscores, hyphens only)'
          },
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          userType: { type: 'string', enum: ['user', 'admin'], default: 'user' },
          status: { type: 'string', enum: ['active', 'inactive', 'pending', 'deleted'], default: 'active' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { name, email, password, userType = 'user', status = 'active' } = request.body;

      // Create user
      const user = await fastify.userManager.createUser({
        name,
        email,
        userType,
        status
      });

      // Set password if provided
      if (password) {
        await fastify.authService.setPassword(user.id, password);
      }

      const response = new ResponseObject().created({
        id: user.id,
        name: user.name,
        email: user.email,
        userType: user.userType,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }, 'User created successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to create user');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get user by ID (admin only)
  fastify.get('/users/:userId', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const user = await fastify.userManager.getUser(request.params.userId);

      const response = new ResponseObject().found({
        id: user.id,
        name: user.name,
        email: user.email,
        userType: user.userType,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }, 'User retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().notFound('User not found');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Update user (admin only)
  fastify.put('/users/:userId', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string' }
        }
      },
      body: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 3,
            maxLength: 39,
            pattern: '^[a-z0-9_-]+$'
          },
          email: { type: 'string', format: 'email' },
          userType: { type: 'string', enum: ['user', 'admin'] },
          status: { type: 'string', enum: ['active', 'inactive', 'pending', 'deleted'] }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const user = await fastify.userManager.updateUser(request.params.userId, request.body);

      const response = new ResponseObject().success({
        id: user.id,
        name: user.name,
        email: user.email,
        userType: user.userType,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }, 'User updated successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to update user');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Delete user (admin only)
  fastify.delete('/users/:userId', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Prevent admin from deleting themselves
      if (request.params.userId === request.user.id) {
        const response = new ResponseObject().badRequest('Cannot delete your own account');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await fastify.userManager.deleteUser(request.params.userId);

      const response = new ResponseObject().success(true, 'User deleted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to delete user');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Workspace Management Routes

  // List all workspaces (admin only)
  fastify.get('/workspaces', {
    onRequest: [fastify.authenticate, requireAdmin]
  }, async (request, reply) => {
    try {
      // Get all users first
      const users = await fastify.userManager.listUsers();
      let allWorkspaces = [];

      // Get workspaces for each user
      for (const user of users) {
        try {
          const userWorkspaces = await fastify.workspaceManager.listUserWorkspaces(user.id);
          // Add owner info to each workspace
          const workspacesWithOwner = userWorkspaces.map(ws => ({
            ...ws,
            ownerName: user.name,
            ownerEmail: user.email
          }));
          allWorkspaces = allWorkspaces.concat(workspacesWithOwner);
        } catch (error) {
          // Skip users that have workspace access issues
          fastify.log.warn(`Failed to get workspaces for user ${user.id}: ${error.message}`);
        }
      }

      const response = new ResponseObject().found(allWorkspaces, 'All workspaces retrieved successfully', 200, allWorkspaces.length);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list all workspaces');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Create workspace for user (admin only)
  fastify.post('/workspaces', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['userId', 'name'],
        properties: {
          userId: { type: 'string' },
          name: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string' },
          color: { type: 'string', pattern: '^#[0-9A-Fa-f]{3,6}$' },
          type: { type: 'string', enum: ['workspace', 'universe'] },
          metadata: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { userId, name, label, description, color, type = 'workspace', metadata } = request.body;

      // Verify the user exists
      await fastify.userManager.getUser(userId);

      const workspace = await fastify.workspaceManager.createWorkspace(
        userId,
        name,
        {
          owner: userId,
          type,
          label: label || name,
          description: description || '',
          color,
          metadata
        }
      );

      const response = new ResponseObject().created(workspace, 'Workspace created successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to create workspace');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Delete workspace (admin only)
  fastify.delete('/workspaces/:workspaceId', {
    onRequest: [fastify.authenticate, requireAdmin],
    schema: {
      params: {
        type: 'object',
        required: ['workspaceId'],
        properties: {
          workspaceId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      // Get workspace to verify it exists and get owner info
      const workspace = await fastify.workspaceManager.getWorkspace(request.params.workspaceId);

      // Delete the workspace
      await fastify.workspaceManager.deleteWorkspace(workspace.owner, request.params.workspaceId);

      const response = new ResponseObject().success(true, 'Workspace deleted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to delete workspace');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
