'use strict';

import { env } from '../../env.js';
import os from 'os';
import ResponseObject from '../ResponseObject.js';

/**
 * Ping route for server status (no authentication required)
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function pingRoute(fastify, options) {
  // Simple ping endpoint
  fastify.get('/ping', async (request, reply) => {
    return { pong: 'Hello, world! (' + process.env.npm_package_name + ' v' + process.env.npm_package_version + ')' };
  });

  // Debug endpoint to check auth and server decorators
  fastify.get('/debug', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    // List all decorators on the server
    const decorators = Object.keys(fastify).filter(key =>
      typeof fastify[key] !== 'function' ||
      key.startsWith('has') ||
      ['decorate', 'register', 'listen'].includes(key)
    );

    // Get user information if authenticated
    const userInfo = request.user ? {
      id: request.user.id,
      email: request.user.email,
      isApiToken: !!request.isApiTokenAuth
    } : null;

    return {
      auth: {
        authenticated: !!request.user,
        method: request.isApiTokenAuth ? 'api_token' : 'jwt',
        user: userInfo
      },
      server: {
        decorators: decorators,
        hasUserManager: fastify.hasDecorator('userManager'),
        hasWorkspaceManager: fastify.hasDecorator('workspaceManager'),
        hasContextManager: fastify.hasDecorator('contextManager'),
        hasAuthService: fastify.hasDecorator('authService')
      }
    };
  });

  fastify.get('/rest/v2/ping', {
  }, async (request, reply) => {
    // Basic system info
    const response = new ResponseObject().success({
      appName: process.env.npm_package_name,
      version: process.env.npm_package_version,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }, 'Server status retrieved successfully');
    return reply.code(response.statusCode).send(response.getResponse());
  });
}
