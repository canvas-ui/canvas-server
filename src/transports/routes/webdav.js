'use strict';

import { promises as fs } from 'fs';
import { WebDAVHandler } from '../webdav/server.js';
import ResponseObject from '../ResponseObject.js';
import { createLogger } from '../../utils/log.js';

const logger = createLogger('webdav:routes');

const DAV_METHODS = ['GET', 'HEAD', 'PUT', 'DELETE', 'PROPFIND', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK'];

/**
 * WebDAV Routes — provides DAV protocol access to workspace /home folders.
 * Route: /workspaces/:workspace/dav[/*]
 */
export default async function webdavRoutes(fastify) {
  // ── WebDAV handler wired to workspace resolution ────────────────────────

  const handler = new WebDAVHandler(async (userId, workspace) => {
    const workspaceId = fastify.workspaceManager.resolveWorkspaceId(userId, workspace);
    if (!workspaceId) return null;

    let ws = await fastify.workspaceManager.getWorkspace(workspaceId, userId);
    if (!ws?.rootPath) return null;

    // Auto-start workspace if inactive (WebDAV may be accessed before web login)
    if (!ws.isActive) {
      try { ws = await fastify.workspaceManager.startWorkspace(workspaceId, userId); }
      catch (err) { logger.warn({ err, workspaceId }, 'Failed to auto-start workspace for WebDAV'); }
    }

    // The workspace decides where its home drive lives — `home/` under the
    // root (full layout) or the root itself (home layout).
    const homePath = ws.homePath;
    await fs.mkdir(homePath, { recursive: true }).catch(() => {});
    return { homePath, workspace: ws, contextManager: fastify.contextManager };
  });

  // ── Content-type parser (scoped to this plugin) ──────────────────────────
  // Keep request bodies as streams for all DAV methods. XML bodies are
  // explicitly drained/limited in the handler methods that use them.

  const FILE_LIMIT = 8 * 1024 * 1024 * 1024; // 8GB

  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { bodyLimit: FILE_LIMIT }, (_req, payload, done) => done(null, payload));

  // ── Auth preHandler (shared by all DAV routes) ──────────────────────────

  async function authenticate(request, reply) {
    const authHeader = request.headers.authorization;

    if (!authHeader) {
      reply.header('WWW-Authenticate', 'Basic realm="Canvas WebDAV"');
      return reply.code(401).send(new ResponseObject().unauthorized('Authentication required').getResponse());
    }

    let token = null;

    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7);
    } else if (authHeader.startsWith('Basic ')) {
      try {
        const [username, password] = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8').split(':', 2);

        if (password?.startsWith('canvas-')) {
          token = password;
        } else {
          // Username/password auth
          const user = await fastify.users.getByEmail(username);
          if (!user || !(await fastify.authService.verifyPassword(user.id, password))) {
            return reply.code(401).send(new ResponseObject().unauthorized('Invalid credentials').getResponse());
          }
          request.user = { id: user.id, name: user.name || user.email, email: user.email, userType: user.userType || 'user' };
        }
      } catch {
        return reply.code(401).send(new ResponseObject().unauthorized('Invalid credentials').getResponse());
      }
    } else {
      return reply.code(401).send(new ResponseObject().unauthorized('Unsupported auth scheme').getResponse());
    }

    // Token-based auth (Bearer or Basic with canvas- token)
    if (token) {
      const result = await fastify.authService.verifyToken(token);
      if (!result?.valid) {
        return reply.code(401).send(new ResponseObject().unauthorized(result?.message || 'Invalid token').getResponse());
      }
      request.user = result.user;
    }

    if (!request.user) {
      return reply.code(401).send(new ResponseObject().unauthorized('Authentication failed').getResponse());
    }

    // Verify workspace access
    const workspace = request.params.workspace;
    const workspaceId = fastify.workspaceManager.resolveWorkspaceId(request.user.id, workspace);
    if (!workspaceId) {
      return reply.code(404).send(new ResponseObject().notFound('Workspace not found').getResponse());
    }

    const ws = await fastify.workspaceManager.getWorkspace(workspaceId, request.user.id);
    if (!ws) {
      return reply.code(404).send(new ResponseObject().notFound('Workspace not found').getResponse());
    }

    if (!ws.isServiceEnabled('home')) {
      return reply.code(403).send(new ResponseObject().forbidden('WebDAV is not enabled for this workspace').getResponse());
    }

    const hasAccess = ws.owner === request.user.id ||
      !!(request.user.email && ws.acl?.users?.[request.user.email]);

    if (!hasAccess) {
      return reply.code(403).send(new ResponseObject().forbidden('Access denied').getResponse());
    }
  }

  // ── Route registration ──────────────────────────────────────────────────

  for (const url of ['/workspaces/:workspace/dav', '/workspaces/:workspace/dav/*']) {
    // OPTIONS — capability discovery (no auth required for CORS preflight)
    fastify.options(url, (request, reply) => {
      reply.header('DAV', '1, 2');
      reply.header('MS-Author-Via', 'DAV');
      reply.header('Allow', 'OPTIONS, ' + DAV_METHODS.join(', '));
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Methods', 'OPTIONS, ' + DAV_METHODS.join(', '));
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Depth, If, Overwrite, Destination, Lock-Token, Timeout');
      reply.header('Access-Control-Expose-Headers', 'DAV, ETag, Lock-Token, Content-Type');
      reply.header('Access-Control-Max-Age', '86400');
      return reply.code(200).send();
    });

    // All other WebDAV methods
    fastify.route({
      method: DAV_METHODS,
      url,
      bodyLimit: 8589934592, // 8GB
      preHandler: authenticate,
      handler: async (request, reply) => {
        reply.hijack();
        await handler.handle(reply.raw, {
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: request.body,
          userId: request.user.id,
          workspace: request.params.workspace,
        });
      },
    });
  }

  logger.info('WebDAV routes registered at /workspaces/:workspace/dav');
}
