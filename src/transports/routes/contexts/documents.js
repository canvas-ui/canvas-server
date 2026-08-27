'use strict';

import ResponseObject from '../../ResponseObject.js';
import { localDocumentIds, PLACEMENT_BUDGET, stampPlacement, treeOf } from '../../lib/placement.js';
import { parseDocumentId } from '../../../utils/documentId.js';
import { validateUser } from '../../auth/strategies.js';
import { stripDeviceFeatureTags } from '../../../utils/device-features.js';
import { normalizeSchemaId } from '../../../core/workspace/lib/classifier.js';

export default async function documentRoutes(fastify, _options) {
  function buildAttributes(query) {
    const { allOf, noneOf, anyOf } = query;
    if (!allOf?.length && !noneOf?.length && !anyOf?.length) return undefined;
    const attrs = {};
    if (allOf?.length) attrs.allOf = allOf;
    if (noneOf?.length) attrs.noneOf = noneOf;
    if (anyOf?.length) attrs.anyOf = anyOf;
    return attrs;
  }

  // `device/*` is engine-owned: synapsd DERIVES presence from a document's
  // locations. Clients neither assert it nor have it injected on their behalf —
  // we only strip what they should not be sending. Everything else passes
  // through verbatim, including the whole optional `client/*` namespace
  // (client/app/firefox, client/device/os/*, …) which consumers populate, or
  // don't, entirely at their own discretion.
  function enforceClientTags(request, features = []) {
    return stripDeviceFeatureTags(features);
  }

  fastify.addHook('preHandler', async (request, reply) => {
    try {
      validateUser(request.user, ['id']);
    } catch (err) {
      const response = new ResponseObject().unauthorized(err.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // ── List documents in context ───────────────────────────────────────────

  fastify.get('/', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          allOf: { type: 'array', items: { type: 'string' }, default: [] },
          noneOf: { type: 'array', items: { type: 'string' }, default: [] },
          anyOf: { type: 'array', items: { type: 'string' }, default: [] },
          filters: { type: 'array', items: { type: 'string' } },
          includeServerContext: { type: 'boolean' },
          includeClientContext: { type: 'boolean' },
          limit: { type: 'integer', default: 200 },
          offset: { type: 'integer' },
          page: { type: 'integer' },
          // Return document ids instead of documents — the cheap read a client
          // uses to check whether a cached result set is still current.
          idsOnly: { type: 'boolean', default: false },
          // Document lists default to newest first; search results stay ranked.
          order: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
          // Sort a listing by a named timeline (e.g. 'content' = EXIF capture
          // date, 'crud:created'); order applies to the timeline value.
          sortBy: { type: 'string' },
          q: { type: 'string' },
          search: { type: 'string' },
          mode: { type: 'string', enum: ['fts', 'vector', 'hybrid'] },
          // When false, don't fold the context's STORED binding — the caller is
          // driving filters itself (web live-preview). Bound clients omit it and
          // inherit the context's saved view. Default true.
          applyContextSpec: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const { filters = [] } = request.query;
      const attributes = buildAttributes(request.query);
      const options = {
        includeServerContext: request.query.includeServerContext,
        includeClientContext: request.query.includeClientContext,
        limit: request.query.limit,
        offset: request.query.offset,
        page: request.query.page,
        order: request.query.order,
        sortBy: request.query.sortBy,
        idsOnly: request.query.idsOnly,
      };

      const searchQuery = request.query.q || request.query.search;
      const spec = { attributes, filters, options, applyContextSpec: request.query.applyContextSpec };

      const dbResult = searchQuery
        ? await context.search(request.user.id, { query: searchQuery, mode: request.query.mode, ...spec })
        : await context.list(request.user.id, spec);

      if (dbResult.error) {
        fastify.log.error(`SynapsD error: ${dbResult.error}`);
        const response = new ResponseObject().error(`Failed to ${searchQuery ? 'search' : 'list'} documents due to a database error.`, dbResult.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // A context URL is a path into a tree, and a path lists its whole
      // subtree — so a context at mbag://dc-migration shows what is filed there
      // AND what is filed below it. `linkedHere` says which is which, so a
      // client rendering documents as files (canvas-fuse) gives the plain
      // filename to the document actually filed at this context's path.
      const payload = (searchQuery || request.query.idsOnly)
        ? dbResult
        : stampPlacement(dbResult, await localDocumentIds(
          (not) => context.list(request.user.id, {
            ...spec,
            paths: { not },
            options: { ...options, idsOnly: true, limit: PLACEMENT_BUDGET, offset: 0, page: undefined },
          }),
          treeOf(context.workspace, { tree: context.treeId }),
          context.path || '/',
        ));

      const response = new ResponseObject().success(payload, searchQuery ? 'Search results retrieved successfully' : 'Documents retrieved successfully', 200, dbResult.count, dbResult.totalCount);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = ResponseObject.fromError(error, `Failed to ${request.query.q || request.query.search ? 'search' : 'list'} documents`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // ── Insert documents into context ───────────────────────────────────────

  fastify.post('/', {
    onRequest: [fastify.authenticateClient],
    schema: {
      body: {
        oneOf: [
          {
            type: 'object',
            properties: {
              features: { type: 'array', items: { type: 'string' } },
              documents: { oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }] },
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
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const features = Array.isArray(request.body) ? [] : (request.body.features || []);
      const enforcedFeatures = enforceClientTags(request, features);

      // Ids link existing documents into the context; document objects are
      // inserted/updated. putMany expects full objects, so ids go via linkMany.
      let result;
      if (Array.isArray(request.body)) {
        result = await context.linkMany(request.user.id, request.body, enforcedFeatures);
      } else if (request.body.documentIds) {
        const ids = Array.isArray(request.body.documentIds) ? request.body.documentIds : [request.body.documentIds];
        result = await context.linkMany(request.user.id, ids, enforcedFeatures);
      } else if (request.body.documents) {
        const docs = Array.isArray(request.body.documents) ? request.body.documents : [request.body.documents];
        result = await context.putMany(request.user.id, docs, enforcedFeatures);
      } else {
        const response = new ResponseObject().badRequest('Body must include either "documents" or "documentIds", or be an array of IDs');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().created(result, 'Documents inserted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = ResponseObject.fromError(error, 'Failed to insert documents');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // ── Update documents in context ─────────────────────────────────────────

  fastify.put('/', {
    onRequest: [fastify.authenticateClient],
    schema: {
      body: {
        type: 'object',
        properties: {
          documents: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { anyOf: [{ type: 'string' }, { type: 'number' }] } } } },
          documentIds: {
            anyOf: [
              { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] }, minItems: 1 },
              { type: 'string' },
              { type: 'number' },
            ],
          },
          features: { type: 'array', items: { type: 'string' } },
        },
        anyOf: [{ required: ['documents'] }, { required: ['documentIds'] }],
      },
    },
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const { features = [] } = request.body;
      const enforcedFeatures = enforceClientTags(request, features);

      let itemsToUpdate;
      if (request.body.documents) {
        itemsToUpdate = Array.isArray(request.body.documents) ? request.body.documents : [request.body.documents];
      } else if (request.body.documentIds) {
        itemsToUpdate = Array.isArray(request.body.documentIds) ? request.body.documentIds : [request.body.documentIds];
      } else {
        const response = new ResponseObject().badRequest('Body must include either "documents" or "documentIds"');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const result = await context.putMany(request.user.id, itemsToUpdate, enforcedFeatures);

      const response = new ResponseObject().updated(result, 'Documents updated successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = ResponseObject.fromError(error, 'Failed to update documents');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // ── Delete documents ────────────────────────────────────────────────────

  fastify.delete('/', {
    onRequest: [fastify.authenticate],
    schema: {
      body: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] }, minItems: 1 },
    },
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found or user is not owner (required for direct DB deletion).`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (request.body === undefined || request.body === null) {
        const response = new ResponseObject().badRequest('Request body is required.');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const documentIdArray = Array.isArray(request.body) ? request.body : [request.body];
      const result = await context.deleteMany(request.user.id, documentIdArray);

      const response = new ResponseObject().deleted(result, 'Documents deleted from database successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = ResponseObject.fromError(error, 'Failed to delete documents from database');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // ── Remove documents from context ───────────────────────────────────────

  fastify.delete('/remove', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          allOf: { type: 'array', items: { type: 'string' }, default: [] },
          noneOf: { type: 'array', items: { type: 'string' }, default: [] },
          anyOf: { type: 'array', items: { type: 'string' }, default: [] },
        },
      },
      body: {
        type: 'array',
        items: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        minItems: 1,
      },
    },
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      if (request.body === undefined || request.body === null) {
        const response = new ResponseObject().badRequest('Request body is required.');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const documentIdArray = Array.isArray(request.body) ? request.body : [request.body];
      const attributes = buildAttributes(request.query);
      const result = await context.unlinkMany(request.user.id, documentIdArray, attributes);

      if (result.failed.length > 0 && result.successful.length === 0) {
        const response = new ResponseObject().badRequest('Failed to remove documents from context');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success(result, 'Documents removed from context successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = ResponseObject.fromError(error, 'Failed to remove documents from context');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // ── Get documents by abstraction ────────────────────────────────────────

  fastify.get('/by-abstraction/:abstraction', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', required: ['abstraction'], properties: { abstraction: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          allOf: { type: 'array', items: { type: 'string' }, default: [] },
          noneOf: { type: 'array', items: { type: 'string' }, default: [] },
          anyOf: { type: 'array', items: { type: 'string' }, default: [] },
          filters: { type: 'array', items: { type: 'string' } },
          includeServerContext: { type: 'boolean' },
          includeClientContext: { type: 'boolean' },
          limit: { type: 'integer', default: 200 },
          offset: { type: 'integer' },
          page: { type: 'integer' },
        },
      },
    },
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const attrs = buildAttributes(request.query) || {};
      // normalizeSchemaId maps short names onto the hierarchical ids (`email`
      // -> data/schema/message/email), which plain prefix-concat cannot.
      const allOf = [normalizeSchemaId(request.params.abstraction), ...(attrs.allOf || [])];
      const { filters = [], includeServerContext, includeClientContext, limit, offset, page } = request.query;

      const dbResult = await context.list(request.user.id, {
        attributes: { ...attrs, allOf },
        filters,
        options: { includeServerContext, includeClientContext, limit, offset, page },
      });

      if (dbResult.error) {
        fastify.log.error(`SynapsD error in listDocuments (by-abstraction): ${dbResult.error}`);
        const response = new ResponseObject().error('Failed to list documents by abstraction due to a database error.', dbResult.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success(dbResult, 'Documents retrieved successfully by abstraction', 200, dbResult.count, dbResult.totalCount);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = ResponseObject.fromError(error, 'Failed to get documents by abstraction');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // ── Get document by ID ──────────────────────────────────────────────────

  fastify.get('/:docId', {
    onRequest: [fastify.authenticate],
    schema: { params: { type: 'object', required: ['docId'], properties: { docId: { type: 'string' } } } },
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const document = await context.getDocumentById(request.user.id, request.params.docId);
      if (!document) {
        const response = new ResponseObject().notFound(`Document with ID '${request.params.docId}' not found in context '${contextId}'.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success(document, 'Document retrieved successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = ResponseObject.fromError(error, 'Failed to get document by ID');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // ── Delete single document by ID ────────────────────────────────────────

  fastify.delete('/:docId', {
    onRequest: [fastify.authenticate],
    schema: { params: { type: 'object', required: ['docId'], properties: { docId: { anyOf: [{ type: 'string' }, { type: 'number' }] } } } },
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      let documentId;
      try {
        documentId = parseDocumentId(request.params.docId, 'Document ID parameter');
      } catch (error) {
        const response = new ResponseObject().badRequest(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const result = await context.deleteMany(request.user.id, [documentId]);
      const response = new ResponseObject().deleted(result, 'Document deleted from database successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = ResponseObject.fromError(error, 'Failed to delete document from database');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // ── Get document by hash ────────────────────────────────────────────────

  fastify.get('/by-hash/:algo/:hash', {
    onRequest: [fastify.authenticate],
    schema: { params: { type: 'object', required: ['algo', 'hash'], properties: { algo: { type: 'string' }, hash: { type: 'string' } } } },
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found or not accessible.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const checksumString = `${request.params.algo}/${request.params.hash}`;
      const document = await context.getByChecksumString(request.user.id, checksumString);

      if (!document) {
        const response = new ResponseObject().notFound(`Document with checksum '${checksumString}' not found via context '${contextId}'.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success(document, 'Document retrieved successfully by hash');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = ResponseObject.fromError(error, 'Failed to get document by hash');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
