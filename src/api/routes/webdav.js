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

  // Register shutdown hook for WebDAV server
  fastify.addHook('onClose', async (instance) => {
    debug('WebDAV server shutdown hook triggered');
    try {
      await webdavManager.shutdown();
      debug('WebDAV server shutdown completed');
    } catch (error) {
      debug(`Error during WebDAV server shutdown: ${error.message}`);
    }
  });

  // Register content-type parsers for WebDAV
  // Parse as buffer so we can recreate the stream for the WebDAV server

  // XML parsers for PROPFIND, PROPPATCH
  fastify.addContentTypeParser('application/xml', { parseAs: 'buffer' }, function (request, buffer, done) {
    debug(`Parsed XML body: ${buffer.length} bytes`);
    done(null, buffer);
  });

  fastify.addContentTypeParser('text/xml', { parseAs: 'buffer' }, function (request, buffer, done) {
    debug(`Parsed XML body: ${buffer.length} bytes`);
    done(null, buffer);
  });

  // Wildcard parser for any other content-type (file uploads, etc.)
  fastify.addContentTypeParser('*', { parseAs: 'buffer' }, function (request, buffer, done) {
    debug(`Parsed body (${request.headers['content-type'] || 'no content-type'}): ${buffer.length} bytes`);
    done(null, buffer);
  });

  /**
   * WebDAV OPTIONS handler - handles CORS preflight and capability discovery
   */
  fastify.options('/webdav/:workspaceName/home', {
    preHandler: async (request, reply) => {
      debug(`=== WebDAV OPTIONS PreHandler Start ===`);
      debug(`URL: ${request.url}`);
      debug(`Headers: ${JSON.stringify(request.headers, null, 2)}`);

      // Set WebDAV capability headers
      reply.header('DAV', '1, 2');
      reply.header('MS-Author-Via', 'DAV');
      reply.header('Allow', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');

      // Set CORS headers
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-App-Name, X-Selected-Session, Cache-Control, Depth, If, Overwrite, Destination');
      reply.header('Access-Control-Expose-Headers', 'Authorization, Content-Type, DAV, ETag, Lock-Token');
      reply.header('Access-Control-Allow-Credentials', 'true');
      reply.header('Access-Control-Max-Age', '86400');

      debug(`WebDAV OPTIONS headers set`);
      debug(`=== WebDAV OPTIONS PreHandler End ===`);
    }
  }, async (request, reply) => {
    debug(`=== WebDAV OPTIONS Handler Start ===`);
    debug(`URL: ${request.url}`);
    debug(`Headers: ${JSON.stringify(request.headers, null, 2)}`);

    debug(`WebDAV OPTIONS handler completed`);
    debug(`=== WebDAV OPTIONS Handler End ===`);

    return reply.code(200).send();
  });

  /**
   * Main WebDAV endpoint - handles all WebDAV methods except OPTIONS
   * Path format: /webdav/:workspaceName/home
   *
   * Supports HTTP methods: PROPFIND, PROPPATCH, MKCOL, GET, HEAD,
   * POST, PUT, DELETE, COPY, MOVE, LOCK, UNLOCK
   */
  fastify.route({
    method: [
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
    url: '/webdav/:workspaceName/home',
    bodyLimit: 8589934592, // 8GB limit for large file uploads
    // Custom authentication - we'll extract user from token
    preHandler: async (request, reply) => {
      try {
        // Extract authorization header
        const authHeader = request.headers.authorization;

        if (!authHeader) {
          debug('No authorization header provided');
          // Set WWW-Authenticate headers for Windows WebDAV clients
          reply.header('WWW-Authenticate', 'Basic realm="Canvas WebDAV", Bearer realm="Canvas WebDAV"');
          const response = new ResponseObject().unauthorized('Authentication required');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        let token = null;

        // Support Bearer token
        if (authHeader.startsWith('Bearer ')) {
          token = authHeader.substring(7);
          debug('Bearer token authentication detected');
        }
        // Support Basic Auth (username:password or username:token)
        else if (authHeader.startsWith('Basic ')) {
          try {
            const base64Credentials = authHeader.substring(6);
            const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
            const [username, password] = credentials.split(':');
            debug(`Basic auth detected for user: ${username}`);

            // Check if password is an API token (starts with canvas-)
            if (password.startsWith('canvas-')) {
              token = password;
              debug('Using password as API token');
            } else {
              // Try to authenticate with username/password
              debug('Attempting username/password authentication');
              try {
                const user = await fastify.userManager.getUserByEmail(username);

                // Verify password
                const passwordValid = await fastify.authService.verifyPassword(user.id, password);
                if (!passwordValid) {
                  debug(`Invalid password for user: ${username}`);
                  const response = new ResponseObject().unauthorized('Invalid username or password');
                  return reply.code(response.statusCode).send(response.getResponse());
                }

                debug(`Password authentication successful for user: ${username}`);
                // Set token to null since we'll handle this differently
                token = null;
                request.user = {
                  id: user.id,
                  name: user.name || user.email,
                  email: user.email,
                  userType: user.userType || 'user',
                  status: user.status || 'active'
                };
              } catch (userError) {
                debug(`User not found or error: ${userError.message}`);
                const response = new ResponseObject().unauthorized('Invalid username or password');
                return reply.code(response.statusCode).send(response.getResponse());
              }
            }
          } catch (e) {
            debug(`Failed to parse Basic auth: ${e.message}`);
            const response = new ResponseObject().unauthorized('Invalid authentication format');
            return reply.code(response.statusCode).send(response.getResponse());
          }
        }
        // Support Digest Auth (for Windows compatibility)
        else if (authHeader.startsWith('Digest ')) {
          debug('Digest authentication not yet implemented, falling back to Basic');
          reply.header('WWW-Authenticate', 'Digest realm="Canvas WebDAV", qop="auth", nonce="' + Date.now() + '"');
          const response = new ResponseObject().unauthorized('Digest authentication not supported, please use Basic or Bearer');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        if (!token && !request.user) {
          debug('No valid token or user found');
          const response = new ResponseObject().unauthorized('Invalid authentication credentials');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        // Verify token using authService (only if we have a token)
        if (token) {
          const result = await fastify.authService.verifyToken(token);

          if (!result || !result.valid) {
            debug(`Token verification failed: ${result?.message || 'Invalid token'}`);
            const response = new ResponseObject().unauthorized(result?.message || 'Invalid token');
            return reply.code(response.statusCode).send(response.getResponse());
          }

          // Attach user to request
          request.user = result.user;
          debug(`User authenticated via token: ${result.user.id}`);
        } else {
          debug(`User authenticated via password: ${request.user.id}`);
        }

        // Verify workspace access
        const workspaceName = request.params.workspaceName;
        const workspace = await fastify.workspaceManager.getWorkspace(request.user.id, workspaceName);

        if (!workspace) {
          debug(`Workspace not found: ${workspaceName}`);
          const response = new ResponseObject().notFound(`Workspace not found: ${workspaceName}`);
          return reply.code(response.statusCode).send(response.getResponse());
        }

        // Check access permissions
        const hasAccess = workspace.owner === request.user.id ||
          (workspace.acl || []).some(entry =>
            entry.userId === request.user.id &&
            entry.permissions?.includes('read')
          );

        if (!hasAccess) {
          debug(`User ${request.user.id} does not have access to workspace ${workspaceName}`);
          const response = new ResponseObject().forbidden('Access denied to workspace');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        debug(`Access granted to workspace ${workspaceName} for user ${request.user.id}`);
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

        debug(`=== WebDAV Route Handler Start ===`);
        debug(`Method: ${request.method}`);
        debug(`URL: ${request.url}`);
        debug(`Params: ${JSON.stringify(request.params, null, 2)}`);
        debug(`Query: ${JSON.stringify(request.query, null, 2)}`);
        debug(`Headers: ${JSON.stringify(request.headers, null, 2)}`);
        debug(`User: ${userId}, Workspace: ${workspaceName}`);

        // Tell Fastify we'll handle the response manually
        debug(`Hijacking response...`);
        reply.hijack();

        // Delegate to WebDAV server manager
        debug(`Delegating to WebDAV server manager...`);
        await webdavManager.handleRequest(request, reply, userId, workspaceName);

        debug(`WebDAV route handler completed successfully`);
        debug(`=== WebDAV Route Handler End ===`);
      } catch (error) {
        debug(`=== WebDAV Route Handler Error ===`);
        debug(`Error: ${error.message}`);
        debug(`Stack trace: ${error.stack}`);
        debug(`Reply sent: ${reply.sent}`);
        debug(`Headers sent: ${reply.raw.headersSent}`);
        debug(`=== End Route Handler Error ===`);

        fastify.log.error(`WebDAV handler error: ${error.message}`);

        // Only send error if response hasn't been sent yet
        if (!reply.raw.headersSent) {
          debug(`Sending error response from route handler...`);
          reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
          reply.raw.end(JSON.stringify({
            error: 'Internal Server Error',
            message: error.message
          }));
        }
      }
    }
  });

  /**
   * WebDAV OPTIONS handler for subdirectories and files
   */
  fastify.options('/webdav/:workspaceName/home/*', async (request, reply) => {
    debug(`=== WebDAV OPTIONS Handler Start (Wildcard) ===`);
    debug(`URL: ${request.url}`);
    debug(`Headers: ${JSON.stringify(request.headers, null, 2)}`);

    // Set WebDAV capability headers
    reply.header('DAV', '1, 2');
    reply.header('MS-Author-Via', 'DAV');
    reply.header('Allow', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');

    // Set CORS headers
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, POST, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-App-Name, X-Selected-Session, Cache-Control, Depth, If, Overwrite, Destination');
    reply.header('Access-Control-Expose-Headers', 'Authorization, Content-Type, DAV, ETag, Lock-Token');
    reply.header('Access-Control-Allow-Credentials', 'true');
    reply.header('Access-Control-Max-Age', '86400');

    debug(`WebDAV OPTIONS headers set (Wildcard)`);
    debug(`=== WebDAV OPTIONS Handler End (Wildcard) ===`);

    return reply.code(200).send();
  });

  /**
   * WebDAV endpoint for subdirectories and files
   * Path format: /webdav/:workspaceName/home/*
   */
  fastify.route({
    method: [
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
    bodyLimit: 8589934592, // 8GB limit for large file uploads
    // Custom authentication - we'll extract user from token
    preHandler: async (request, reply) => {
      try {
        // Extract authorization header
        const authHeader = request.headers.authorization;

        if (!authHeader) {
          debug('No authorization header provided');
          // Set WWW-Authenticate headers for Windows WebDAV clients
          reply.header('WWW-Authenticate', 'Basic realm="Canvas WebDAV", Bearer realm="Canvas WebDAV"');
          const response = new ResponseObject().unauthorized('Authentication required');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        let token = null;

        // Support Bearer token
        if (authHeader.startsWith('Bearer ')) {
          token = authHeader.substring(7);
          debug('Bearer token authentication detected');
        }
        // Support Basic Auth (username:password or username:token)
        else if (authHeader.startsWith('Basic ')) {
          try {
            const base64Credentials = authHeader.substring(6);
            const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
            const [username, password] = credentials.split(':');
            debug(`Basic auth detected for user: ${username}`);

            // Check if password is an API token (starts with canvas-)
            if (password.startsWith('canvas-')) {
              token = password;
              debug('Using password as API token');
            } else {
              // Try to authenticate with username/password
              debug('Attempting username/password authentication');
              try {
                const user = await fastify.userManager.getUserByEmail(username);

                // Verify password
                const passwordValid = await fastify.authService.verifyPassword(user.id, password);
                if (!passwordValid) {
                  debug(`Invalid password for user: ${username}`);
                  const response = new ResponseObject().unauthorized('Invalid username or password');
                  return reply.code(response.statusCode).send(response.getResponse());
                }

                debug(`Password authentication successful for user: ${username}`);
                // Set token to null since we'll handle this differently
                token = null;
                request.user = {
                  id: user.id,
                  name: user.name || user.email,
                  email: user.email,
                  userType: user.userType || 'user',
                  status: user.status || 'active'
                };
              } catch (userError) {
                debug(`User not found or error: ${userError.message}`);
                const response = new ResponseObject().unauthorized('Invalid username or password');
                return reply.code(response.statusCode).send(response.getResponse());
              }
            }
          } catch (e) {
            debug(`Failed to parse Basic auth: ${e.message}`);
            const response = new ResponseObject().unauthorized('Invalid authentication format');
            return reply.code(response.statusCode).send(response.getResponse());
          }
        }
        // Support Digest Auth (for Windows compatibility)
        else if (authHeader.startsWith('Digest ')) {
          debug('Digest authentication not yet implemented, falling back to Basic');
          reply.header('WWW-Authenticate', 'Digest realm="Canvas WebDAV", qop="auth", nonce="' + Date.now() + '"');
          const response = new ResponseObject().unauthorized('Digest authentication not supported, please use Basic or Bearer');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        if (!token && !request.user) {
          debug('No valid token or user found');
          const response = new ResponseObject().unauthorized('Invalid authentication credentials');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        // Verify token using authService (only if we have a token)
        if (token) {
          const result = await fastify.authService.verifyToken(token);

          if (!result || !result.valid) {
            debug(`Token verification failed: ${result?.message || 'Invalid token'}`);
            const response = new ResponseObject().unauthorized(result?.message || 'Invalid token');
            return reply.code(response.statusCode).send(response.getResponse());
          }

          // Attach user to request
          request.user = result.user;
          debug(`User authenticated via token: ${result.user.id}`);
        } else {
          debug(`User authenticated via password: ${request.user.id}`);
        }

        // Verify workspace access
        const workspaceName = request.params.workspaceName;
        const workspace = await fastify.workspaceManager.getWorkspace(request.user.id, workspaceName);

        if (!workspace) {
          debug(`Workspace not found: ${workspaceName}`);
          const response = new ResponseObject().notFound(`Workspace not found: ${workspaceName}`);
          return reply.code(response.statusCode).send(response.getResponse());
        }

        // Check access permissions
        const hasAccess = workspace.owner === request.user.id ||
          (workspace.acl || []).some(entry =>
            entry.userId === request.user.id &&
            entry.permissions?.includes('read')
          );

        if (!hasAccess) {
          debug(`User ${request.user.id} does not have access to workspace ${workspaceName}`);
          const response = new ResponseObject().forbidden('Access denied to workspace');
          return reply.code(response.statusCode).send(response.getResponse());
        }

        debug(`Access granted to workspace ${workspaceName} for user ${request.user.id}`);
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

        debug(`=== WebDAV Route Handler Start (Wildcard) ===`);
        debug(`Method: ${request.method}`);
        debug(`URL: ${request.url}`);
        debug(`Params: ${JSON.stringify(request.params, null, 2)}`);
        debug(`Query: ${JSON.stringify(request.query, null, 2)}`);
        debug(`Headers: ${JSON.stringify(request.headers, null, 2)}`);
        debug(`User: ${userId}, Workspace: ${workspaceName}`);

        // Tell Fastify we'll handle the response manually
        debug(`Hijacking response...`);
        reply.hijack();

        // Delegate to WebDAV server manager
        debug(`Delegating to WebDAV server manager...`);
        await webdavManager.handleRequest(request, reply, userId, workspaceName);

        debug(`WebDAV route handler completed successfully`);
        debug(`=== WebDAV Route Handler End (Wildcard) ===`);
      } catch (error) {
        debug(`=== WebDAV Route Handler Error (Wildcard) ===`);
        debug(`Error: ${error.message}`);
        debug(`Stack trace: ${error.stack}`);
        debug(`Reply sent: ${reply.sent}`);
        debug(`Headers sent: ${reply.raw.headersSent}`);
        debug(`=== End Route Handler Error (Wildcard) ===`);

        fastify.log.error(`WebDAV handler error: ${error.message}`);

        // Only send error if response hasn't been sent yet
        if (!reply.raw.headersSent) {
          debug(`Sending error response from route handler...`);
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

