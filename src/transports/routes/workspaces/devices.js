'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite } from '../../middleware/workspace-acl.js';

const DEVICE_SCHEMA = 'data/schema/device';

function serializeDeviceDocument(document) {
  return {
    id: document.id,
    ...(document.data || {}),
  };
}

async function findWorkspaceDeviceDoc(workspace, deviceId) {
  const docs = await workspace.list({
    context: workspace.getContextTreeSelector('/'),
    attributes: { allOf: [DEVICE_SCHEMA] },
    limit: 500,
  });
  return Array.isArray(docs)
    ? docs.find((document) => document?.data?.deviceId === deviceId) || null
    : null;
}

export default async function workspaceDeviceRoutes(fastify, _options) {
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
          limit: { type: 'integer' },
          offset: { type: 'integer' },
          page: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const documents = await request.workspace.list({
        context: request.workspace.getContextTreeSelector('/'),
        attributes: { allOf: [DEVICE_SCHEMA] },
        limit: request.query.limit,
        offset: request.query.offset,
        page: request.query.page,
      });

      const devices = (documents || []).map(serializeDeviceDocument);
      const response = new ResponseObject().found(
        devices,
        'Workspace devices retrieved successfully',
        200,
        devices.length,
        documents?.totalCount ?? devices.length
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to list workspace devices');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.get('/:deviceId', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'deviceId'],
        properties: {
          id: { type: 'string' },
          deviceId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const document = await findWorkspaceDeviceDoc(request.workspace, request.params.deviceId);
      if (!document) {
        const response = new ResponseObject().notFound('Workspace device not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const response = new ResponseObject().found(
        serializeDeviceDocument(document),
        'Workspace device retrieved successfully'
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to get workspace device');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

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
        properties: {
          deviceId: { type: 'string' },
          deviceIds: {
            type: 'array',
            items: { type: 'string' }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      if (!fastify.deviceRegistry) {
        throw new Error('Device registry not available');
      }

      const rawIds = [
        ...(Array.isArray(request.body?.deviceIds) ? request.body.deviceIds : []),
        ...(request.body?.deviceId ? [request.body.deviceId] : []),
      ];
      const deviceIds = Array.from(new Set(rawIds.map((value) => String(value || '').trim()).filter(Boolean)));

      if (!deviceIds.length) {
        const response = new ResponseObject().badRequest('deviceId or deviceIds is required');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const linked = [];
      for (const deviceId of deviceIds) {
        const device = await fastify.deviceRegistry.getDevice(request.user.id, deviceId);
        if (!device) {
          const response = new ResponseObject().notFound(`Device "${deviceId}" not found in server registry`);
          return reply.code(response.statusCode).send(response.getResponse());
        }

        const result = await fastify.deviceRegistry.ensureWorkspaceBinding(request.workspace, device);
        linked.push({
          id: result.id,
          created: result.created,
          ...result.data,
        });
      }

      const response = new ResponseObject().created(linked, 'Workspace devices linked successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to link workspace devices');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  fastify.delete('/:deviceId', {
    onRequest: [fastify.authenticate, requireWorkspaceWrite()],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'deviceId'],
        properties: {
          id: { type: 'string' },
          deviceId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const deviceId = String(request.params.deviceId || '').trim();
      if (!deviceId) {
        const response = new ResponseObject().badRequest('deviceId is required');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const docs = await request.workspace.list({
        context: request.workspace.getContextTreeSelector('/'),
        attributes: { allOf: [DEVICE_SCHEMA] },
        limit: 500,
      });
      const matches = Array.isArray(docs)
        ? docs.filter((document) => document?.data?.deviceId === deviceId)
        : [];
      if (!matches.length) {
        const response = new ResponseObject().notFound('Workspace device not found');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const result = await request.workspace.deleteMany(matches.map((document) => document.id));

      const response = new ResponseObject().success(
        { deviceId, deleted: result?.successful?.length ?? matches.length, result },
        'Workspace device unlinked successfully'
      );
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      request.log.error(error);
      const response = new ResponseObject().serverError('Failed to unlink workspace device');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
