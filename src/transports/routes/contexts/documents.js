'use strict';

import ResponseObject from '../../ResponseObject.js';
import { parseDocumentId } from '../../../utils/documentId.js';
import { validateUser } from '../../auth/strategies.js';
import { mergeDeviceFeatureTags } from '../../../utils/device-features.js';

export default async function documentRoutes(fastify, options) {
  function buildAttributes(query) {
    const { allOf, noneOf, anyOf } = query;
    if (!allOf?.length && !noneOf?.length && !anyOf?.length) return undefined;
    const attrs = {};
    if (allOf?.length) attrs.allOf = allOf;
    if (noneOf?.length) attrs.noneOf = noneOf;
    if (anyOf?.length) attrs.anyOf = anyOf;
    return attrs;
  }

  function enforceClientTags(request, features = []) {
    return mergeDeviceFeatureTags(features, request.client);
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
          q: { type: 'string' },
          search: { type: 'string' },
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
      };

      const searchQuery = request.query.q || request.query.search;
      const spec = { attributes, filters, options };

      const dbResult = searchQuery
        ? await context.search(request.user.id, { query: searchQuery, ...spec })
        : await context.find(request.user.id, spec);

      if (dbResult.error) {
        fastify.log.error(`SynapsD error: ${dbResult.error}`);
        const response = new ResponseObject().error(`Failed to ${searchQuery ? 'search' : 'list'} documents due to a database error.`, dbResult.error);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success(dbResult, searchQuery ? 'Search results retrieved successfully' : 'Documents retrieved successfully', 200, dbResult.count, dbResult.totalCount);
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      if (error.message.startsWith('Access denied')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error(`Failed to ${request.query.q || request.query.search ? 'search' : 'list'} documents`);
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

      let itemsToInsert;
      if (Array.isArray(request.body)) {
        itemsToInsert = request.body;
      } else if (request.body.documentIds) {
        itemsToInsert = Array.isArray(request.body.documentIds) ? request.body.documentIds : [request.body.documentIds];
      } else if (request.body.documents) {
        itemsToInsert = Array.isArray(request.body.documents) ? request.body.documents : [request.body.documents];
      } else {
        const response = new ResponseObject().badRequest('Body must include either "documents" or "documentIds", or be an array of IDs');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const result = await context.putMany(request.user.id, itemsToInsert, enforcedFeatures);

      const response = new ResponseObject().created(result, 'Documents inserted successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      if (error.message.startsWith('Access denied')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to insert documents');
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
          documents: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
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
      if (error.message.startsWith('Access denied')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to update documents');
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
      if (error.message.startsWith('Access denied')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to delete documents from database');
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
      if (error.message.startsWith('Access denied')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to remove documents from context');
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
      const allOf = [`data/abstraction/${request.params.abstraction}`, ...(attrs.allOf || [])];
      const { filters = [], includeServerContext, includeClientContext, limit, offset, page } = request.query;

      const dbResult = await context.find(request.user.id, {
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
      if (error.message.startsWith('Access denied')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to get documents by abstraction');
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
      if (error.message.startsWith('Access denied')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to get document by ID');
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
      if (error.message.startsWith('Access denied')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to delete document from database');
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
      if (error.message.startsWith('Access denied')) {
        const response = new ResponseObject().forbidden(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }
      const response = new ResponseObject().error('Failed to get document by hash');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
