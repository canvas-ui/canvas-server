'use strict';

import ResponseObject from '../../ResponseObject.js';

/**
 * Datasets — path-independent ingest provenance (data/dataset/<name>).
 * Stamped at ingest via the documents API (features array); these routes only
 * cover the dataset lifecycle: enumerate and drop-with-documents. The virtual
 * 'default' dataset (unstamped documents) is engine-side and never listed here.
 */
export default async function workspaceDatasetRoutes(fastify, options) {
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
      const responseObject = new ResponseObject().workspaceNotActive();
      reply.code(responseObject.statusCode).send(responseObject.getResponse());
      return null;
    }

    return workspace;
  }

  // GET /workspaces/:id/datasets
  fastify.get('/', {
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
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const datasets = await workspace.listDatasets();
      const responseObject = new ResponseObject().found(datasets, 'Datasets retrieved successfully', 200, datasets.length, datasets.length);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to list datasets');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // DELETE /workspaces/:id/datasets/*
  // Wildcard: dataset names may contain '@', '.' or '/' (e.g. an email account).
  // ?dropDocuments=false removes only the stamp bitmap (documents return to the
  // virtual 'default' dataset); default is a full drop (documents deleted).
  fastify.delete('/*', {
    onRequest: [fastify.authenticate],
    schema: {
      params: {
        type: 'object',
        required: ['id', '*'],
        properties: {
          id: { type: 'string' },
          '*': { type: 'string' }
        }
      },
      querystring: {
        type: 'object',
        properties: {
          dropDocuments: { type: 'boolean', default: true }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const workspace = await getWorkspaceInstance(request, reply);
      if (!workspace) return;

      const name = request.params['*'];
      if (!name || name === 'default') {
        const responseObject = new ResponseObject().badRequest(
          name === 'default'
            ? 'The "default" dataset is virtual (unstamped documents) and cannot be deleted'
            : 'Dataset name is required',
        );
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const dropDocuments = request.query.dropDocuments !== false;
      const result = await workspace.deleteDataset(name, { dropDocuments });
      const responseObject = new ResponseObject().deleted(result, `Dataset "${result.name}" deleted (${result.documentsDeleted} document(s) removed)`);
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to delete dataset');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
