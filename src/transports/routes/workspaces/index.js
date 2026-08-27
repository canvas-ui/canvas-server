'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceWrite as _requireWorkspaceWrite, requireWorkspaceAdmin } from '../../middleware/workspace-acl.js';
import { enforceAgentBinding } from '../../middleware/agent-acl.js';
import { validateUser } from '../../auth/strategies.js';
import { resolveWorkspaceAddress } from '../../middleware/address-resolver.js';
import { permissionForMethod } from '../../../core/workspace/lib/access.js';

/**
 * Main workspace routes handler for the API
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Object} options - Plugin options
 */
export default async function workspaceRoutes(fastify, _options) {
  const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');

  /**
   * Helper function to validate user is authenticated and has an email
   * @param {Object} request - Fastify request
   * @returns {boolean} true if valid, false if not
   */
  const validateUserWithResponse = (request, reply) => {
    if (!validateUser(request.user, ['id', 'email'])) {
      const response = new ResponseObject().unauthorized('Valid authentication required');
      reply.code(response.statusCode).send(response.getResponse());
      return false;
    }
    return true;
  };

  async function resolveWorkspaceForBinding(request) {
    if (request.workspace) {
      return request.workspace;
    }

    const identifier = request.params?.id;
    const userId = request.user?.id;
    if (!identifier || !userId) {
      return null;
    }

    const workspaceId = isUuid(identifier)
      ? identifier
      : await fastify.workspaceManager.resolveWorkspaceId(userId, identifier);

    if (!workspaceId) {
      return null;
    }

    return fastify.workspaceManager.getWorkspace(workspaceId, userId);
  }

  // Agent-token binding clamp — applies to every workspace subroute (documents,
  // tree, blobs, ...): workspace lock, method permission, base-path clamp.
  fastify.addHook('preHandler', enforceAgentBinding);

  // Member (e-mail / group share) clamp. Subroutes that resolve the workspace
  // themselves (documents, tree, blobs, ...) call getWorkspace(id, userId),
  // which admits any member with read access — so a read-only member must
  // be stopped here before an unsafe method reaches the handler. Routes
  // guarded by the ACL middleware already carry request.workspaceAccess with
  // the permission checked and are skipped. Search-style POSTs are reads.
  const READ_POSTS = /\/(search(\/image)?|query|resolve|preview|exports\/ticket)(\/|$)/;
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.workspaceAccess || request.resourceToken || !request.user?.id || !request.params?.id) return;
    const url = (request.raw?.url || request.url || '').split('?')[0];
    const required = request.method === 'POST' && READ_POSTS.test(url) ? 'read' : permissionForMethod(request.method);
    if (required === 'read') return;
    const identifier = request.params.id;
    const workspaceId = isUuid(identifier) ? identifier : fastify.workspaceManager.resolveWorkspaceId(request.user.id, identifier);
    if (!workspaceId || typeof fastify.workspaceManager.resolveWorkspaceAccess !== 'function') return;
    const access = await fastify.workspaceManager.resolveWorkspaceAccess(workspaceId, request.user.id);
    if (!access || access.isOwner) return; // unknown → the handler 404s; owner → full access
    if (!access.permissions.includes(required)) {
      const response = new ResponseObject().forbidden(`This workspace is shared with you read-only (needs "${required}")`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
    request.workspaceAccess = { permissions: access.permissions, isOwner: false, isMember: true, description: access.description };
  });

  fastify.addHook('preHandler', async (request) => {
    const client = request.client;
    if (!client?.registeredDevice || !client.deviceId || !request.user?.id || !request.params?.id || !fastify.deviceRegistry) {
      return;
    }

    try {
      const workspace = await resolveWorkspaceForBinding(request);
      if (!workspace) {
        return;
      }

      let device = await fastify.deviceRegistry.touchDevice(request.user.id, client.deviceId);
      if (!device && client.authMode === 'device') {
        device = await fastify.deviceRegistry.upsertDevice(request.user.id, {
          deviceId: client.deviceId,
          name: client.deviceId,
          platform: client.deviceOs,
          type: client.deviceType || 'device',
        });
      }
      if (!device) {
        return;
      }

      await fastify.deviceRegistry.ensureWorkspaceBinding(workspace, device);
    } catch (error) {
      fastify.log.warn({ err: error, deviceId: client.deviceId, workspaceId: request.params?.id }, 'Failed to sync workspace device');
    }
  });

  // Register sub-routes
  fastify.register(import('./portability.js'));
  fastify.register(import('./documents.js'), {
    prefix: '/:id/documents',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./blobs.js'), {
    prefix: '/:id/blobs',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./trees.js'), {
    prefix: '/:id/trees',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./tree.js'), {
    prefix: '/:id/trees/:treeNameOrTreeId',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./tree.js'), {
    prefix: '/:id/tree',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./lifecycle.js'), {
    prefix: '/:id',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./members.js'), {
    prefix: '/:id/members',
  });
  fastify.register(import('./tokens.js'), {
    prefix: '/:id/tokens',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./shares.js'), {
    prefix: '/',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./dotfiles.js'), {
    prefix: '/:id/dotfiles',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./git.js'), {
    prefix: '/:id/git',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./hooks.js'), {
    prefix: '/:id/hooks',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./scripts.js'), {
    prefix: '/:id/scripts',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./devices.js'), {
    prefix: '/:id/devices',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./bitmaps.js'), {
    prefix: '/:id/bitmaps',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./datasets.js'), {
    prefix: '/:id/datasets',
    onRequest: [resolveWorkspaceAddress]
  });
  // Where filesystem-style deletes park orphaned documents (WebDAV/canvas-fuse).
  fastify.register(import('./trash.js'), {
    prefix: '/:id/trash',
    onRequest: [resolveWorkspaceAddress]
  });
  // Unified backend/connector API (storage backends + message connectors),
  // mirroring the backends tree /<driver>/<address> nodes.
  fastify.register(import('./backends.js'), {
    prefix: '/:id/backends',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./services.js'), {
    prefix: '/:id/services',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./inferd.js'), {
    prefix: '/:id/inferd',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./home.js'), {
    prefix: '/:id/home',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./links.js'), {
    prefix: '/:id/links',
    onRequest: [resolveWorkspaceAddress]
  });
  fastify.register(import('./timelines.js'), {
    prefix: '/:id/timelines',
    onRequest: [resolveWorkspaceAddress]
  });
  // List all workspaces
  fastify.get('/', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {

    try {
      // Validate user is authenticated properly
      if (!validateUser(request.user, ['id', 'email'])) {
        const response = new ResponseObject().unauthorized('Valid authentication required');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const workspaces = await fastify.workspaceManager.listWorkspaces(request.user.id);

      // Return consistent ResponseObject format
      const response = new ResponseObject();
      return reply.code(200).send(response.found(workspaces, 'Workspaces retrieved successfully', 200, workspaces.length).getResponse());

    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list workspaces');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Create new workspace
  fastify.post('/', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          label: { type: 'string' },
          description: { type: 'string' },
          color: { type: 'string', pattern: '^#[0-9A-Fa-f]{3,6}$' },
          icon: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          order: { type: 'number' },
          homeScreen: { type: 'object' },
          type: { type: 'string', enum: ['workspace', 'universe'] },
          // Folder structure, fixed at creation:
          //  full — runtime dirs visible at the root, user drive in home/
          //  home — the root IS the user's drive, internals in .workspace/
          layout: { type: 'string', enum: ['full', 'home'] },
          metadata: { type: 'object' },
          acl: { type: 'object' },
          links: { type: 'object' },
          restApi: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    if (!validateUserWithResponse(request, reply)) {
      return;
    }
    try {
      const workspace = await fastify.workspaceManager.createWorkspace(
        request.body.name,
        request.user.id,
        {
          type: request.body.type || 'workspace',
          layout: request.body.layout,
          label: request.body.label || request.body.name,
          description: request.body.description || '',
          color: request.body.color,
          icon: request.body.icon,
          order: request.body.order,
          homeScreen: request.body.homeScreen,
          metadata: request.body.metadata,
          acl: request.body.acl,
          links: request.body.links,
          restApi: request.body.restApi,
          userEmail: request.user.email
        }
      );

      const responseObject = new ResponseObject().created(workspace, 'Workspace created successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      // Return the actual error message instead of a generic one
      const responseObject = new ResponseObject().serverError(error.message || 'Failed to create workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Rescan the user's workspace directories — discovers transplanted/copied
  // workspace dirs (poor-man's import: drop a dir into Workspaces/ and scan).
  fastify.post('/scan', {
    onRequest: [fastify.authenticate]
  }, async (request, reply) => {
    if (!validateUserWithResponse(request, reply)) {
      return;
    }
    try {
      const report = await fastify.workspaceManager.scanUserWorkspaces(request.user.id);
      const response = new ResponseObject().success(report, 'Workspace scan completed');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Workspace scan failed');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Register a workspace by absolute path (foreign-local workspaces living
  // outside the user's Workspaces directory).
  fastify.post('/register', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
          adopt: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    if (!validateUserWithResponse(request, reply)) {
      return;
    }
    try {
      // Adoption rewrites a foreign on-disk workspace's owner to the caller —
      // a cross-tenant takeover primitive if any authenticated user may do it.
      // Restrict it to admins; a normal user may only (re)register a path whose
      // config.owner already matches them (enforced by registerWorkspacePath
      // when adopt is false).
      const isAdmin = (await fastify.users.get(request.user.id))?.userType === 'admin';
      const adopt = isAdmin && request.body.adopt !== false;
      const entry = await fastify.workspaceManager.registerWorkspacePath(
        request.user.id,
        request.body.path,
        { adopt }
      );
      const response = new ResponseObject().created(entry, 'Workspace registered successfully');
      return reply.code(response.statusCode).send(response.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError(error.message || 'Failed to register workspace');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Get workspace details
  fastify.get('/:id', {
    onRequest: [fastify.authenticate, resolveWorkspaceAddress, requireWorkspaceRead()],
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
      // Workspace and access info already validated by middleware
      const workspace = request.workspace;
      const access = request.workspaceAccess;

      const response = {
        workspace: workspace.toJSON(),
        access: {
          permissions: access.permissions,
          isOwner: access.isOwner,
          description: access.description
        }
      };

      if (request.originalAddress) {
        response.resourceAddress = request.originalAddress;
      } else {
        try {
          response.resourceAddress = fastify.workspaceManager.constructWorkspaceReference(
            workspace.owner, workspace.name
          );
        } catch (_) { /* intentionally ignored */ }
      }

      const responseObject = new ResponseObject().found(response, 'Workspace retrieved successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to get workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // List contexts for a workspace
  fastify.get('/:id/contexts', {
    onRequest: [fastify.authenticate, resolveWorkspaceAddress, requireWorkspaceRead()],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } }
      }
    }
  }, async (request, reply) => {
    try {
      const contexts = fastify.contextManager.getContextsForWorkspace(request.workspace.id);
      const response = new ResponseObject();
      return reply.code(200).send(response.found(contexts, 'Contexts retrieved successfully', 200, contexts.length).getResponse());
    } catch (error) {
      fastify.log.error(error);
      const response = new ResponseObject().serverError('Failed to list workspace contexts');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });

  // Update workspace
  fastify.patch('/:id', {
    // allowIndexFallback: config PATCH must work for workspaces that can't be
    // instantiated (broken/legacy dir) — ownership is checked via the index.
    onRequest: [fastify.authenticate, resolveWorkspaceAddress, requireWorkspaceAdmin({ allowIndexFallback: true })],
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
          label: { type: 'string' },
          description: { type: 'string' },
          color: { type: 'string', pattern: '^#[0-9A-Fa-f]{3,6}$' },
          icon: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          order: { type: 'number' },
          homeScreen: { type: 'object' },
          locked: { type: 'boolean' },
          metadata: { type: 'object' },
          acl: { type: 'object' },
          links: { type: 'object' },
          restApi: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    if (!validateUserWithResponse(request, reply)) {
      return;
    }
    try {
      // Access already validated by middleware
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can modify workspace configuration');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const success = await fastify.workspaceManager.updateWorkspaceConfig(
        request.workspace.owner,
        request.workspace.id,
        request.user.id,
        request.body
      );

      if (!success) {
        const responseObject = new ResponseObject().serverError('Failed to update workspace configuration');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().success(true, 'Workspace updated successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to update workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });

  // Delete workspace
  fastify.delete('/:id', {
    // allowIndexFallback: broken workspaces (missing dir) must stay deletable.
    onRequest: [fastify.authenticate, resolveWorkspaceAddress, requireWorkspaceAdmin({ allowIndexFallback: true })],
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
    if (!validateUserWithResponse(request, reply)) {
      return;
    }
    try {
      // Any workspace is deletable — including the auto-provisioned
      // "universe" one; it is an ordinary workspace.

      // Only owners can delete workspaces
      if (!request.workspaceAccess.isOwner) {
        const responseObject = new ResponseObject().forbidden('Only workspace owners can delete workspaces');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const success = await fastify.workspaceManager.removeWorkspace(
        request.workspace.id,
        request.user.id,
        true // destroyData = true to actually delete the workspace files
      );

      if (!success) {
        const responseObject = new ResponseObject().serverError('Failed to delete workspace');
        return reply.code(responseObject.statusCode).send(responseObject.getResponse());
      }

      const responseObject = new ResponseObject().deleted(null, 'Workspace deleted successfully');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    } catch (error) {
      fastify.log.error(error);
      const responseObject = new ResponseObject().serverError('Failed to delete workspace');
      return reply.code(responseObject.statusCode).send(responseObject.getResponse());
    }
  });
}
