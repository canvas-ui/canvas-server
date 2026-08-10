'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';
import { stripDeviceFeatureTags } from '../../../utils/device-features.js';

/**
 * Workspace dotfiles routes (CRUD, status, init).
 * Git HTTP backend lives in ./git.js at /workspaces/:id/git/*
 */
export default async function workspaceDotfilesRoutes(fastify, _options) {
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

  const getContextTreeSelector = (workspace, source = {}, fallbackPath = '/') =>
    workspace.getContextTreeSelector(source?.context ?? fallbackPath, source?.treeNameOrTreeId ?? null);

  function buildAttributes(query) {
    const { allOf, noneOf, anyOf } = query;
    if (!allOf?.length && !noneOf?.length && !anyOf?.length) return undefined;
    const attrs = {};
    if (allOf?.length) attrs.allOf = allOf;
    if (noneOf?.length) attrs.noneOf = noneOf;
    if (anyOf?.length) attrs.anyOf = anyOf;
    return attrs;
  }

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
          treeNameOrTreeId: { type: 'string' },
          context: { type: 'string', default: '/' },
          allOf: { type: 'array', items: { type: 'string' }, default: [] },
          noneOf: { type: 'array', items: { type: 'string' }, default: [] },
          anyOf: { type: 'array', items: { type: 'string' }, default: [] },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          page: { type: 'integer' },
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { workspace } = extractRequestInfo(request);
      const contextSelector = getContextTreeSelector(workspace, request.query, '/');
      const attrs = buildAttributes(request.query) || {};
      const allOf = ['data/schema/dotfile', ...(attrs.allOf || [])];

      const documents = await workspace.list({
        context: contextSelector,
        attributes: { ...attrs, allOf },
        filters: [],
        limit: request.query.limit,
        offset: request.query.offset,
        page: request.query.page,
      });

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
          treeNameOrTreeId: { type: 'string' },
          context: { type: 'string', default: '/' },
          features: { type: 'array', items: { type: 'string' }, default: [] },
          dotfiles: { anyOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }] },
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { workspace } = extractRequestInfo(request);
      const contextSelector = getContextTreeSelector(workspace, request.body, '/');
      const dotfilesInput = request.body.dotfiles;
      const dotfileArray = Array.isArray(dotfilesInput) ? dotfilesInput : [dotfilesInput];
      const documentArray = dotfileArray.map(df => ({ schema: 'data/schema/dotfile', data: df }));

      const inserted = await workspace.putMany(documentArray, {
        context: contextSelector,
        features: ['data/schema/dotfile', ...stripDeviceFeatureTags(request.body.features || [])],
      });

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
          treeNameOrTreeId: { type: 'string' },
          context: { type: 'string', default: '/' },
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
      const result = await workspace.putMany(request.body.documents, {
        context: getContextTreeSelector(workspace, request.body, '/'),
      });
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
        items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        minItems: 1
      }
    }
  }, async (request, reply) => {
    try {
      const { workspace } = extractRequestInfo(request);
      const docIds = Array.isArray(request.body) ? request.body : [request.body];
      const success = await workspace.deleteMany(docIds);
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
}
