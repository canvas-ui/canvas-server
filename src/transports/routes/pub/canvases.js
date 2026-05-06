'use strict';

import ResponseObject from '../../ResponseObject.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PUBLIC_PAGE_SIZE = 100;

function clampLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.min(parsed, MAX_PUBLIC_PAGE_SIZE);
}

function buildAttributes(query) {
  const attrs = {};
  for (const key of ['allOf', 'anyOf', 'noneOf']) {
    const raw = Array.isArray(query[key]) ? query[key] : (query[key] ? [query[key]] : []);
    const values = raw.filter(Boolean);
    if (values.length) attrs[key] = values;
  }
  return Object.keys(attrs).length ? attrs : undefined;
}

function serializeLayer(layer, tree, share) {
  return {
    ...(typeof layer.toJSON === 'function' ? layer.toJSON() : layer),
    treeId: tree.id,
    treeName: tree.name,
    treeType: tree.type,
    path: share.path,
  };
}

function serializeDocuments(documents) {
  const data = Array.isArray(documents) ? documents : (documents?.data || []);
  return {
    data,
    count: documents?.count ?? data.length,
    totalCount: documents?.totalCount ?? documents?.count ?? data.length,
    error: documents?.error || null,
  };
}

async function resolveWorkspaceId(fastify, userId, identifier) {
  if (!identifier) return null;
  if (UUID_RE.test(identifier)) return identifier;
  return await fastify.workspaceManager.resolveWorkspaceId(userId, identifier);
}

async function buildPublicCanvasPayload(fastify, code, query = {}) {
  const resolved = await fastify.workspaceManager.resolvePublicCanvasShare(code);
  if (!resolved) return null;

  const { workspace, share } = resolved;
  if (!workspace.isActive) await workspace.start();

  const tree = workspace.getTree(share.treeName);
  const layer = tree.getLayerForPath(share.path);
  if (!layer || layer.type !== 'canvas' || layer.id !== share.layerId) {
    const error = new Error('Public canvas no longer exists');
    error.statusCode = 404;
    throw error;
  }

  const context = tree.type === 'directory'
    ? workspace.getDirectoryTreeSelector(share.path, tree.name)
    : workspace.getContextTreeSelector(share.path, tree.name);
  const listSpec = {
    context,
    attributes: buildAttributes(query),
    filters: Array.isArray(query.filters) ? query.filters : (query.filters ? [query.filters] : []),
    limit: clampLimit(query.limit),
    offset: query.offset,
    page: query.page,
  };

  const documents = await workspace.list(listSpec);
  if (documents.error) {
    const error = new Error(documents.error);
    error.statusCode = 500;
    throw error;
  }
  const serializedDocuments = serializeDocuments(documents);

  return {
    share: {
      ...share,
      url: `/pub/c/${share.code}`,
    },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      label: workspace.label,
      description: workspace.description,
      color: workspace.color,
    },
    canvas: serializeLayer(layer, tree, share),
    stats: {
      documentCount: serializedDocuments.totalCount,
      returnedCount: serializedDocuments.count,
      page: query.page || 1,
      pageSize: listSpec.limit,
      refreshedAt: new Date().toISOString(),
    },
    documents: serializedDocuments,
  };
}

export default async function pubCanvasRoutes(fastify) {
  fastify.get('/', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        required: ['workspaceId', 'path'],
        properties: {
          workspaceId: { type: 'string' },
          treeName: { type: 'string', default: 'context' },
          path: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspaceId = await resolveWorkspaceId(fastify, request.user.id, request.query.workspaceId);
      if (!workspaceId) {
        const response = new ResponseObject().notFound('Workspace not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const share = await fastify.workspaceManager.findPublicCanvasShare(request.user.id, workspaceId, {
        treeName: request.query.treeName || 'context',
        path: request.query.path,
      });
      const response = new ResponseObject().found(share ? { ...share, url: `/pub/c/${share.code}` } : null, 'Public canvas share lookup complete');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      const response = error.message?.includes('not a canvas')
        ? new ResponseObject().badRequest(error.message)
        : new ResponseObject().serverError(error.message || 'Failed to find public canvas share');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.post('/', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['workspaceId', 'path'],
        properties: {
          workspaceId: { type: 'string' },
          treeName: { type: 'string', default: 'context' },
          path: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspaceId = await resolveWorkspaceId(fastify, request.user.id, request.body.workspaceId);
      if (!workspaceId) {
        const response = new ResponseObject().notFound('Workspace not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const share = await fastify.workspaceManager.createPublicCanvasShare(request.user.id, workspaceId, {
        treeName: request.body.treeName || 'context',
        path: request.body.path,
      });
      const response = new ResponseObject().created({ ...share, url: `/pub/c/${share.code}` }, 'Public canvas share created');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to create public canvas share');
      const response = error.message?.includes('not a canvas')
        ? new ResponseObject().badRequest(error.message)
        : new ResponseObject().serverError(error.message || 'Failed to create public canvas share');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.delete('/:code', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string', maxLength: 8 } },
      },
    },
  }, async (request, reply) => {
    try {
      const deleted = await fastify.workspaceManager.deletePublicCanvasShare(request.user.id, request.params.code);
      if (!deleted) {
        const response = new ResponseObject().notFound('Public canvas share not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().deleted(true, 'Public canvas share deleted');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      const response = error.message?.includes('Only the workspace owner')
        ? new ResponseObject().forbidden(error.message)
        : new ResponseObject().serverError(error.message || 'Failed to delete public canvas share');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.get('/:code', {
    schema: {
      params: {
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string', maxLength: 8 } },
      },
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 50 },
          offset: { type: 'integer' },
          page: { type: 'integer' },
          allOf: { type: 'array', items: { type: 'string' }, default: [] },
          anyOf: { type: 'array', items: { type: 'string' }, default: [] },
          noneOf: { type: 'array', items: { type: 'string' }, default: [] },
          filters: { type: 'array', items: { type: 'string' }, default: [] },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const payload = await buildPublicCanvasPayload(fastify, request.params.code, request.query);
      if (!payload) {
        const response = new ResponseObject().notFound('Public canvas not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().found(
        payload,
        'Public canvas retrieved',
        200,
        payload.documents.count,
        payload.documents.totalCount
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to read public canvas');
      const response = error.statusCode === 404
        ? new ResponseObject().notFound(error.message)
        : new ResponseObject().serverError('Failed to read public canvas');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}

