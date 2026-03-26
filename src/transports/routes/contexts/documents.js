'use strict';

import ResponseObject from '../../ResponseObject.js';
import { parseDocumentId } from '../../../utils/documentId.js';
import { validateUser } from '../../auth/strategies.js';
import { mergeDeviceFeatureTags } from '../../../utils/device-features.js';

export default async function documentRoutes(fastify, options) {
  function enforceClientTags(request, featureArray = []) {
    return mergeDeviceFeatureTags(featureArray, request.client);
  }

  // Add a pre-handler hook to ensure user is authenticated and valid for all context document routes
  fastify.addHook('preHandler', async (request, reply) => {
    try {
      // The `authenticate` hook should have already run and populated `request.user`
      // We just need to validate it has the required fields for our operations.
      validateUser(request.user, ['id']); // For context operations, we primarily need the user's ID.
    } catch (err) {
      // If validateUser throws, it means the user object is invalid.
      const response = new ResponseObject().unauthorized(err.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });


  // Document routes will be added here

  // List documents in context
  // Path: / (relative to /:id/documents)
  fastify.get('/', {
    onRequest: [fastify.authenticate],
    schema: {
      // params.id is implicitly available from the prefix in index.js
      querystring: {
        type: 'object',
        properties: {
          featureArray: {
            type: 'array',
            items: { type: 'string' }
          },
          filterArray: {
            type: 'array',
            items: { type: 'string' }
          },
          includeServerContext: { type: 'boolean' },
          includeClientContext: { type: 'boolean' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          page: { type: 'integer' },
          q: { type: 'string' },
          search: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const { featureArray = [], filterArray = [] } = request.query;
      const options = {
        includeServerContext: request.query.includeServerContext,
        includeClientContext: request.query.includeClientContext,
        limit: request.query.limit,
        offset: request.query.offset,
        page: request.query.page
      };

      // Check if this is a search query
      const searchQuery = request.query.q || request.query.search;
      let dbResult;

      if (searchQuery) {
        dbResult = await context.search(request.user.id, {
          query: searchQuery,
          featureArray,
          filterArray,
          options,
        });
      } else {
        dbResult = await context.find(request.user.id, {
          featureArray,
          filterArray,
          options,
        });
      }

      if (dbResult.error) {
        fastify.log.error(`SynapsD error in ${searchQuery ? 'ftsQuery' : 'listDocuments'}: ${dbResult.error}`);
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

  // Insert documents into context
  // Path: / (relative to /:id/documents)
  fastify.post('/', {
    onRequest: [fastify.authenticateClient],
    schema: {
      body: {
        oneOf: [
          {
            type: 'object',
            properties: {
              featureArray: {
                type: 'array',
                items: { type: 'string' }
              },
              // Original direct insert (full docs)
              documents: {
                oneOf: [
                  { type: 'object' },
                  {
                    type: 'array',
                    items: { type: 'object' }
                  }
                ]
              },
              // New: paste existing docs by ID
              documentIds: {
                anyOf: [
                  {
                    type: 'array',
                    items: {
                      anyOf: [
                        { type: 'string' },
                        { type: 'number' }
                      ]
                    },
                    minItems: 1
                  },
                  { type: 'string' },
                  { type: 'number' }
                ]
              }
            },
            anyOf: [
              { required: ['documents'] },
              { required: ['documentIds'] }
            ]
          },
          {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                { type: 'number' }
              ]
            },
            minItems: 1,
            description: 'Top-level array of document IDs to insert into the current context (paste operation).'
          }
        ]
      }
    }
  }, async (request, reply) => {
    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound('Context not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Support featureArray only when object body is used; default to [] for top-level array mode
      const featureArray = Array.isArray(request.body) ? [] : (request.body.featureArray || []);
      const enforcedFeatureArray = enforceClientTags(request, featureArray);

      // Determine the payload to insert: can be IDs or full documents
      let itemsToInsert;
      if (Array.isArray(request.body)) {
        // Top-level array of IDs
        itemsToInsert = request.body;
      } else if (request.body.documentIds) {
        // IDs provided in object form
        itemsToInsert = Array.isArray(request.body.documentIds) ? request.body.documentIds : [request.body.documentIds];
      } else if (request.body.documents) {
        // Full documents provided
        itemsToInsert = Array.isArray(request.body.documents) ? request.body.documents : [request.body.documents];
      } else {
        const response = new ResponseObject().badRequest('Body must include either "documents" or "documentIds", or be an array of IDs');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Directly pass IDs or documents to SynapsD; IDs are now supported natively
      const result = await context.putMany(request.user.id, itemsToInsert, enforcedFeatureArray);

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

  // Update documents in context
  // Path: / (relative to /:id/documents)
  fastify.put('/', {
    onRequest: [fastify.authenticateClient],
    schema: {
      // params.id is implicitly available
      body: {
        type: 'object',
        properties: {
          documents: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id'],
              properties: {
                id: { type: 'string' }
                // other properties of document to update
              }
            }
          },
          documentIds: {
            anyOf: [
              {
                type: 'array',
                items: {
                  anyOf: [
                    { type: 'string' },
                    { type: 'number' }
                  ]
                },
                minItems: 1
              },
              { type: 'string' },
              { type: 'number' }
            ]
          },
          featureArray: { type: 'array', items: { type: 'string' } }
        },
        anyOf: [
          { required: ['documents'] },
          { required: ['documentIds'] }
        ]
      }
    }
  }, async (request, reply) => {

    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const { featureArray = [] } = request.body;
      const enforcedFeatureArray = enforceClientTags(request, featureArray);

      // Determine what to update: either documents or documentIds
      let itemsToUpdate;
      if (request.body.documents) {
        itemsToUpdate = Array.isArray(request.body.documents) ? request.body.documents : [request.body.documents];
      } else if (request.body.documentIds) {
        itemsToUpdate = Array.isArray(request.body.documentIds) ? request.body.documentIds : [request.body.documentIds];
      } else {
        const response = new ResponseObject().badRequest('Body must include either "documents" or "documentIds"');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const result = await context.putMany(request.user.id, itemsToUpdate, enforcedFeatureArray);

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

  // Delete documents from context (direct DB deletion)
  // Path: / (relative to /:id/documents) - consider a more specific path like /direct-delete if / is overloaded
  fastify.delete('/', {
    onRequest: [fastify.authenticate],
    schema: {
      // params.id is implicitly available
      body: {
        type: 'array',
        items: {
          anyOf: [
            { type: 'string' },
            { type: 'number' }
          ]
        },
        minItems: 1,
        description: "An array of document IDs to delete directly from the database."
      }
    }
  }, async (request, reply) => {

    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found or user is not owner (required for direct DB deletion).`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Validate that we have a body
      if (request.body === undefined || request.body === null) {
        const response = new ResponseObject().badRequest('Request body is required.');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Normalize input to array format
      const documentIdArray = Array.isArray(request.body) ? request.body : [request.body];

      // Let the Context.deleteDocumentArrayFromDb method handle the ID validation and conversion
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

  // Remove documents from context
  // Path: /remove (relative to /:id/documents)
  fastify.delete('/remove', {
    onRequest: [fastify.authenticate],
    schema: {
      // params.id is implicitly available
      querystring: {
        type: 'object',
        properties: {
          featureArray: {
            type: 'array',
            items: { type: 'string' },
            default: []
          }
        }
      },
      body: {
        type: 'array',
        items: {
          anyOf: [
            { type: 'string' },
            { type: 'number' }
          ]
        },
        minItems: 1,
        description: "An array of document IDs to remove from the context."
      }
    }
  }, async (request, reply) => {

    const contextId = request.params.id;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Validate that we have a body
      if (request.body === undefined || request.body === null) {
        const response = new ResponseObject().badRequest('Request body is required.');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Normalize input to array format
      const documentIdArray = Array.isArray(request.body) ? request.body : [request.body];

      // Let the Context.removeDocumentArray method handle the ID validation and conversion
      const result = await context.unlinkMany(
        request.user.id,
        documentIdArray,
        request.query.featureArray || []
      );

      // Check if any documents were successfully removed
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

  // Get documents by abstraction
  // Path: /by-abstraction/:abstraction (relative to /:id/documents)
  fastify.get('/by-abstraction/:abstraction', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['abstraction'], // id is from prefix
        properties: {
          // id: { type: 'string' },
          abstraction: { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          featureArray: {
            type: 'array',
            items: { type: 'string' },
            default: []
          },
          filterArray: {
            type: 'array',
            items: { type: 'string' }
          },
          includeServerContext: { type: 'boolean' },
          includeClientContext: { type: 'boolean' },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          page: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {

    const contextId = request.params.id;
    const abstraction = request.params.abstraction;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Create derived feature array with abstraction path and merge with additional features
      const derivedFeatureArray = [`data/abstraction/${abstraction}`, ...request.query.featureArray];
      const { filterArray = [], includeServerContext, includeClientContext, limit, offset, page } = request.query;
      const options = {
        includeServerContext,
        includeClientContext,
        limit,
        offset,
        page
      };

      const dbResult = await context.find(request.user.id, {
        featureArray: derivedFeatureArray,
        filterArray,
        options,
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

  // Get document by ID (direct route)
  // Path: /:docId (relative to /:id/documents)
  fastify.get('/:docId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['docId'], // id is from prefix
        properties: {
          docId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {

    const contextId = request.params.id;
    const docId = request.params.docId;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const document = await context.getDocumentById(request.user.id, docId);

      if (!document) {
        const response = new ResponseObject().notFound(`Document with ID '${docId}' not found in context '${contextId}'.`);
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

  // Delete single document by ID
  // Path: /:docId (relative to /:id/documents)
  fastify.delete('/:docId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['docId'],
        properties: {
          docId: {
            anyOf: [
              { type: 'string' },
              { type: 'number' }
            ]
          }
        }
      }
    }
  }, async (request, reply) => {
    const contextId = request.params.id;
    const docId = request.params.docId;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Parse and validate document ID
      let documentId;
      try {
        documentId = parseDocumentId(docId, 'Document ID parameter');
      } catch (error) {
        const response = new ResponseObject().badRequest(error.message);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      // Delete the document from database (direct deletion)
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

  // Get document by hash (owner-only direct DB access)
  // Path: /by-hash/:algo/:hash (relative to /:id/documents)
  fastify.get('/by-hash/:algo/:hash', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['algo', 'hash'], // id is from prefix
        properties: {
          // id: { type: 'string' },
          algo: { type: 'string' },
          hash: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {

    const contextId = request.params.id;
    const { algo, hash } = request.params;

    try {
      const context = await fastify.contextManager.getContext(request.user.id, contextId);
      if (!context) {
        const response = new ResponseObject().notFound(`Context with ID ${contextId} not found or not accessible.`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const checksumString = `${algo}/${hash}`;
      const document = await context.getByChecksumString(request.user.id, checksumString);

      if (!document) {
        const response = new ResponseObject().notFound(`Document with checksum '${checksumString}' not found via context '${contextId}' (owner access).`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().success(document, 'Document retrieved successfully by hash (owner access)');
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
