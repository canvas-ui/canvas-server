'use strict';

import ResponseObject from '../../ResponseObject.js';
import { parseDocumentId, parseDocumentIdArray } from '../../../utils/documentId.js';
import { mergeDeviceFeatureTags } from '../../../utils/device-features.js';
import {
  INCOMING_TREE_NAME,
  shouldExcludeIncoming,
} from '../../../utils/incoming-documents.js';

/**
 * Workspace document routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceDocumentRoutes(fastify, options) {
  function enforceClientTags(request, features = []) {
    return mergeDeviceFeatureTags(features, request.client);
  }

  function resolveContextSelector(workspace, source = {}, fallbackPath = '/') {
    const path = source?.context ?? fallbackPath;
    if (!path || path === '/') { return null; }
    const treeNameOrId = source?.treeNameOrTreeId ?? null;
    const treeType = source?.treeType ?? null;

    if (treeType === 'directory') {
      return workspace.getDirectoryTreeSelector(path, treeNameOrId);
    }
    if (!treeType && treeNameOrId) {
      // Fallback: detect type from the tree itself to avoid hard errors
      try {
        const tree = workspace.getTree(treeNameOrId);
        if (tree.type === 'directory') {
          return workspace.getDirectoryTreeSelector(path, treeNameOrId);
        }
      } catch (_) { /* unknown tree — let getContextTreeSelector handle the error */ }
    }
    return workspace.getContextTreeSelector(path, treeNameOrId);
  }

  function buildReadOptions(contextSelector, includeIncoming, options = {}) {
    if (!shouldExcludeIncoming(contextSelector?.path, includeIncoming)) {
      return options;
    }
    return { ...options, excludeTree: { tree: INCOMING_TREE_NAME } };
  }

  function getInsertContextSelector(workspace, body, isTopLevelArray) {
    if (isTopLevelArray) { return workspace.getContextTreeSelector('/'); }
    if (body?.context || body?.treeNameOrTreeId) {
      return resolveContextSelector(workspace, body, '/');
    }
    if (body?.documents || body?.documentIds) { return workspace.getContextTreeSelector('/'); }
    return null;
  }

  async function getWorkspaceInstance(request, reply) {
    const identifier = request.params.id;
    const userId = request.user.id;
    const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
    const workspaceId = isWorkspaceId ? identifier : await fastify.workspaceManager.resolveWorkspaceId(userId, identifier);
    if (!workspaceId) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }
    const workspace = await fastify.workspaceManager.getWorkspace(workspaceId, userId);
    if (!workspace) {
      const responseObject = new ResponseObject().notFound(`Workspace with ID ${identifier} not found`);
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }

    if (!workspace.isActive) {
      const responseObject = new ResponseObject().badRequest('Workspace is not active. Start the workspace first.');
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }

    return workspace;
  }

  function buildAttributes(query) {
    const { allOf, noneOf, anyOf } = query;
    if (!allOf?.length && !noneOf?.length && !anyOf?.length) return undefined;
    const attrs = {};
    if (allOf?.length) attrs.allOf = allOf;
    if (noneOf?.length) attrs.noneOf = noneOf;
    if (anyOf?.length) attrs.anyOf = anyOf;
    return attrs;
  }

  // ── Shared querystring schema fragments ──────────────────────────────────

  const contextQueryProps = {
    treeNameOrTreeId: { type: 'string' },
    treeType: { type: 'string', enum: ['context', 'directory'] },
    context: { type: 'string', default: '/' },
  };

  const arrayOfStrings = { type: 'array', items: { type: 'string' }, default: [] };

  const attributesQueryProps = {
    allOf: arrayOfStrings,
    noneOf: arrayOfStrings,
    anyOf: arrayOfStrings,
  };

  const filtersQueryProps = {
    filters: { type: 'array', items: { type: 'string' }, default: [] },
  };

  const paginationQueryProps = {
    limit: { type: 'integer', default: 200 },
    offset: { type: 'integer' },
    page: { type: 'integer' },
  };

  // ── List documents ──────────────────────────────────────────────────────

  fastify.get('/', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          ...contextQueryProps,
          ...attributesQueryProps,
          ...filtersQueryProps,
          ...paginationQueryProps,
          q: { type: 'string' },
          search: { type: 'string' },
          includeIncoming: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const contextSelector = resolveContextSelector(workspace, request.query, '/');
      const searchQuery = request.query.q || request.query.search;

      const spec = {
        context: contextSelector,
        attributes: buildAttributes(request.query),
        filters: request.query.filters,
        ...buildReadOptions(contextSelector, request.query.includeIncoming, {
          limit: request.query.limit,
          offset: request.query.offset,
          page: request.query.page,
        }),
      };

      const documents = searchQuery
        ? await workspace.search({ query: searchQuery, ...spec })
        : await workspace.find(spec);

      if (documents.error) {
        fastify.log.error(`SynapsD error: ${documents.error}`);
        const responseObject = new ResponseObject().error(`Failed to ${searchQuery ? 'search' : 'list'} documents due to a database error.`, documents.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(documents, searchQuery ? 'Search results retrieved successfully' : 'Documents retrieved successfully', 200, documents.count, documents.totalCount);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to list documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Insert documents ────────────────────────────────────────────────────

  fastify.post('/', {
    onRequest: [fastify.authenticateClient],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        oneOf: [
          {
            type: 'object',
            properties: {
              treeNameOrTreeId: { type: 'string' },
              context: { type: 'string' },
              features: { type: 'array', items: { type: 'string' } },
              documents: { oneOf: [{ type: 'object' }, { type: 'array' }] },
              documentIds: {
                anyOf: [
                  { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] }, minItems: 1 },
                  { type: 'string' },
                  { type: 'number' },
                ],
              },
            },
            anyOf: [{ required: ['documents'] }, { required: ['documentIds'] }],
          },
          {
            type: 'array',
            items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            minItems: 1,
          },
        ],
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const isTopLevelArray = Array.isArray(request.body);
      const contextSelector = getInsertContextSelector(workspace, request.body, isTopLevelArray);
      const features = isTopLevelArray ? [] : (request.body.features || []);
      const enforcedFeatures = enforceClientTags(request, features);

      let itemsToInsert;
      if (isTopLevelArray) {
        itemsToInsert = request.body;
      } else if (request.body.documentIds) {
        itemsToInsert = Array.isArray(request.body.documentIds) ? request.body.documentIds : [request.body.documentIds];
      } else if (request.body.documents) {
        itemsToInsert = Array.isArray(request.body.documents) ? request.body.documents : [request.body.documents];
      } else {
        const responseObject = new ResponseObject().badRequest('Body must include either "documents" or "documentIds", or be an array of IDs');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const documents = await workspace.putMany(itemsToInsert, {
        context: contextSelector,
        features: enforcedFeatures,
      });

      const responseObject = new ResponseObject().created(documents, 'Documents inserted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to insert documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Get document by ID (by-id route) ────────────────────────────────────

  fastify.get('/by-id/:docId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'number' } } },
      querystring: {
        type: 'object',
        properties: { ...contextQueryProps, ...attributesQueryProps },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const contextSelector = resolveContextSelector(workspace, request.query, '/');

      const document = await workspace.get(request.params.docId);
      if (!document) {
        const responseObject = new ResponseObject().notFound(`Document with ID ${request.params.docId} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const matchesScope = await workspace.has(document.id, {
        context: contextSelector,
        attributes: buildAttributes(request.query),
      });
      if (!matchesScope) {
        const responseObject = new ResponseObject().notFound(`Document with ID ${request.params.docId} not found in the selected tree/path scope`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(document, 'Document retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get document');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Get documents by abstraction ────────────────────────────────────────

  fastify.get('/by-abstraction/:abstraction', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'abstraction'], properties: { id: { type: 'string' }, abstraction: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          ...contextQueryProps,
          ...attributesQueryProps,
          ...filtersQueryProps,
          ...paginationQueryProps,
          includeIncoming: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const contextSelector = resolveContextSelector(workspace, request.query, '/');
      const attrs = buildAttributes(request.query) || {};
      const allOf = [`data/abstraction/${request.params.abstraction}`, ...(attrs.allOf || [])];

      const documents = await workspace.find({
        context: contextSelector,
        attributes: { ...attrs, allOf },
        filters: request.query.filters,
        ...buildReadOptions(contextSelector, request.query.includeIncoming, {
          limit: request.query.limit,
          offset: request.query.offset,
          page: request.query.page,
        }),
      });

      if (documents.error) {
        fastify.log.error(`SynapsD error in findDocuments (by-abstraction): ${documents.error}`);
        const responseObject = new ResponseObject().error('Failed to list documents by abstraction due to a database error.', documents.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(documents, 'Documents retrieved successfully', 200, documents.count, documents.totalCount);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Update documents ────────────────────────────────────────────────────

  fastify.put('/', {
    onRequest: [fastify.authenticateClient],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          treeNameOrTreeId: { type: 'string' },
          context: { type: 'string', default: '/' },
          features: { type: 'array', items: { type: 'string' }, default: [] },
          documents: { type: 'array' },
          documentIds: {
            anyOf: [
              { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] }, minItems: 1 },
              { type: 'string' },
              { type: 'number' },
            ],
          },
        },
        anyOf: [{ required: ['documents'] }, { required: ['documentIds'] }],
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      let itemsToUpdate;
      if (request.body.documents) {
        itemsToUpdate = Array.isArray(request.body.documents) ? request.body.documents : [request.body.documents];
      } else if (request.body.documentIds) {
        itemsToUpdate = Array.isArray(request.body.documentIds) ? request.body.documentIds : [request.body.documentIds];
      } else {
        const responseObject = new ResponseObject().badRequest('Body must include either "documents" or "documentIds"');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const contextSelector = resolveContextSelector(workspace, request.body, '/');
      const result = await workspace.putMany(itemsToUpdate, {
        context: contextSelector,
        features: request.body.features || [],
      });
      if (!result) {
        const responseObject = new ResponseObject().badRequest('Failed to update documents');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(result, 'Documents updated successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to update documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Delete documents ────────────────────────────────────────────────────

  fastify.delete('/', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: { type: 'object', properties: { ...contextQueryProps, ...attributesQueryProps } },
      body: {
        type: 'array',
        items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        minItems: 1,
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const contextSelector = resolveContextSelector(workspace, request.query, '/');

      const rawIds = Array.isArray(request.body) ? request.body : [request.body];
      let documentIds;
      try {
        documentIds = parseDocumentIdArray(rawIds, 'Document ID array');
      } catch (e) {
        const responseObject = new ResponseObject().badRequest(e.message);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const result = await workspace.deleteMany(documentIds);

      if (result?.failed?.length) {
        fastify.log.warn({
          workspace: request.params.id,
          userId: request.user?.id,
          op: 'workspace.documents.delete',
          requested: documentIds.length,
          successful: result.successful?.length || 0,
          failed: result.failed?.length || 0,
          failedSamples: (result.failed || []).slice(0, 5),
        }, 'Workspace document delete had failures');
      }

      const message = (result?.successful?.length || 0) > 0
        ? 'Documents deleted successfully'
        : 'No documents deleted (not found or already deleted)';

      const responseObject = new ResponseObject().deleted(result, message, 200, result?.count ?? documentIds.length);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to delete documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Purge documents ─────────────────────────────────────────────────────

  fastify.delete('/purge', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          ...contextQueryProps,
          ...attributesQueryProps,
          ...filtersQueryProps,
          includeIncoming: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const contextSelector = resolveContextSelector(workspace, request.query, '/');

      const attributes = buildAttributes(request.query);
      const matches = await workspace.find({
        context: contextSelector,
        attributes,
        filters: request.query.filters,
        ...buildReadOptions(contextSelector, request.query.includeIncoming, { parse: false, limit: 0 }),
      });

      if (matches.error) {
        fastify.log.error(`SynapsD error in purge: ${matches.error}`);
        const responseObject = new ResponseObject().error('Failed to purge documents due to a database error.', matches.error);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const documentIds = matches.map(d => Number(d?.id)).filter(id => Number.isInteger(id) && id > 0);

      if (documentIds.length === 0) {
        const responseObject = new ResponseObject().success({ requested: 0, deleted: 0, result: { successful: [], failed: [], count: 0 } }, 'No matching documents to purge');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const result = await workspace.deleteMany(documentIds, { emitEvent: false });

      const responseObject = new ResponseObject().deleted({ requested: documentIds.length, deleted: result?.successful?.length || 0, result }, 'Documents purged successfully', 200, result?.successful?.length || 0);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to purge documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Remove documents (unlink from tree) ─────────────────────────────────

  fastify.delete('/remove', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: { type: 'object', properties: { ...contextQueryProps, ...attributesQueryProps } },
      body: {
        type: 'array',
        items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        minItems: 1,
      },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const contextSelector = resolveContextSelector(workspace, request.query, '/');

      const rawIds = Array.isArray(request.body) ? request.body : [request.body];
      let documentIds;
      try {
        documentIds = parseDocumentIdArray(rawIds, 'Document ID array');
      } catch (e) {
        const responseObject = new ResponseObject().badRequest(e.message);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const attributes = buildAttributes(request.query);
      const result = await workspace.unlinkMany(documentIds, {
        context: contextSelector,
        attributes,
      });

      if (result?.failed?.length) {
        fastify.log.warn({
          workspace: request.params.id,
          userId: request.user?.id,
          op: 'workspace.documents.remove',
          context: contextSelector,
          requested: documentIds.length,
          successful: result.successful?.length || 0,
          failed: result.failed?.length || 0,
          failedSamples: (result.failed || []).slice(0, 5),
        }, 'Workspace document remove had failures');
      }

      const message = (result?.successful?.length || 0) > 0
        ? 'Documents removed successfully'
        : 'No documents removed (not found or already removed)';

      const responseObject = new ResponseObject().deleted(result, message, 200, result?.count ?? documentIds.length);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to remove documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Get document by ID (direct route) ───────────────────────────────────

  fastify.get('/:docId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'docId'], properties: { id: { type: 'string' }, docId: { type: 'string' } } },
      querystring: { type: 'object', properties: { ...contextQueryProps, ...attributesQueryProps } },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      let documentId;
      try {
        documentId = parseDocumentId(request.params.docId, 'Document ID parameter');
      } catch (error) {
        const responseObject = new ResponseObject().badRequest(error.message);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const document = await workspace.get(documentId);
      if (!document) {
        const responseObject = new ResponseObject().notFound(`Document with ID ${request.params.docId} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(document, 'Document retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get document');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Get document by hash ────────────────────────────────────────────────

  fastify.get('/by-hash/:algo/:hash', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id', 'algo', 'hash'], properties: { id: { type: 'string' }, algo: { type: 'string' }, hash: { type: 'string' } } },
      querystring: { type: 'object', properties: { ...contextQueryProps, ...attributesQueryProps } },
    },
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;
      const contextSelector = resolveContextSelector(workspace, request.query, '/');

      const checksumString = `${request.params.algo}/${request.params.hash}`;
      const document = await workspace.getByChecksumString(checksumString);
      if (!document) {
        const responseObject = new ResponseObject().notFound(`Document with checksum ${checksumString} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const matchesScope = await workspace.hasByChecksumString(checksumString, {
        context: contextSelector,
        attributes: buildAttributes(request.query),
      });
      if (!matchesScope) {
        const responseObject = new ResponseObject().notFound(`Document with checksum ${checksumString} not found in the selected tree/path scope`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().found(document, 'Document retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get document by hash');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // ── Clear workspace database (DEVELOPMENT ONLY) ─────────────────────────

  fastify.delete('/clear-database', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (request, reply) => {
    if (process.env.NODE_ENV !== 'development') {
      const responseObject = new ResponseObject().forbidden('Database clear operation only available in development mode');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }

    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      if (!workspace.isActive) {
        fastify.log.info(`Workspace ${request.params.id} is not active, attempting to start...`);
        try {
          await workspace.start();
          fastify.log.info(`Workspace ${request.params.id} started successfully`);
        } catch (startError) {
          fastify.log.error(`Failed to start workspace ${request.params.id}: ${startError.message}`);
          const responseObject = new ResponseObject().serverError(`Failed to start workspace: ${startError.message}`);
          return reply.code(responseObject.statusCode).send(responseObject.getResponse());
        }
      }

      const result = workspace.clearDatabaseSync();
      const responseObject = new ResponseObject().success(result, 'Workspace database cleared successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to clear workspace database');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
