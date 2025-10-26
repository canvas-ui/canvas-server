'use strict';

import { WebDAVServerManager } from '../webdav/server.js';
import ResponseObject from '../ResponseObject.js';
import { createDebug } from '../../utils/log/index.js';

const debug = createDebug('webdav:routes');

/**
 * WebDAV Routes for workspace home directory access
 * Provides WebDAV protocol access to workspace /home folders
 *
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function webdavRoutes(fastify, options) {
  // Initialize WebDAV server manager
  const webdavManager = new WebDAVServerManager(
    fastify.userManager,
    fastify.workspaceManager
  );

  await webdavManager.initialize();
  debug('WebDAV routes initialized');

  // Decorate fastify with webdavManager for potential future use
  fastify.decorate('webdavManager', webdavManager);

  /**
   * Main WebDAV endpoint - handles all WebDAV methods
   * Path format: /webdav/:workspaceName/home/*
   *
   * Supports HTTP methods: OPTIONS, PROPFIND, PROPPATCH, MKCOL, GET, HEAD,
   * POST, PUT, DELETE, COPY, MOVE, LOCK, UNLOCK
   */
  fastify.route({
    method: [
      'OPTIONS',    // CORS preflight and capability discovery
      'GET',        // Download files
      'HEAD',       // Get metadata without body
      'POST',       // Upload (some clients use POST)
      'PUT',        // Upload/update files
      'DELETE',     // Delete files/folders
      'PROPFIND',   // List directory contents
      'PROPPATCH',  // Update properties
      'MKCOL',      // Create directory
      'COPY',       // Copy files/folders
      'MOVE',       // Move/rename files/folders
      'LOCK',       // Lock files (Class 2 WebDAV)
      'UNLOCK'      // Unlock files (Class 2 WebDAV)
    ],
    url: '/webdav/:workspaceName/home/*',
    // Custom authentication - we'll extract user from token
    preHandler: async (request, reply) => {
      try {
        // Extract authorization header
        const authHeader = request.headers.authorization;

        if (!authHeader) {
          debug('No authorization header provided');
          const response = new ResponseObject().unauthorized('Authentication required');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        let token = null;

        // Support Bearer token
        if (authHeader.startsWith('Bearer ')) {
          token = authHeader.substring(7);
        }
        // Support Basic Auth (password = token)
        else if (authHeader.startsWith('Basic ')) {
          try {
            const base64Credentials = authHeader.substring(6);
            const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
            const [, password] = credentials.split(':');
            token = password;
          } catch (e) {
            debug(`Failed to parse Basic auth: ${e.message}`);
            const response = new ResponseObject().unauthorized('Invalid authentication format');
            return reply.code(response.statusCode).send(response.getResponse());
          }
        }

        if (!token) {
          debug('No valid token found');
          const response = new ResponseObject().unauthorized('Invalid authentication credentials');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        // Verify token using authService
        const result = await fastify.authService.verifyToken(token);

        if (!result || !result.valid) {
          debug(`Token verification failed: ${result?.message || 'Invalid token'}`);
          const response = new ResponseObject().unauthorized(result?.message || 'Invalid token');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        // Attach user to request
        request.user = result.user;
        debug(`User authenticated: ${result.user.id}`);

        // Verify workspace access
        const workspaceName = request.params.workspaceName;
        const workspace = await fastify.workspaceManager.getWorkspace(result.user.id, workspaceName);

        if (!workspace) {
          debug(`Workspace not found: ${workspaceName}`);
          const response = new ResponseObject().notFound(`Workspace not found: ${workspaceName}`);
          return reply.code(response.statusCode).send(response.getResponse());
        }

        // Check access permissions
        const hasAccess = workspace.owner === result.user.id ||
          (workspace.acl || []).some(entry =>
            entry.userId === result.user.id &&
            entry.permissions?.includes('read')
          );

        if (!hasAccess) {
          debug(`User ${result.user.id} does not have access to workspace ${workspaceName}`);
          const response = new ResponseObject().forbidden('Access denied to workspace');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        debug(`Access granted to workspace ${workspaceName} for user ${result.user.id}`);
      } catch (error) {
        fastify.log.error(`WebDAV authentication error: ${error.message}`);
        const response = new ResponseObject().serverError('Authentication error');
        return reply.code(response.statusCode).send(response.getResponse());
      }
    },
    handler: async (request, reply) => {
      try {
        const workspaceName = request.params.workspaceName;
        const userId = request.user.id;

        debug(`WebDAV request: ${request.method} ${request.url} (user: ${userId}, workspace: ${workspaceName})`);

        // Tell Fastify we'll handle the response manually
        reply.hijack();

        // Delegate to WebDAV server manager
        await webdavManager.handleRequest(request, reply, userId, workspaceName);
      } catch (error) {
        fastify.log.error(`WebDAV handler error: ${error.message}`);

        // Only send error if response hasn't been sent yet
        if (!reply.raw.headersSent) {
          reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
          reply.raw.end(JSON.stringify({
            error: 'Internal Server Error',
            message: error.message
          }));
        }
      }
    }
  });

  // Health check endpoint for WebDAV service
  fastify.get('/webdav/health', async (request, reply) => {
    return {
      status: 'ok',
      service: 'webdav',
      timestamp: new Date().toISOString()
    };
  });
}

