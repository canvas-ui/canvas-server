'use strict';

import Fastify from 'fastify';
import fastifyAuth from '@fastify/auth';
import fastifyJwt from '@fastify/jwt';
import fastifySocketIO from 'fastify-socket.io';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyCors from '@fastify/cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../env.js';
import ResponseObject from './ResponseObject.js';

// Auth strategies
import {
  verifyJWT,
  verifyApiToken,
  verifyDeviceToken,
  authService
} from './auth/strategies.js';

// Routes
import authRoutes from './routes/auth.js';
import workspaceRoutes from './routes/workspaces/index.js';
import contextRoutes from './routes/contexts/index.js';
import agentRoutes from './routes/agents/index.js';
import pubRoutes from './routes/pub/index.js';
import pingRoute from './routes/ping.js';
import pdfProxyRoutes from './routes/pdf-proxy.js';
import schemaRoutes from './routes/schemas.js';
import adminRoutes from './routes/admin/index.js';
import webdavRoutes from './routes/webdav.js';
import contextWebdavRoutes from './routes/context-webdav.js';
import menuRoutes from './routes/menu.js';
import roleRoutes from './routes/roles/index.js';
import roleTemplateRoutes from './routes/role-templates/index.js';
import messagingRoutes from './routes/messaging/index.js';
import messagingWebhookRoutes from './routes/messaging/webhooks.js';
import voiceRoutes from './routes/voice/index.js';
import { rejectAgentTokens } from './middleware/agent-acl.js';

// WebSocket handlers
import setupWebSocketHandlers from './websocket/index.js';

// Logging
import { createLogger, logger as rootLogger } from '../utils/log.js';
const logger = createLogger('transports');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Create and configure the Fastify server
 * @param {Object} options - Server options
 * @returns {FastifyInstance} - Configured Fastify instance
 */
export async function createServer(options = {}) {
  const fastifyLogger = options.logger || rootLogger.child({ module: 'http' });
  const buildAuthFailure = (strategy, error) => ({
    strategy,
    message: error?.message || 'Authentication failed',
    statusCode: error?.statusCode || 401,
  });
  const getPrimaryAuthFailure = (failures = []) => failures.find((failure) => (
    failure.message !== 'Not a JWT token'
    && failure.message !== 'Not an API token'
    && failure.message !== 'Not a canvas token'
  )) || failures[failures.length - 1] || null;
  const server = Fastify({
    logger: fastifyLogger,
    trustProxy: true,
    disableRequestLogging: true,
    disableResponseValidation: true,
    ignoreTrailingSlash: true,
    bodyLimit: 1073741824, // 1 GiB
  });

  // Register fastify-jwt FIRST - needed for request.jwtVerify
  await server.register(fastifyJwt, {
    secret: env.auth.jwtSecret,
    sign: {
      expiresIn: authService.getJwtExpiry ? (authService.getJwtExpiry() || '1d') : '1d'
    },
    // Keep decorateRequest: false as we manually set request.user
    decorateRequest: false
  });

  // Decorate server with our custom verification strategies
  server.decorate('verifyJWT', verifyJWT);
  server.decorate('verifyApiToken', verifyApiToken);
  server.decorate('verifyDeviceToken', verifyDeviceToken);

  // Register fastify-auth, which will allow us to chain strategies
  await server.register(fastifyAuth);

  // Define the 'authenticate' decorator using the chained strategies.
  // Keep the auth chain explicit so logs reflect the actual failure.
  server.decorate('authenticate', async (request, reply) => {
    const failures = [];

    try {
      await server.verifyJWT(request, reply);
      request.authStrategy = 'jwt';
      return;
    } catch (jwtError) {
      failures.push(buildAuthFailure('jwt', jwtError));
      request.log.debug({ reason: jwtError.message }, 'JWT authentication failed, trying API token');
    }

    try {
      await server.verifyApiToken(request, reply);
      request.authStrategy = 'api';
      return;
    } catch (apiError) {
      failures.push(buildAuthFailure('api', apiError));
      request.log.debug({ reason: apiError.message }, 'API token authentication failed, trying device token');
    }

    // Devices are first-class principals: a device token must be able to read
    // (canvas-fuse, agent containers), matching the websocket auth chain.
    try {
      await server.verifyDeviceToken(request, reply);
      request.authStrategy = 'device';
      return;
    } catch (deviceError) {
      failures.push(buildAuthFailure('device', deviceError));
      request.authFailures = failures;

      const primaryFailure = getPrimaryAuthFailure(failures);
      const error = new Error(primaryFailure?.message || 'Authentication failed');
      error.statusCode = primaryFailure?.statusCode || 401;
      error.authFailures = failures;
      throw error;
    }
  });

  // Device-only authentication (for integrations)
  server.decorate('authenticateDevice', server.auth([
    server.verifyDeviceToken
  ], { relation: 'or' }));

  // Client ingestion authentication (web UI, extension API tokens, or device tokens).
  server.decorate('authenticateClient', server.auth([
    server.verifyJWT,
    server.verifyApiToken,
    server.verifyDeviceToken
  ], { relation: 'or' }));

  // Create a custom authentication decorator that handles errors properly
  server.decorate('authenticateCustom', async (request, reply) => {
    try {
      await server.authenticate(request, reply);
      return;
    } catch (authError) {
      const statusCode = authError.statusCode || 401;
      if (statusCode === 401) {
        reply.header('Connection', 'close');
        request.log.warn({ authFailures: authError.authFailures || request.authFailures || [] }, 'Authentication failed');
      } else {
        request.log.error({ err: authError, statusCode }, 'Authentication handler failed');
      }

      const response = new ResponseObject();
      response.error(authError.message || 'Authentication failed', null, statusCode);
      reply.code(statusCode).send(response.getResponse());

      if (statusCode === 401) {
        setImmediate(() => {
          request.log.info('Forcing connection close after authentication failure');
          if (reply.raw.socket && !reply.raw.socket.destroyed) {
            reply.raw.socket.end();
          }
        });
      }
    }
  });

  // Make managers available
  if (options.users) server.decorate('users', options.users);
  if (options.workspaceManager) server.decorate('workspaceManager', options.workspaceManager);
  if (options.contextManager) server.decorate('contextManager', options.contextManager);
  if (options.dotfileManager) server.decorate('dotfileManager', options.dotfileManager);
  if (options.roles) server.decorate('roles', options.roles);
  if (options.agents) server.decorate('agents', options.agents);
  if (options.authService) server.decorate('authService', options.authService);
  if (options.deviceRegistry) server.decorate('deviceRegistry', options.deviceRegistry);
  if (options.messaging) server.decorate('messaging', options.messaging);
  if (options.chatRouter) server.decorate('chatRouter', options.chatRouter);
  if (options.voice) server.decorate('voice', options.voice);

  // Handle WebDAV OPTIONS before CORS plugin intercepts them
  const davUrlPattern = /^\/workspaces\/[^/]+\/dav(\/|$)/;
  const ctxDavUrlPattern = /^\/contexts\/[^/]+\/dav(\/|$)/;
  server.addHook('onRequest', async (request, reply) => {
    request.requestStartAt = Date.now();

    if (davUrlPattern.test(request.url) && request.method === 'OPTIONS') {
      reply.header('DAV', '1, 2');
      reply.header('MS-Author-Via', 'DAV');
      reply.header('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Depth, If, Overwrite, Destination, Lock-Token, Timeout');
      reply.header('Access-Control-Expose-Headers', 'DAV, ETag, Lock-Token, Content-Type');
      reply.header('Access-Control-Max-Age', '86400');
      return reply.code(200).send();
    }
    if (ctxDavUrlPattern.test(request.url) && request.method === 'OPTIONS') {
      reply.header('DAV', '1');
      reply.header('Allow', 'OPTIONS, GET, HEAD, PROPFIND');
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PROPFIND');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Depth');
      reply.header('Access-Control-Expose-Headers', 'DAV, Content-Type');
      reply.header('Access-Control-Max-Age', '86400');
      return reply.code(200).send();
    }
  });

  server.addHook('onResponse', async (request, reply) => {
    const durationMs = Date.now() - (request.requestStartAt || Date.now());
    const payload = {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      durationMs,
      userId: request.user?.id || null,
    };

    if (reply.statusCode >= 500) {
      request.log.error(payload, 'request failed');
      return;
    }

    if (reply.statusCode >= 400) {
      request.log.warn(payload, 'request completed with client error');
      return;
    }

    request.log.info(payload, 'request completed');
  });

  // Register plugins
  await server.register(fastifyCors, {
    origin: options.corsOrigin || true, // Default to allowing all origins, customize in production
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-App-Name', 'X-Selected-Session', 'Cache-Control', 'Depth', 'If', 'Overwrite', 'Destination'],
    exposedHeaders: ['Authorization', 'Content-Type', 'DAV', 'ETag', 'Lock-Token'],
    maxAge: 86400 // 24 hours
  });

  // WebDAV routes (scoped plugins — own content-type parsers)
  server.register(webdavRoutes);
  server.register(contextWebdavRoutes);

  // Add security headers including CSP for browser extension compatibility
  server.addHook('onSend', async (request, reply, payload) => {
    // Set CSP headers that are compatible with browser extensions and WebSocket connections
    const cspDirectives = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // Allow inline scripts for socket.io
      "style-src 'self' 'unsafe-inline'", // Allow inline styles
      "connect-src 'self' ws: wss: http: https:", // Allow WebSocket and HTTP connections
      "img-src 'self' data: blob: https:", // self + data/blob + remote https (favicons, link cards). Email bodies keep a stricter sandboxed CSP.
      "font-src 'self' data:", // Allow fonts
      "frame-src 'self' blob: https://www.youtube-nocookie.com", // PDF/email preview (blob: iframes) + YouTube embeds
      "worker-src 'self' blob:", // Allow web workers
      "object-src 'none'", // Disable object/embed elements
      "base-uri 'self'" // Restrict base tag
    ].join('; ');

    reply.header('Content-Security-Policy', cspDirectives);

    // Additional security headers
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-XSS-Protection', '1; mode=block');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

    return payload;
  });

  await server.register(fastifyMultipart, {
    limits: {
      fileSize: options.maxFileSize || 10485760 // 10MB default
    }
  });

  // Register WebSocket support with fastify-socket.io
  await server.register(fastifySocketIO, {
    cors: {
      origin: options.corsOrigin || true,
      methods: ["GET", "POST"],
      credentials: true,
      allowedHeaders: ["Authorization", "Content-Type", "X-App-Name", "X-Selected-Session"]
    },
    transports: ['websocket'] // Force WebSockets, disable long-polling
  });

  // Setup WebSocket handlers
  setupWebSocketHandlers(server);

  // Late-bind the in-app notification adapter to the ws broadcast helper —
  // Messaging is constructed before transports, so the adapter buffers until
  // this point and pushes live from here on.
  options.messaging?.getAdapter?.('canvas')?.setBroadcast?.(server.broadcastToUser);

  // Context events are forwarded via the wildcard listener in websocket/channels/context.js
  // No additional listeners needed here (would cause duplicate delivery)

  // Static file server for the UI
  await server.register(fastifyStatic, {
    root: path.join(__dirname, '..', 'ui', 'web', 'dist'),
    prefix: '/',
  });

  await authService.initialize();

  // Agent tokens (canvas-agent-*) are data-plane only: they may reach the
  // workspace routes (clamped by enforceAgentBinding) but not control-plane
  // route groups. agentRoutes carries its own in-file guard.
  const withoutAgentTokens = (routes) => async (instance) => {
    instance.addHook('preHandler', rejectAgentTokens);
    await instance.register(routes);
  };

  // Register routes
  server.register(pingRoute);
  server.register(authRoutes, { prefix: '/rest/v2/auth' });
  server.register(menuRoutes, { prefix: '/rest/v2', onRequest: [server.authenticate] });
  server.register(workspaceRoutes, { prefix: '/rest/v2/workspaces' });
  server.register(withoutAgentTokens(contextRoutes), { prefix: '/rest/v2/contexts' });
  server.register(agentRoutes, { prefix: '/rest/v2/agents' });
  server.register(pubRoutes, { prefix: '/rest/v2/pub' });
  server.register(schemaRoutes, { prefix: '/rest/v2/schemas' });
  server.register(pdfProxyRoutes, { prefix: '/rest/v2/proxy' });
  server.register(messagingRoutes, { prefix: '/rest/v2/messaging' });
  server.register(messagingWebhookRoutes, { prefix: '/rest/v2/messaging/webhooks' });
  server.register(voiceRoutes, { prefix: '/rest/v2/voice' });
  server.register(withoutAgentTokens(adminRoutes), { prefix: '/rest/v2/admin' });
  server.register(withoutAgentTokens(roleRoutes), { prefix: '/rest/v2/roles' });
  server.register(withoutAgentTokens(roleTemplateRoutes), { prefix: '/rest/v2/role-templates' });

  // Global 404 handler
  server.setNotFoundHandler((request, reply) => {
    // For API routes, return a JSON 404 response
    if (request.url.startsWith('/rest/v2/')) {
      const response = new ResponseObject().notFound(`Route ${request.method}:${request.url} not found`);
      return reply.code(response.statusCode).send(response.getResponse());
    }

    // For WebDAV routes, return a plain 404 (not SPA index.html)
    if (davUrlPattern.test(request.url) || ctxDavUrlPattern.test(request.url)) {
      return reply.code(404).send('Not Found');
    }

    // For all other routes (UI routes), serve the index.html
    // This supports client-side routing in SPA
    reply.sendFile('index.html');
  });

  // Global error handler
  server.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;
    if (statusCode === 401) {
      request.log.warn({
        statusCode,
        authFailures: error.authFailures || request.authFailures || [],
      }, 'Authentication failed');
    } else {
      request.log.error({ err: error, statusCode }, 'Global error handler called');
    }

    // Only send error response if a response hasn't been sent yet
    if (!reply.sent) {
      // For authentication errors (401), close the connection to prevent resource exhaustion
      if (statusCode === 401) {
        // Set Connection: close header to signal connection should be closed
        reply.header('Connection', 'close');
        request.log.info('Authentication failed - closing connection');

        // Create and send the error response
        const response = new ResponseObject();
        response.error(error.message || 'Authentication failed', null, statusCode);

        // Send the response and close the connection immediately after
        reply.code(statusCode).send(response.getResponse());

        // Force close the connection after sending the response
        setImmediate(() => {
          request.log.info('Forcing connection close after authentication failure');
          if (reply.raw.socket && !reply.raw.socket.destroyed) {
            reply.raw.socket.end();
          }
        });
      } else {
        // Use the generic error method from our ResponseObject for non-auth errors
        const response = new ResponseObject();
        response.error(error.message || 'Something went wrong', [error], statusCode);
        reply.code(response.statusCode).send(response.getResponse());
      }
    } else {
      request.log.debug('Reply already sent - not handling error');
    }
  });

  return server;
}

/**
 * Start the Transport server
 * @param {Object} options - Server options
 * @returns {Promise<FastifyInstance>} - Fastify server instance
 */
export async function startTransportServer(options = {}) {
  // Create and configure the Fastify server
  const fastify = await createServer(options);

  // These decorations are now handled in createServer, but we'll keep them here
  // to ensure backward compatibility, only adding if they don't already exist
  if (!fastify.hasDecorator('users') && options.users)
    fastify.decorate('users', options.users);
  if (!fastify.hasDecorator('workspaceManager') && options.workspaceManager)
    fastify.decorate('workspaceManager', options.workspaceManager);
  if (!fastify.hasDecorator('contextManager') && options.contextManager)
    fastify.decorate('contextManager', options.contextManager);
  if (!fastify.hasDecorator('dotfileManager') && options.dotfileManager)
    fastify.decorate('dotfileManager', options.dotfileManager);
  if (!fastify.hasDecorator('roles') && options.roles)
    fastify.decorate('roles', options.roles);
  if (!fastify.hasDecorator('agents') && options.agents)
    fastify.decorate('agents', options.agents);
  if (!fastify.hasDecorator('authService') && options.authService)
    fastify.decorate('authService', options.authService);
  if (!fastify.hasDecorator('deviceRegistry') && options.deviceRegistry)
    fastify.decorate('deviceRegistry', options.deviceRegistry);

  // Start listening
  const port = options.port || env.server.api.port;
  const host = options.host || env.server.api.host;

  await fastify.listen({ port, host });
  logger.info({ host, port }, 'Transport server listening');

  return fastify;
}

export default createServer;

