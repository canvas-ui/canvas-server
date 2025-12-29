'use strict';

import ResponseObject from '../../ResponseObject.js';

/**
 * Role Routes
 * Provides REST endpoints for role lifecycle management
 */
export default async function roleRoutes(fastify, options) {
  const { roles, users, workspaceManager } = fastify;

  if (!roles) {
    throw new Error('Roles service is required');
  }

  /**
   * List roles
   * GET /roles?type=global&status=running
   */
  fastify.get('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const { type, userId, workspaceId, status } = request.query;
      const requestingUserId = request.user?.id;

      const filters = {};
      if (type) filters.type = type;
      if (userId) filters.userId = userId;
      if (workspaceId) filters.workspaceId = workspaceId;
      if (status) filters.status = status;

      const roleList = roles.list(filters);

      // Filter based on user permissions
      const accessibleRoles = roleList.filter(role => {
        // Global roles visible to all authenticated users
        if (role.type === 'global') return true;
        // Workspace roles only visible to owner
        return role.userId === requestingUserId;
      });

      const response = new ResponseObject().success({
        roles: accessibleRoles,
        total: accessibleRoles.length
      });
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().error(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Create new role
   * POST /roles
   */
  fastify.post('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const { template, name, type, userId, workspaceId, config } = request.body;
      const requestingUserId = request.user?.id;

      if (!template || !name || !type) {
        const response = new ResponseObject().badRequest('template, name, and type are required');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Check permissions
      if (type === 'global') {
        const user = await users.get(requestingUserId);
        if (user.userType !== 'admin') {
          const response = new ResponseObject().forbidden('Only administrators can create global roles');
          return reply.code(response.statusCode).send(response.getResponse());
        }
      }

      const roleConfig = await roles.create(template, {
        name,
        type,
        userId: userId || requestingUserId,
        workspaceId,
        config
      });

      const response = new ResponseObject().created({ role: roleConfig });
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().error(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Get role by ID
   * GET /roles/:roleId
   */
  fastify.get('/:roleId', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const { roleId } = request.params;
      const requestingUserId = request.user?.id;

      const role = await roles.get(roleId, requestingUserId);
      if (!role) {
        const response = new ResponseObject().notFound('Role not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().found({ role: role.toJSON() });
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const statusCode = error.message.includes('not found') ? 404 : 500;
      const response = new ResponseObject().error(error.message, null, statusCode);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Start role
   * POST /roles/:roleId/start
   */
  fastify.post('/:roleId/start', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const { roleId } = request.params;
      const requestingUserId = request.user?.id;

      const role = await roles.start(roleId, requestingUserId);

      const response = new ResponseObject().success({ role: role.toJSON() });
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().error(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Stop role
   * POST /roles/:roleId/stop
   */
  fastify.post('/:roleId/stop', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const { roleId } = request.params;
      const requestingUserId = request.user?.id;

      await roles.stop(roleId, requestingUserId);

      const response = new ResponseObject().success({ message: 'Role stopped successfully' });
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().error(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Restart role
   * POST /roles/:roleId/restart
   */
  fastify.post('/:roleId/restart', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const { roleId } = request.params;
      const requestingUserId = request.user?.id;

      const role = await roles.get(roleId, requestingUserId);
      if (!role) {
        const response = new ResponseObject().notFound('Role not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      await role.restart();

      const response = new ResponseObject().success({ role: role.toJSON() });
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().error(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Delete role
   * DELETE /roles/:roleId
   */
  fastify.delete('/:roleId', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const { roleId } = request.params;
      const { force } = request.query;
      const requestingUserId = request.user?.id;

      await roles.remove(roleId, requestingUserId, force === 'true');

      const response = new ResponseObject().deleted({ message: 'Role deleted successfully' });
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().error(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Get role logs
   * GET /roles/:roleId/logs?tail=100
   */
  fastify.get('/:roleId/logs', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const { roleId } = request.params;
      const { tail } = request.query;
      const requestingUserId = request.user?.id;

      const role = await roles.get(roleId, requestingUserId);
      if (!role) {
        const response = new ResponseObject().notFound('Role not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const logStream = await role.getLogs({
        tail: parseInt(tail) || 100,
        follow: false
      });

      // Collect logs
      let logs = '';
      logStream.on('data', chunk => logs += chunk);

      return new Promise((resolve) => {
        logStream.on('end', () => {
          const logLines = logs.split('\n').filter(line => line.trim());
          const response = new ResponseObject().success({ logs: logLines });
          resolve(reply.code(response.statusCode).send(response.getResponse()));
        });
      });
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().error(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Get role stats
   * GET /roles/:roleId/stats
   */
  fastify.get('/:roleId/stats', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const { roleId } = request.params;
      const requestingUserId = request.user?.id;

      const role = await roles.get(roleId, requestingUserId);
      if (!role) {
        const response = new ResponseObject().notFound('Role not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const stats = await role.getStats();

      const response = new ResponseObject().success({ stats });
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().error(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  /**
   * Get role health
   * GET /roles/:roleId/health
   */
  fastify.get('/:roleId/health', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    try {
      const { roleId } = request.params;
      const requestingUserId = request.user?.id;

      const role = await roles.get(roleId, requestingUserId);
      if (!role) {
        const response = new ResponseObject().notFound('Role not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      let health = { status: 'unknown' };
      if (role.getHealthStatus) {
        health = await role.getHealthStatus();
      } else {
        health = {
          status: role.isRunning ? 'healthy' : 'stopped'
        };
      }

      const response = new ResponseObject().success({ health });
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().error(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
