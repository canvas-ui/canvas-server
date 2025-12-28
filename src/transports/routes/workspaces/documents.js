'use strict';

import ResponseObject from '../../ResponseObject.js';
import { parseDocumentId, parseDocumentIdArray } from '../../../utils/documentId.js';

/**
 * Workspace document routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceDocumentRoutes(fastify, options) {
  function enforceClientTags(request, featureArray = []) {
    const out = Array.isArray(featureArray) ? [...featureArray] : [];
    const filtered = out.filter(f =>
      typeof f === 'string' &&
      !f.startsWith('client/device/id/') &&
      !f.startsWith('client/app/id/')
    );

    const deviceId = request.client?.deviceId;
    const appKey = request.client?.appKey;
    if (deviceId) filtered.push(`client/device/id/${deviceId}`);
    if (appKey) filtered.push(`client/app/id/${appKey}`);
    return filtered;
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

    // Workspace must be active to access documents
    if (!workspace.isActive) {
      const responseObject = new ResponseObject().badRequest('Workspace is not active. Start the workspace first.');
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }

    return workspace;
  }

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
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      // Check if this is a search query
      const searchQuery = request.query.q || request.query.search;
      let documents;

      if (searchQuery) {
        // Use full-text search
        documents = await workspace.db.ftsQuery(
          searchQuery,
          request.query.contextSpec,
          request.query.featureArray,
          request.query.filterArray || [],
          { limit: request.query.limit, offset: request.query.offset, page: request.query.page }
        );
      } else {
        // Use regular document listing
        documents = await workspace.db.findDocuments(
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
    onRequest: [fastify.authenticateClient],
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
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      // Normalize input: allow top-level array of IDs, or object with documentIds/documents
      const isTopLevelArray = Array.isArray(request.body);
      const contextSpec = isTopLevelArray ? '/' : (request.body.contextSpec || '/');
      const featureArray = isTopLevelArray ? [] : (request.body.featureArray || []);
      const enforcedFeatureArray = enforceClientTags(request, featureArray);

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

      const documents = await workspace.db.insertDocumentArray(
        itemsToInsert,
        contextSpec,
        enforcedFeatureArray
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
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const document = await workspace.db.getDocumentById(request.params.docId);
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
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      // Create derived feature array with abstraction path
      const derivedFeatureArray = [`data/abstraction/${request.params.abstraction}`, ...request.query.featureArray];

      const documents = await workspace.db.findDocuments(
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
    onRequest: [fastify.authenticateClient],
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
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

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

      const success = await workspace.db.updateDocumentArray(itemsToUpdate);
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
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      // Normalize + validate IDs (SynapsD requires numbers; invalid IDs should 400 with a useful message)
      const rawIds = Array.isArray(request.body) ? request.body : [request.body];
      let documentIds;
      try {
        documentIds = parseDocumentIdArray(rawIds, 'Document ID array');
      } catch (e) {
        const responseObject = new ResponseObject().badRequest(e.message);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const result = await workspace.db.deleteDocumentArray(documentIds);

      // Always return 200 with details (DELETE should be idempotent; not-found is not a client error)
      if (result?.failed?.length) {
        fastify.log.warn({
          workspace: request.params.id,
          userId: request.user?.id,
          op: 'workspace.documents.delete',
          requested: documentIds.length,
          successful: result.successful?.length || 0,
          failed: result.failed?.length || 0,
          failedSamples: (result.failed || []).slice(0, 5)
        }, 'Workspace document delete had failures');
      }

      const message =
        (result?.successful?.length || 0) > 0
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
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      // Normalize + validate IDs (SynapsD requires numbers; invalid IDs should 400 with a useful message)
      const rawIds = Array.isArray(request.body) ? request.body : [request.body];
      let documentIds;
      try {
        documentIds = parseDocumentIdArray(rawIds, 'Document ID array');
      } catch (e) {
        const responseObject = new ResponseObject().badRequest(e.message);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const result = await workspace.db.removeDocumentArray(
        documentIds,
        request.query.contextSpec,
        request.query.featureArray
      );

      // Always return 200 with details (remove should be idempotent; not-found/not-in-context is not a client error)
      if (result?.failed?.length) {
        fastify.log.warn({
          workspace: request.params.id,
          userId: request.user?.id,
          op: 'workspace.documents.remove',
          contextSpec: request.query.contextSpec,
          requested: documentIds.length,
          successful: result.successful?.length || 0,
          failed: result.failed?.length || 0,
          failedSamples: (result.failed || []).slice(0, 5)
        }, 'Workspace document remove had failures');
      }

      const message =
        (result?.successful?.length || 0) > 0
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
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      // Parse and validate document ID
      let documentId;
      try {
        documentId = parseDocumentId(request.params.docId, 'Document ID parameter');
      } catch (error) {
        const responseObject = new ResponseObject().badRequest(error.message);
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const document = await workspace.db.getDocumentById(documentId);

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
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const checksumString = `${request.params.algo}/${request.params.hash}`;
      const document = await workspace.db.getDocumentByChecksumString(checksumString);
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
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

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
