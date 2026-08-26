'use strict';

import { parseBasicAuth } from '../../lib/basic-auth.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

/**
 * Git HTTP backend for workspace bare repo (git/bare.git on disk).
 * Mounted at /workspaces/:id/git/* — moved from /dotfiles/git per monorepo layout.
 */

async function convertBasicAuthToBearer(request, reply) {
  try {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      reply.code(401).header('WWW-Authenticate', 'Basic realm="Canvas Git"').send({
        status: 'error',
        statusCode: 401,
        message: 'Authentication required',
        payload: null,
        count: null,
      });
      return;
    }
    // git sends its credential over Basic; every strategy downstream speaks
    // Bearer. The password is promoted whatever it looks like: this route has
    // no password-login path, so a value that is not a token simply fails
    // authentication one step later, exactly as it did before. Requiring a
    // `canvas-` prefix here rejected the JWT that `remote login` stores, which
    // made `canvas dot add/clone/push/pull` fail with "Authentication failed"
    // unless the user happened to have swapped in an API token.
    const basic = parseBasicAuth(authHeader);
    if (basic?.password) {
      request.headers.authorization = `Bearer ${basic.password}`;
    }
  } catch (error) {
    console.error('Error in convertBasicAuthToBearer middleware:', error);
  }
}

function extractRequestInfo(request) {
  const workspace = request.workspace;
  const userId = request.user?.id;
  if (!workspace) throw new Error('Workspace not resolved by middleware');
  if (!userId) throw new Error('User not authenticated');
  return { workspace, userId, requestingUserId: userId };
}

export default async function workspaceGitRoutes(fastify) {
  fastify.addContentTypeParser('application/x-git-receive-pack-request', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
  fastify.addContentTypeParser('application/x-git-upload-pack-request', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const handle = async (request, reply, service) => {
    try {
      const { workspace, userId, requestingUserId } = extractRequestInfo(request);
      await fastify.dotfileManager.handleGitHttpBackend(
        userId, workspace, requestingUserId, service, request, reply,
      );
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send('Internal server error');
    }
  };

  // GET /workspaces/:id/git/info/refs
  fastify.get('/info/refs', {
    onRequest: [convertBasicAuthToBearer, fastify.authenticate, requireWorkspaceRead()],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: { type: 'object', properties: { service: { type: 'string' } } },
    },
  }, (request, reply) => handle(request, reply, 'info/refs'));

  // POST /workspaces/:id/git/git-upload-pack
  fastify.post('/git-upload-pack', {
    onRequest: [convertBasicAuthToBearer, fastify.authenticate, requireWorkspaceRead()],
    config: { rawBody: true },
    bodyLimit: 67108864,
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, (request, reply) => handle(request, reply, 'git-upload-pack'));

  // POST /workspaces/:id/git/git-receive-pack
  fastify.post('/git-receive-pack', {
    onRequest: [convertBasicAuthToBearer, fastify.authenticate, requireWorkspaceWrite()],
    config: { rawBody: true },
    bodyLimit: 67108864,
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  }, (request, reply) => handle(request, reply, 'git-receive-pack'));

  // GET /workspaces/:id/git/*
  fastify.get('/*', {
    onRequest: [convertBasicAuthToBearer, fastify.authenticate, requireWorkspaceRead()],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' }, '*': { type: 'string' } },
      },
    },
  }, (request, reply) => handle(request, reply, request.params['*']));

  // POST /workspaces/:id/git/*
  fastify.post('/*', {
    onRequest: [convertBasicAuthToBearer, fastify.authenticate, requireWorkspaceWrite()],
    config: { rawBody: true },
    bodyLimit: 67108864,
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' }, '*': { type: 'string' } },
      },
    },
  }, (request, reply) => handle(request, reply, request.params['*']));
}
