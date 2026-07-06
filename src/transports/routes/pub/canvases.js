'use strict';

import ResponseObject from '../../ResponseObject.js';
import { parseDocumentId } from '../../../utils/documentId.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_PUBLIC_CANVAS_LIMIT = 5000;
const MAX_PUBLIC_PAGE_SIZE = 5000;

function clampLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PUBLIC_CANVAS_LIMIT;
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

function mergeAttributes(...sources) {
  const merged = {};
  for (const source of sources) {
    if (!source) continue;
    for (const key of ['allOf', 'anyOf', 'noneOf']) {
      const values = Array.isArray(source[key]) ? source[key].filter(Boolean) : [];
      if (values.length) merged[key] = [...new Set([...(merged[key] || []), ...values])];
    }
  }
  return Object.keys(merged).length ? merged : undefined;
}

function normalizeQuerySpecFeatures(features) {
  if (!features) return undefined;
  if (Array.isArray(features)) return { anyOf: features.filter(Boolean) };
  if (typeof features === 'object') return mergeAttributes(features);
  return undefined;
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);
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

function locationFilename(url) {
  if (!url) return null;
  const afterScheme = String(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const slash = afterScheme.indexOf('/');
  const key = slash >= 0 ? afterScheme.slice(slash + 1) : afterScheme;
  const base = key.split('/').filter(Boolean).pop();
  if (!base) return null;
  try { return decodeURIComponent(base); } catch { return base; }
}

async function resolvePublicCanvasContext(fastify, code, query = {}) {
  const resolved = await fastify.workspaceManager.resolvePublicCanvasShare(code);
  if (!resolved) return null;

  const { workspace, share } = resolved;
  if (!workspace.isActive) await workspace.start();

  // Prefer the immutable treeId; treeName is volatile (tree renames break it).
  const tree = workspace.getTree(share.treeId || share.treeName);
  const layer = tree.getLayerForPath(share.path);
  if (!layer || layer.type !== 'canvas' || layer.id !== share.layerId) {
    const error = new Error('Public canvas no longer exists');
    error.statusCode = 404;
    throw error;
  }

  // Scope key must match the tree type: a directory selector passed as
  // `context` is resolved against the CONTEXT tree (ctx: paths) and returns
  // nothing — the shared-directory-canvas-shows-no-documents bug.
  const isDirectory = tree.type === 'directory';
  const selector = isDirectory
    ? workspace.getDirectoryTreeSelector(share.path, tree.name)
    : workspace.getContextTreeSelector(share.path, tree.name);

  return {
    workspace,
    share,
    layer,
    tree,
    listSpec: {
      context: isDirectory ? null : selector,
      directory: isDirectory ? selector : null,
      attributes: mergeAttributes(
        normalizeQuerySpecFeatures(layer.querySpec?.features),
        buildAttributes(query)
      ),
      filters: [
        ...normalizeStringArray(layer.querySpec?.filters),
        ...normalizeStringArray(query.filters),
      ],
      limit: clampLimit(query.limit),
      offset: query.offset,
      page: query.page,
    },
  };
}

async function isDocumentVisibleOnPublicCanvas(workspace, listSpec, documentId) {
  const documents = await workspace.list({ ...listSpec, limit: MAX_PUBLIC_PAGE_SIZE });
  const data = Array.isArray(documents?.data) ? documents.data : (Array.isArray(documents) ? documents : []);
  return data.some((doc) => doc.id === documentId);
}

async function resolveWorkspaceId(fastify, userId, identifier) {
  if (!identifier) return null;
  if (UUID_RE.test(identifier)) return identifier;
  return await fastify.workspaceManager.resolveWorkspaceId(userId, identifier);
}

async function buildPublicCanvasPayload(fastify, code, query = {}) {
  const ctx = await resolvePublicCanvasContext(fastify, code, query);
  if (!ctx) return null;

  const { workspace, share, layer, tree, listSpec } = ctx;
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
          limit: { type: 'integer', default: DEFAULT_PUBLIC_CANVAS_LIMIT },
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

  fastify.get('/:code/documents/:docId/content', {
    schema: {
      params: {
        type: 'object',
        required: ['code', 'docId'],
        properties: {
          code: { type: 'string', maxLength: 8 },
          docId: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: {
          download: { type: 'string' },
          // Target a specific location/attachment URL of the document
          // (mirrors the workspace content route incl. its allowlist).
          url: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      let documentId;
      try { documentId = parseDocumentId(request.params.docId, 'Document ID parameter'); }
      catch (e) { const r = new ResponseObject().badRequest(e.message); return reply.code(r.statusCode).send(r.getResponse()); }

      const ctx = await resolvePublicCanvasContext(fastify, request.params.code);
      if (!ctx) {
        const response = new ResponseObject().notFound('Public canvas not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const visible = await isDocumentVisibleOnPublicCanvas(ctx.workspace, ctx.listSpec, documentId);
      if (!visible) {
        const response = new ResponseObject().notFound('Document not found on this canvas');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const doc = await ctx.workspace.get(documentId);
      if (!doc) {
        const response = new ResponseObject().notFound('Document not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // ?url= may only target this document's own bytes: its locations[] or an
      // embedded attachment (email) — same allowlist as the workspace route.
      const attachments = Array.isArray(doc.data?.attachments) ? doc.data.attachments : [];
      let attachment = null;
      if (request.query.url) {
        const ownUrls = new Set((doc.locations || []).map((l) => l?.url).filter(Boolean));
        attachment = attachments.find((a) => a?.url === request.query.url) || null;
        if (!ownUrls.has(request.query.url) && !attachment) {
          const response = new ResponseObject().forbidden('URL does not belong to this document');
          return reply.code(response.statusCode).send(response.getResponse());
        }
      }

      const resolved = await ctx.workspace.resolveDocument(doc, { stream: true, url: request.query.url });
      if (!resolved) {
        const response = new ResponseObject().notFound('No reachable location');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const mime = attachment?.contentType || (attachment ? 'application/octet-stream' : doc.metadata?.contentType) || 'application/octet-stream';
      const size = attachment ? attachment.size : doc.metadata?.size;
      const filename = attachment?.filename || locationFilename(resolved.url) || `document-${documentId}`;
      reply.header('Content-Type', mime);
      if (Number.isFinite(size)) reply.header('Content-Length', size);
      reply.header('Content-Disposition', `${request.query.download !== undefined ? 'attachment' : 'inline'}; filename="${String(filename).replace(/"/g, '')}"`);
      return reply.send(resolved.stream || resolved.buffer);
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to read public canvas document content');
      const response = error.statusCode === 404
        ? new ResponseObject().notFound(error.message)
        : new ResponseObject().serverError('Failed to read public canvas document content');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Public mirror of the on-demand document thumbnail (visibility-gated like
  // the content route above).
  fastify.get('/:code/documents/:docId/thumbnail', {
    schema: {
      params: {
        type: 'object',
        required: ['code', 'docId'],
        properties: {
          code: { type: 'string', maxLength: 8 },
          docId: { type: 'string' },
        },
      },
      querystring: {
        type: 'object',
        properties: { size: { type: 'integer', minimum: 16, maximum: 2048, default: 256 } },
      },
    },
  }, async (request, reply) => {
    try {
      let documentId;
      try { documentId = parseDocumentId(request.params.docId, 'Document ID parameter'); }
      catch (e) { const r = new ResponseObject().badRequest(e.message); return reply.code(r.statusCode).send(r.getResponse()); }

      const ctx = await resolvePublicCanvasContext(fastify, request.params.code);
      if (!ctx) {
        const response = new ResponseObject().notFound('Public canvas not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const visible = await isDocumentVisibleOnPublicCanvas(ctx.workspace, ctx.listSpec, documentId);
      if (!visible) {
        const response = new ResponseObject().notFound('Document not found on this canvas');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const doc = await ctx.workspace.get(documentId);
      if (!doc) {
        const response = new ResponseObject().notFound('Document not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const thumb = await ctx.workspace.getDocumentThumbnail(doc, request.query.size);
      if (!thumb) {
        const response = new ResponseObject().notFound('No thumbnail available for this document');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      reply.header('Content-Type', thumb.mime);
      reply.header('Content-Length', thumb.buffer.length);
      reply.header('Cache-Control', 'public, max-age=86400');
      return reply.send(thumb.buffer);
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to build public canvas document thumbnail');
      const response = error.statusCode === 404
        ? new ResponseObject().notFound(error.message)
        : new ResponseObject().serverError('Failed to build public canvas document thumbnail');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}

