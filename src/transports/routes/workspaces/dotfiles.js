'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

/**
 * Git HTTP Basic Authentication Middleware
 * Converts Git HTTP Basic auth to Bearer token format for Canvas authentication
 * Also handles the initial Git request that comes without authentication
 */
async function convertBasicAuthToBearer(request, reply) {
  try {
    const authHeader = request.headers.authorization;

    // If no auth header, this is Git's initial request - respond with WWW-Authenticate
    if (!authHeader) {
      reply.code(401).header('WWW-Authenticate', 'Basic realm="Canvas Git"').send({
        status: 'error',
        statusCode: 401,
        message: 'Authentication required',
        payload: null,
        count: null
      });
      return;
    }

    // Check if this is Basic authentication
    if (authHeader.startsWith('Basic ')) {
      // Extract credentials from Basic auth
      const base64Credentials = authHeader.split(' ')[1];
      const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii');
      const [username, password] = credentials.split(':');

      // If password is a Canvas API token, convert to Bearer format
      if (password && password.startsWith('canvas-')) {
        request.headers.authorization = `Bearer ${password}`;
      }
    }

  } catch (error) {
    console.error('Error in convertBasicAuthToBearer middleware:', error);
    // Don't throw, just continue with original auth header
  }
}



/**
 * Workspace dotfiles routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceDotfilesRoutes(fastify, options) {
  // Register content type parsers for Git protocol
  fastify.addContentTypeParser('application/x-git-receive-pack-request', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  fastify.addContentTypeParser('application/x-git-upload-pack-request', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

      // Helper to validate user and extract workspace info
  const extractRequestInfo = (request) => {
    // Workspace should be resolved by middleware and available at request.workspace
    const workspace = request.workspace;
    const userId = request.user?.id;
    const requestingUserId = request.user?.id;

    if (!workspace) {
      throw new Error('Workspace not resolved by middleware. This indicates a configuration issue.');
    }

    if (!userId) {
      throw new Error('User not authenticated. This indicates an authentication issue.');
    }

    return { workspace, userId, requestingUserId };
  };

  /**
   * CRUD: List dotfile documents
   * GET /workspaces/:id/dotfiles
   */
  fastify.get('/', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          contextSpec: { type: 'string', default: '/' },
          featureArray: {
            type: 'array',
            items: { type: 'string' },
            default: []
          },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          page: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { workspace } = extractRequestInfo(request);
      const contextSpec = request.query.contextSpec || '/';
      const featureArrayInput = request.query.featureArray || [];
      const derivedFeatureArray = ['data/abstraction/dotfile', ...featureArrayInput];

      const documents = await workspace.findDocuments(
        contextSpec,
        derivedFeatureArray,
        [], // empty filterArray
        { limit: request.query.limit, offset: request.query.offset, page: request.query.page }
      );

      const responseObject = new ResponseObject().found(documents, 'Dotfiles retrieved successfully', 200, documents.count, documents.totalCount);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to list dotfiles');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  /**
   * CRUD: Create dotfile documents
   * POST /workspaces/:id/dotfiles
   */
  fastify.post('/', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
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
        required: ['dotfiles'],
        properties: {
          contextSpec: { type: 'string', default: '/' },
          featureArray: {
            type: 'array',
            items: { type: 'string' },
            default: []
          },
          dotfiles: {
            anyOf: [
              { type: 'object' },
              { type: 'array', items: { type: 'object' } }
            ]
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { workspace } = extractRequestInfo(request);
      const contextSpec = request.body.contextSpec || '/';
      const featureArrayInput = request.body.featureArray || [];
      const dotfilesInput = request.body.dotfiles;
      const dotfileArray = Array.isArray(dotfilesInput) ? dotfilesInput : [dotfilesInput];

      const documentArray = dotfileArray.map(df => ({
        schema: 'data/abstraction/dotfile',
        data: df
      }));

      const inserted = await workspace.insertDocumentArray(
        documentArray,
        contextSpec,
        ['data/abstraction/dotfile', ...featureArrayInput]
      );

      const responseObject = new ResponseObject().created(inserted, 'Dotfiles created successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to create dotfiles');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  /**
   * CRUD: Update dotfile documents
   * PUT /workspaces/:id/dotfiles
   */
  fastify.put('/', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
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
        required: ['documents'],
        properties: {
          documents: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id'],
              properties: {
                id: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { workspace } = extractRequestInfo(request);
      const result = await workspace.updateDocumentArray(request.body.documents);
      const responseObject = new ResponseObject().updated(result, 'Dotfiles updated successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to update dotfiles');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  /**
   * CRUD: Delete dotfile documents
   * DELETE /workspaces/:id/dotfiles
   */
  fastify.delete('/', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      body: {
        type: 'array',
        items: { type: ['string', 'number'] },
        minItems: 1
      }
    }
  }, async (request, reply) => {
    try {
      const { workspace } = extractRequestInfo(request);
      const docIds = Array.isArray(request.body) ? request.body : [request.body];
      const success = await workspace.deleteDocumentArray(docIds);
      const responseObject = success ?
        new ResponseObject().deleted(null, 'Dotfiles deleted successfully') :
        new ResponseObject().badRequest('Failed to delete dotfiles');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to delete dotfiles');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  /**
   * GET /workspaces/:id/dotfiles/status
   * Check if dotfiles repository is initialized for the workspace
   */
  fastify.get('/status', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
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
      const { workspace, userId, requestingUserId } = extractRequestInfo(request);

      const status = await fastify.dotfileManager.getRepositoryStatus(
        userId,
        workspace,
        requestingUserId
      );

      const responseObject = new ResponseObject().found(
        status,
        'Dotfiles repository status retrieved successfully'
      );
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get dotfiles repository status');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  /**
   * POST /workspaces/:id/dotfiles/init
   * Initialize dotfiles repository for the workspace
   */
  fastify.post('/init', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
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
      const { workspace, userId, requestingUserId } = extractRequestInfo(request);

      const result = await fastify.dotfileManager.initializeRepository(
        userId,
        workspace,
        requestingUserId
      );

      const responseObject = new ResponseObject().created(
        result,
        'Dotfiles repository initialized successfully'
      );
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);

      // Handle specific errors
      if (error.message.includes('not found') || error.message.includes('access denied')) {
        const responseObject = new ResponseObject().notFound('Workspace not found or access denied');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().serverError('Failed to initialize dotfiles repository');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  /**
   * Git HTTP Backend Routes
   * These handle the Git protocol over HTTP for repository access
   */

  /**
   * GET /workspaces/:id/dotfiles/git/info/refs
   * Git info/refs endpoint for repository discovery
   */
  fastify.get('/git/info/refs', {
    onRequest: [convertBasicAuthToBearer, fastify.authenticate, requireWorkspaceRead()],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          service: { type: 'string' }
        }
      }
    }
    }, async (request, reply) => {
    try {
      const { workspace, userId, requestingUserId } = extractRequestInfo(request);

      await fastify.dotfileManager.handleGitHttpBackend(
        userId,
        workspace,
        requestingUserId,
        'info/refs',
        request,
        reply
      );
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send('Internal server error');
    }
  });

  /**
   * POST /workspaces/:id/dotfiles/git/git-upload-pack
   * Git upload-pack endpoint for clone/fetch operations
   */
  fastify.post('/git/git-upload-pack', {
    onRequest: [convertBasicAuthToBearer, fastify.authenticate, requireWorkspaceRead()],
    config: {
      rawBody: true  // Allow raw binary data
    },
    bodyLimit: 67108864, // 64MB limit for Git pack uploads
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
      const { workspace, userId, requestingUserId } = extractRequestInfo(request);

      await fastify.dotfileManager.handleGitHttpBackend(
        userId,
        workspace,
        requestingUserId,
        'git-upload-pack',
        request,
        reply
      );
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send('Internal server error');
    }
  });

  /**
   * POST /workspaces/:id/dotfiles/git/git-receive-pack
   * Git receive-pack endpoint for push operations
   */
  fastify.post('/git/git-receive-pack', {
    onRequest: [convertBasicAuthToBearer, fastify.authenticate, requireWorkspaceWrite()],
    config: {
      rawBody: true  // Allow raw binary data
    },
    bodyLimit: 67108864, // 64MB limit for Git pack uploads
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
      const { workspace, userId, requestingUserId } = extractRequestInfo(request);

      await fastify.dotfileManager.handleGitHttpBackend(
        userId,
        workspace,
        requestingUserId,
        'git-receive-pack',
        request,
        reply
      );
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send('Internal server error');
    }
  });

  /**
   * GET /workspaces/:id/dotfiles/git/*
   * Generic Git endpoint for any other Git operations
   */
  fastify.get('/git/*', {
    onRequest: [convertBasicAuthToBearer, fastify.authenticate, requireWorkspaceRead()],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          '*': { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { workspace, userId, requestingUserId } = extractRequestInfo(request);
      const gitPath = request.params['*'];

      // Handle generic Git requests
      await fastify.dotfileManager.handleGitHttpBackend(
        userId,
        workspace,
        requestingUserId,
        gitPath,
        request,
        reply
      );
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send('Internal server error');
    }
  });

  /**
   * POST /workspaces/:id/dotfiles/git/*
   * Generic Git POST endpoint for any other Git operations
   */
  fastify.post('/git/*', {
    onRequest: [convertBasicAuthToBearer, fastify.authenticate, requireWorkspaceWrite()],
    config: {
      rawBody: true  // Allow raw binary data
    },
    bodyLimit: 67108864, // 64MB limit for Git pack uploads
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          '*': { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { workspace, userId, requestingUserId } = extractRequestInfo(request);
      const gitPath = request.params['*'];

      // Handle generic Git requests
      await fastify.dotfileManager.handleGitHttpBackend(
        userId,
        workspace,
        requestingUserId,
        gitPath,
        request,
        reply
      );
    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send('Internal server error');
    }
  });
}
