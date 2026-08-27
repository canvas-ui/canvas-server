'use strict';

import ResponseObject from '../../ResponseObject.js';
import { requireWorkspaceRead, requireWorkspaceAdmin } from '../../middleware/workspace-acl.js';
import { WORKSPACE_PERMISSIONS } from '../../../core/workspace/lib/access.js';

/**
 * Workspace members — e-mail and group grants (team workspaces).
 *
 *   GET    /workspaces/:id/members                 list (any member or owner)
 *   POST   /workspaces/:id/members                 grant   { email | group, permissions[], description? }   owner only
 *   PUT    /workspaces/:id/members/:principal      update  { permissions[], description? }                  owner only
 *   DELETE /workspaces/:id/members/:principal      revoke                                                   owner only
 *
 * `:principal` is `user:<email>` or `group:<name>` (URL-encoded). A user grant
 * may name an e-mail that has not logged in yet — on an LDAP-backed instance
 * the account is created on first login and the share is already waiting.
 * The universe (home) workspace cannot be shared.
 *
 * @param {FastifyInstance} fastify
 */
export default async function workspaceMemberRoutes(fastify, _options) {
  const principalSchema = {
    type: 'object',
    required: ['id', 'principal'],
    properties: {
      id: { type: 'string' },
      principal: { type: 'string', minLength: 6, pattern: '^(user|group):.+$' }
    }
  };
  const permissionsSchema = {
    type: 'array',
    items: { type: 'string', enum: [...WORKSPACE_PERMISSIONS] },
    minItems: 1
  };

  const parsePrincipal = (raw) => {
    const decoded = decodeURIComponent(raw);
    const sep = decoded.indexOf(':');
    return { type: decoded.slice(0, sep), principal: decoded.slice(sep + 1) };
  };

  const send = (reply, response) => reply.code(response.statusCode).send(response.getResponse());
  const fail = (reply, error, fallback) => {
    if (error?.code === 'ACCESS_DENIED' || error?.statusCode === 403) {
      return send(reply, new ResponseObject().forbidden(error.message));
    }
    if (error?.statusCode === 404) return send(reply, new ResponseObject().notFound(error.message));
    if (error?.statusCode === 503) return send(reply, new ResponseObject().error(error.message, null, 503));
    fastify.log.error(error);
    return send(reply, new ResponseObject().badRequest(error?.message || fallback));
  };

  const withUserStatus = async (member) => {
    if (member.type !== 'user') return member;
    let userExists;
    try { userExists = !!(await fastify.users.getByEmail(member.principal)); } catch { userExists = false; }
    return { ...member, userExists };
  };

  // List members (owner, or anyone the workspace is shared with — teams
  // should be able to see who else is in the room).
  fastify.get('/', {
    onRequest: [fastify.authenticate, requireWorkspaceRead()],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
  }, async (request, reply) => {
    try {
      const workspace = request.workspace;
      if (typeof workspace.listMembers !== 'function') {
        return send(reply, new ResponseObject().badRequest('Members are managed on the workspace\'s own server'));
      }
      const members = await Promise.all(workspace.listMembers().map(withUserStatus));
      return send(reply, new ResponseObject().found({
        owner: workspace.owner,
        isOwner: !!request.workspaceAccess?.isOwner,
        shareable: !workspace.isUniverse,
        members,
      }, 'Workspace members retrieved'));
    } catch (error) {
      return fail(reply, error, 'Failed to list workspace members');
    }
  });

  // Grant (or replace) a member's access — owner only
  fastify.post('/', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          email: { type: 'string', format: 'email' },
          group: { type: 'string', minLength: 1 },
          permissions: permissionsSchema,
          description: { type: 'string' }
        },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    try {
      if (!request.workspaceAccess?.isOwner) {
        return send(reply, new ResponseObject().forbidden('Only the workspace owner can share a workspace'));
      }
      const { email, group, permissions, description } = request.body || {};
      if (!!email === !!group) {
        return send(reply, new ResponseObject().badRequest('Provide exactly one of "email" or "group"'));
      }
      const type = email ? 'user' : 'group';
      const member = await fastify.workspaceManager.grantWorkspaceMember(
        request.workspace.id, request.user.id, type, email || group,
        { permissions: permissions || ['read'], description }
      );
      return send(reply, new ResponseObject().created(await withUserStatus(member), 'Workspace shared'));
    } catch (error) {
      return fail(reply, error, 'Failed to share workspace');
    }
  });

  // Update a member's permissions — owner only
  fastify.put('/:principal', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
    schema: {
      params: principalSchema,
      body: {
        type: 'object',
        required: ['permissions'],
        properties: { permissions: permissionsSchema, description: { type: 'string' } },
        additionalProperties: false
      }
    }
  }, async (request, reply) => {
    try {
      if (!request.workspaceAccess?.isOwner) {
        return send(reply, new ResponseObject().forbidden('Only the workspace owner can change member access'));
      }
      const { type, principal } = parsePrincipal(request.params.principal);
      if (!request.workspace.getMember(type, principal)) {
        return send(reply, new ResponseObject().notFound(`No ${type} share for '${principal}'`));
      }
      const member = await fastify.workspaceManager.grantWorkspaceMember(
        request.workspace.id, request.user.id, type, principal,
        { permissions: request.body.permissions, description: request.body.description }
      );
      return send(reply, new ResponseObject().success(await withUserStatus(member), 'Member access updated'));
    } catch (error) {
      return fail(reply, error, 'Failed to update member access');
    }
  });

  // Revoke — owner only
  fastify.delete('/:principal', {
    onRequest: [fastify.authenticate, requireWorkspaceAdmin()],
    schema: { params: principalSchema }
  }, async (request, reply) => {
    try {
      if (!request.workspaceAccess?.isOwner) {
        return send(reply, new ResponseObject().forbidden('Only the workspace owner can revoke access'));
      }
      const { type, principal } = parsePrincipal(request.params.principal);
      const removed = await fastify.workspaceManager.revokeWorkspaceMember(request.workspace.id, request.user.id, type, principal);
      if (!removed) return send(reply, new ResponseObject().notFound(`No ${type} share for '${principal}'`));
      return send(reply, new ResponseObject().success({ type, principal }, 'Member access revoked'));
    } catch (error) {
      return fail(reply, error, 'Failed to revoke member access');
    }
  });
}
