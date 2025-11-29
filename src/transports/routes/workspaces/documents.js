'use strict';

import ResponseObject from '../../ResponseObject.js';
import { parseDocumentId } from '../../../utils/documentId.js';

/**
 * Workspace document routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceDocumentRoutes(fastify, options) {
  // List documents in workspace
  fastify.get('/', {
    onRequest: [fastify.authenticate],
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
          filterArray: {
            type: 'array',
            items: { type: 'string' },
            default: []
          },
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          page: { type: 'integer' },
          q: { type: 'string' },
          search: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await fastify.workspaceManager.getWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Check if this is a search query
      const searchQuery = request.query.q || request.query.search;
      let documents;

      if (searchQuery) {
        // Use full-text search
        documents = await workspace.ftsQuery(
          searchQuery,
          request.query.contextSpec,
          request.query.featureArray,
          request.query.filterArray || [],
          { limit: request.query.limit, offset: request.query.offset, page: request.query.page }
        );
      } else {
        // Use regular document listing
        documents = await workspace.findDocuments(
          request.query.contextSpec,
          request.query.featureArray,
          request.query.filterArray || [],
          { limit: request.query.limit, offset: request.query.offset, page: request.query.page }
        );
      }

      const responseObject = new ResponseObject().found(documents, searchQuery ? 'Search results retrieved successfully' : 'Documents retrieved successfully', 200, documents.count, documents.totalCount);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to list documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Insert documents into workspace
  fastify.post('/', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' }
        }
      },
      body: {
        oneOf: [
          {
            type: 'object',
            properties: {
              contextSpec: { type: 'string' },
              featureArray: {
                type: 'array',
                items: { type: 'string' }
              },
              documents: {
                oneOf: [
                  { type: 'object' },
                  { type: 'array' }
                ]
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
            description: 'Top-level array of document IDs to insert into the workspace (paste operation).'
          }
        ]
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await fastify.workspaceManager.getWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Normalize input: allow top-level array of IDs, or object with documentIds/documents
      const isTopLevelArray = Array.isArray(request.body);
      const contextSpec = isTopLevelArray ? '/' : (request.body.contextSpec || '/');
      const featureArray = isTopLevelArray ? [] : (request.body.featureArray || []);

      let itemsToInsert;
      if (isTopLevelArray) {
        itemsToInsert = request.body; // IDs
      } else if (request.body.documentIds) {
        itemsToInsert = Array.isArray(request.body.documentIds) ? request.body.documentIds : [request.body.documentIds];
      } else if (request.body.documents) {
        itemsToInsert = Array.isArray(request.body.documents) ? request.body.documents : [request.body.documents];
      } else {
        const responseObject = new ResponseObject().badRequest('Body must include either "documents" or "documentIds", or be an array of IDs');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const documents = await workspace.insertDocumentArray(
        itemsToInsert,
        contextSpec,
        featureArray
      );
      const responseObject = new ResponseObject().created(documents, 'Documents inserted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to insert documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Get document by ID
  fastify.get('/by-id/:docId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'docId'],
        properties: {
          id: { type: 'string' },
          docId: { type: 'number' }
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
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await fastify.workspaceManager.getWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const document = await workspace.getDocumentById(
        request.params.docId,
        {
          contextSpec: request.query.contextSpec,
          featureArray: request.query.featureArray
        }
      );
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

  // Get documents by abstraction
  fastify.get('/by-abstraction/:abstraction', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'abstraction'],
        properties: {
          id: { type: 'string' },
          abstraction: { type: 'string' }
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
          filterArray: {
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
      const workspace = await fastify.workspaceManager.getWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Create derived feature array with abstraction path
      const derivedFeatureArray = [`data/abstraction/${request.params.abstraction}`, ...request.query.featureArray];

      const documents = await workspace.findDocuments(
        request.query.contextSpec,
        derivedFeatureArray,
        request.query.filterArray || [],
        { limit: request.query.limit, offset: request.query.offset, page: request.query.page }
      );
      const responseObject = new ResponseObject().found(documents, 'Documents retrieved successfully', 200, documents.count, documents.totalCount);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Update documents
  fastify.put('/', {
    onRequest: [fastify.authenticate],
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
        properties: {
          contextSpec: { type: 'string', default: '/' },
          featureArray: {
            type: 'array',
            items: { type: 'string' },
            default: []
          },
          documents: { type: 'array' },
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
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await fastify.workspaceManager.getWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Determine what to update: either documents or documentIds
      let itemsToUpdate;
      if (request.body.documents) {
        itemsToUpdate = Array.isArray(request.body.documents) ? request.body.documents : [request.body.documents];
      } else if (request.body.documentIds) {
        itemsToUpdate = Array.isArray(request.body.documentIds) ? request.body.documentIds : [request.body.documentIds];
      } else {
        const responseObject = new ResponseObject().badRequest('Body must include either "documents" or "documentIds"');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const success = await workspace.updateDocumentArray(itemsToUpdate);
      if (!success) {
        const responseObject = new ResponseObject().badRequest('Failed to update documents');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(true, 'Documents updated successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to update documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Delete documents
  fastify.delete('/', {
    onRequest: [fastify.authenticate],
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
        description: "An array of document IDs to delete from the workspace."
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await fastify.workspaceManager.getWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Convert array of IDs to the format workspace expects
      const documentIds = Array.isArray(request.body) ? request.body : [request.body];
      const result = await workspace.deleteDocumentArray(documentIds);

      // Check if any documents were successfully deleted
      if (result.failed.length > 0 && result.successful.length === 0) {
        const responseObject = new ResponseObject().badRequest('Failed to delete documents');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().deleted(null, 'Documents deleted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to delete documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Remove documents
  fastify.delete('/remove', {
    onRequest: [fastify.authenticate],
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
        description: "An array of document IDs to remove from the workspace."
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await fastify.workspaceManager.getWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Convert array of IDs to the format workspace expects
      const documentIds = Array.isArray(request.body) ? request.body : [request.body];
      const result = await workspace.removeDocumentArray(
        documentIds,
        request.query.contextSpec,
        request.query.featureArray
      );

      // Check if any documents were successfully removed
      if (result.failed.length > 0 && result.successful.length === 0) {
        const responseObject = new ResponseObject().badRequest('Failed to remove documents');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().deleted(null, 'Documents removed successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to remove documents');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Get document by ID (direct route)
  fastify.get('/:docId', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'docId'],
        properties: {
          id: { type: 'string' },
          docId: { type: 'string' }
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
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await fastify.workspaceManager.getWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Parse and validate document ID
      let documentId;
      try {
        documentId = parseDocumentId(request.params.docId, 'Document ID parameter');
      } catch (error) {
        const responseObject = new ResponseObject().badRequest(error.message);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const document = await workspace.getDocumentById(
        documentId,
        {
          contextSpec: request.query.contextSpec,
          featureArray: request.query.featureArray
        }
      );

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

  // Get document by hash
  fastify.get('/by-hash/:algo/:hash', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'algo', 'hash'],
        properties: {
          id: { type: 'string' },
          algo: { type: 'string' },
          hash: { type: 'string' }
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
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await fastify.workspaceManager.getWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const checksumString = `${request.params.algo}/${request.params.hash}`;
      const document = await workspace.getDocumentByChecksumString(checksumString);
      if (!document) {
        const responseObject = new ResponseObject().notFound(`Document with checksum ${checksumString} not found`);
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

    // Clear workspace database (DEVELOPMENT ONLY)
  fastify.delete('/clear-database', {
    onRequest: [fastify.authenticate],
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
    // Only allow in development mode
    if (process.env.NODE_ENV !== 'development') {
      const responseObject = new ResponseObject().forbidden('Database clear operation only available in development mode');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }

    try {
      const workspace = await fastify.workspaceManager.getWorkspace(
        request.user.id,
        request.params.id,
        request.user.id
      );

      if (!workspace) {
        const responseObject = new ResponseObject().notFound(`Workspace with ID ${request.params.id} not found`);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      // Ensure workspace is active - start it if it's not
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

      // Clear the database synchronously
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
