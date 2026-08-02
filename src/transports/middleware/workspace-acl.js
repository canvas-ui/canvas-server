'use strict';

import crypto from 'crypto';
import { createLogger } from '../../utils/log.js';
import ResponseObject from '../ResponseObject.js';

const logger = createLogger('canvas-server:middleware:workspace-acl');

/**
 * Workspace ACL Validation Middleware
 *
 * This middleware validates workspace access supporting both JWT and API tokens:
 * - JWT tokens (web UI): Only owner access allowed
 * - Canvas API tokens: Owner access + token-based sharing access
 *
 * It works in conjunction with the existing Canvas authentication middleware.
 *
 * Token-based ACL format in workspace.json:
 * {
 *   "acl": {
 *     "tokens": {
 *       "sha256:abc123...": {
 *         "permissions": ["read", "write"],
 *         "description": "Jane's laptop",
 *         "createdAt": "2024-01-01T00:00:00Z",
 *         "expiresAt": null
 *       }
 *     }
 *   }
 * }
 */

/**
 * Create workspace access validation middleware
 * @param {string} requiredPermission - Required permission ('read', 'write', 'admin')
 * @param {Object} [options]
 * @param {boolean} [options.allowIndexFallback=false] - Grant owner access from
 *   the workspace index when the workspace cannot be instantiated (missing or
 *   legacy directory). Only for config-level routes (PATCH/DELETE /:id) whose
 *   handlers never call Workspace instance methods — request.workspace is the
 *   plain index entry in that case.
 * @returns {Function} Fastify middleware function
 */
export function createWorkspaceACLMiddleware(requiredPermission = 'read', { allowIndexFallback = false } = {}) {
  return async function validateWorkspaceAccess(request, reply) {
    try {
      logger.debug(`Validating workspace access for permission: ${requiredPermission}`);

      // 1. Extract workspace ID from route parameters
      const workspaceId = request.params.id;
      if (!workspaceId) {
        throw new Error('Workspace ID required in route parameters');
      }

      // 1b. Agent principals: already resolved and scoped at auth time. They
      // must NOT fall through to owner access (request.user is the agent's
      // owner) — enforce the binding here and stop.
      if (request.resourceToken?.type === 'agent') {
        const binding = request.resourceToken;
        const matchesBinding = workspaceId === binding.workspaceId
          || workspaceId === binding.workspaceName
          || request.server.workspaceManager?.resolveWorkspaceId(request.user?.id, workspaceId) === binding.workspaceId;

        if (!matchesBinding) {
          const response = new ResponseObject().forbidden('Agent token is not bound to this workspace');
          return reply.code(response.statusCode).send(response.getResponse());
        }
        if (!binding.permissions?.includes(requiredPermission)) {
          const response = new ResponseObject().forbidden(`Agent token lacks required permission: ${requiredPermission}`);
          return reply.code(response.statusCode).send(response.getResponse());
        }

        const workspace = await request.server.workspaceManager.getWorkspace(binding.workspaceId, request.user.id);
        if (!workspace) {
          const response = new ResponseObject().notFound(`Workspace not found: ${workspaceId}`);
          return reply.code(response.statusCode).send(response.getResponse());
        }

        request.workspace = workspace;
        request.workspaceAccess = {
          permissions: binding.permissions,
          isOwner: false,
          isAgent: true,
          description: `Agent ${binding.agentName || binding.agentId}`,
        };
        return; // Continue to route handler
      }

      // 1c. Workspace share tokens: resolved at auth time to the owning
      // workspace (request.user is the owner). Enforce the binding — the
      // token grants access to exactly one workspace, never the owner's
      // other workspaces.
      if (request.resourceToken?.type === 'workspace') {
        const binding = request.resourceToken;
        const matchesBinding = workspaceId === binding.workspaceId
          || workspaceId === binding.workspaceName;

        if (!matchesBinding) {
          const response = new ResponseObject().forbidden('Workspace token is not bound to this workspace');
          return reply.code(response.statusCode).send(response.getResponse());
        }
        if (!binding.permissions?.includes(requiredPermission)) {
          const response = new ResponseObject().forbidden(`Workspace token lacks required permission: ${requiredPermission}`);
          return reply.code(response.statusCode).send(response.getResponse());
        }

        const workspace = await request.server.workspaceManager.getWorkspace(binding.workspaceId, request.user?.id);
        if (!workspace) {
          const response = new ResponseObject().notFound(`Workspace not found: ${workspaceId}`);
          return reply.code(response.statusCode).send(response.getResponse());
        }

        request.workspace = workspace;
        request.workspaceAccess = {
          permissions: binding.permissions,
          isOwner: false,
          isShareToken: true,
          description: 'Workspace share token',
        };
        return; // Continue to route handler
      }

      // 2. Extract token from request (should already be validated by fastify.authenticate)
      const authHeader = request.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        throw new Error('Bearer token required');
      }

      const token = authHeader.split(' ')[1];
      const isApiToken = token.startsWith('canvas-');
      const isJwtToken = !isApiToken; // Assume JWT if not API token

      // 3. Get user information from the request (set by authenticate middleware)
      let userId;

      if (isJwtToken) {
        // For JWT tokens (web UI), user info is in request.user
        if (!request.user?.id) {
          throw new Error('Invalid JWT token: no user information');
        }
        userId = request.user.id;
        logger.debug(`Using JWT token for user: ${userId}`);
      } else {
        // canvas-* tokens (user API or device) were already verified by
        // fastify.authenticate, which set request.user — trust it. Only
        // re-derive through authService when it is somehow absent.
        userId = request.user?.id;
        if (!userId) {
          try {
            const tokenResult = await request.server.authService.verifyApiToken(token);
            if (!tokenResult) {
              throw new Error('Invalid API token');
            }
            userId = tokenResult.userId;
          } catch (error) {
            logger.debug(`API token verification failed: ${error.message}`);
            throw new Error(`Token verification failed: ${error.message}`);
          }
        }
        logger.debug(`Using canvas token for user: ${userId}`);
      }

      // 4. Try owner access first (fastest path)
      const workspace = await tryOwnerAccess(
        request.server.workspaceManager,
        userId,
        workspaceId
      );

      if (workspace) {
        logger.debug(`Owner access granted for workspace ${workspaceId}`);
        request.workspace = workspace;
        request.workspaceAccess = {
          permissions: ['read', 'write', 'admin'],
          isOwner: true,
          description: 'Workspace owner'
        };
        return; // Continue to route handler
      }

      // 4b. Config-level fallback: the owner check above instantiates the
      // workspace, which throws for broken/legacy dirs (status not_found).
      // Ownership is still provable from the index, and config routes only
      // need the index entry.
      if (allowIndexFallback && userId) {
        const entry = request.server.workspaceManager.getWorkspaceIndexEntry(workspaceId, userId);
        if (entry) {
          logger.debug(`Owner access granted via index entry for workspace ${workspaceId} (not instantiable)`);
          request.workspace = entry;
          request.workspaceAccess = {
            permissions: ['read', 'write', 'admin'],
            isOwner: true,
            description: 'Workspace owner (index entry)'
          };
          return; // Continue to route handler
        }
      }

      // 5. Try token-based access (only for API tokens, not JWT tokens)
      if (isApiToken) {
        const tokenAccess = await tryTokenAccess(
          request.server.workspaceManager,
          workspaceId,
          token,
          requiredPermission
        );

        if (tokenAccess) {
          logger.debug(`Token access granted for workspace ${workspaceId}: ${tokenAccess.access.description}`);
          request.workspace = tokenAccess.workspace;
          request.workspaceAccess = {
            ...tokenAccess.access,
            isOwner: false
          };
          return; // Continue to route handler
        }
      }

      // 6. Try email-based user access (for JWT tokens only)
      if (isJwtToken && userId) {
        const userAccess = await tryUserAccess(
          request.server.workspaceManager,
          request.server.users,
          workspaceId,
          userId,
          requiredPermission
        );

        if (userAccess) {
          logger.debug(`User email access granted for workspace ${workspaceId}: ${userAccess.access.description}`);
          request.workspace = userAccess.workspace;
          request.workspaceAccess = {
            ...userAccess.access,
            isOwner: false
          };
          return; // Continue to route handler
        }
      }

      // 7. Access denied
      logger.debug(`Access denied for workspace ${workspaceId}`);
      if (isJwtToken) {
        const response = new ResponseObject().forbidden(
          `Access denied to workspace ${workspaceId}. You are not the owner of this workspace.`
        );
        return reply.code(response.statusCode).send(response.getResponse());
      } else {
        const response = new ResponseObject().forbidden(
          `Access denied to workspace ${workspaceId}. Token lacks required permission: ${requiredPermission}`
        );
        return reply.code(response.statusCode).send(response.getResponse());
      }

    } catch (error) {
      logger.debug(`Workspace ACL validation error: ${error.message}`);
      const response = new ResponseObject().serverError(`Workspace access validation failed: ${error.message}`);
      return reply.code(response.statusCode).send(response.getResponse());
    }
  };
}

/**
 * Try to access workspace as owner
 * @param {WorkspaceManager} workspaceManager - Workspace manager instance
 * @param {string} userId - User ID from token
 * @param {string} workspaceIdentifier - Workspace ID or name
 * @returns {Promise<Workspace|null>} Workspace instance if owner, null otherwise
 */
async function tryOwnerAccess(workspaceManager, userId, workspaceIdentifier) {
  try {
    // Check if identifier is a workspace ID (UUID format) or name
    // Workspace IDs are UUIDs like 7c84589b-9268-45e8-9b7c-85c29adc9bca
    const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceIdentifier);

    let workspace;
    if (isWorkspaceId) {
      // Try to get workspace by ID using the new API (workspaceId, userId)
      workspace = await workspaceManager.getWorkspace(workspaceIdentifier, userId);
    } else {
      // Resolve workspace name to ID first, then load via new API
      const resolvedId = workspaceManager.resolveWorkspaceId(userId, workspaceIdentifier);
      if (!resolvedId) {
        return null;
      }
      workspace = await workspaceManager.getWorkspace(resolvedId, userId);
    }

    return workspace;
  } catch (error) {
    logger.debug(`Owner access failed: ${error.message}`);
    return null;
  }
}

/**
 * Try to access workspace via token-based ACL
 * @param {WorkspaceManager} workspaceManager - Workspace manager instance
 * @param {string} workspaceIdentifier - Workspace ID or name
 * @param {string} token - API token
 * @param {string} requiredPermission - Required permission
 * @returns {Promise<Object|null>} Access info if valid, null otherwise
 */
async function tryTokenAccess(workspaceManager, workspaceIdentifier, token, requiredPermission) {
  try {
    // Hash the token to match against ACL
    const tokenHash = `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;

    // Find workspace with this token in ACL
    const workspaceEntry = await findWorkspaceByTokenHash(workspaceManager, workspaceIdentifier, tokenHash);
    if (!workspaceEntry) {
      logger.debug(`Token not found in any workspace ACL: ${tokenHash.substring(0, 16)}...`);
      return null;
    }

    // Validate token permissions and expiration
    const tokenData = workspaceEntry.acl.tokens[tokenHash];

    // Check expiration
    if (tokenData.expiresAt && new Date() > new Date(tokenData.expiresAt)) {
      logger.debug(`Token has expired: ${tokenData.expiresAt}`);
      return null;
    }

    // Check permissions
    if (!tokenData.permissions.includes(requiredPermission)) {
      logger.debug(`Token lacks required permission. Has: ${tokenData.permissions}, needs: ${requiredPermission}`);
      return null;
    }

    // Load the actual workspace instance for token access
    const workspace = await loadWorkspaceForTokenAccess(workspaceManager, workspaceEntry);
    if (!workspace) {
      logger.debug(`Failed to load workspace for token access: ${workspaceIdentifier}`);
      return null;
    }

    return {
      workspace,
      access: tokenData,
      config: workspaceEntry
    };

  } catch (error) {
    logger.debug(`Token access validation error: ${error.message}`);
    return null;
  }
}

/**
 * Find workspace by searching for token hash in ACLs
 * @param {WorkspaceManager} workspaceManager - Workspace manager instance
 * @param {string} workspaceIdentifier - Workspace ID or name
 * @param {string} tokenHash - Token hash to search for
 * @returns {Promise<Object|null>} Workspace config if found, null otherwise
 */
async function findWorkspaceByTokenHash(workspaceManager, workspaceIdentifier, tokenHash) {
  try {
    // Check if identifier is a workspace ID (UUID format) or name
    // Workspace IDs are UUIDs like 7c84589b-9268-45e8-9b7c-85c29adc9bca
    const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceIdentifier);

    const allWorkspaces = await workspaceManager.listWorkspaces();

    if (isWorkspaceId) {
      // Direct lookup by workspace ID
      for (const workspaceEntry of allWorkspaces) {
        if (workspaceEntry.id === workspaceIdentifier) {
          const tokens = workspaceEntry.acl?.tokens || {};
          if (tokens[tokenHash]) {
            logger.debug(`Found token in workspace ACL: ${workspaceIdentifier}`);
            return workspaceEntry;
          }
          break;
        }
      }
    } else {
      // Search through all workspaces for a matching name and token
      for (const workspaceEntry of allWorkspaces) {
        if (workspaceEntry.name === workspaceIdentifier) {
          const tokens = workspaceEntry.acl?.tokens || {};
          if (tokens[tokenHash]) {
            logger.debug(`Found token in workspace ACL by name: ${workspaceIdentifier}`);
            return workspaceEntry;
          }
        }
      }
    }

    logger.debug(`Token not found in any workspace ACL: ${tokenHash.substring(0, 16)}...`);
    return null;

  } catch (error) {
    logger.debug(`Error searching for token in workspace ACLs: ${error.message}`);
    return null;
  }
}

/**
 * Load workspace instance for token-based access
 * @param {WorkspaceManager} workspaceManager - Workspace manager instance
 * @param {Object} workspaceEntry - Workspace entry from index
 * @returns {Promise<Workspace|null>} Workspace instance if successful, null otherwise
 */
async function loadWorkspaceForTokenAccess(workspaceManager, workspaceEntry) {
  try {
    // Load the workspace by ID (this bypasses owner check since we validated ACL)
    const workspace = await workspaceManager.getWorkspace(workspaceEntry.id);
    return workspace;

  } catch (error) {
    logger.debug(`Error loading workspace for token access: ${error.message}`);
    return null;
  }
}

/**
 * Try to access workspace via email-based user sharing
 * @param {WorkspaceManager} workspaceManager - Workspace manager instance
 * @param {UserManager} userManager - User manager instance
 * @param {string} workspaceIdentifier - Workspace ID or name
 * @param {string} userId - User ID
 * @param {string} requiredPermission - Required permission
 * @returns {Promise<Object|null>} Access info if valid, null otherwise
 */
async function tryUserAccess(workspaceManager, userManager, workspaceIdentifier, userId, requiredPermission) {
  try {
    // Get user email to check against workspace ACL
    const user = await userManager.get(userId);
    if (!user || !user.email) {
      logger.debug(`User not found or missing email: ${userId}`);
      return null;
    }

    // Find workspace and check user ACL
    const workspaceEntry = await findWorkspaceByUserEmail(workspaceManager, workspaceIdentifier, user.email);
    if (!workspaceEntry) {
      logger.debug(`User ${user.email} not found in any workspace ACL for workspace: ${workspaceIdentifier}`);
      return null;
    }

    // Validate user permissions
    const userData = workspaceEntry.acl.users[user.email];
    if (!userData.permissions.includes(requiredPermission)) {
      logger.debug(`User ${user.email} lacks required permission. Has: ${userData.permissions}, needs: ${requiredPermission}`);
      return null;
    }

    // Load the actual workspace instance
    const workspace = await loadWorkspaceForUserAccess(workspaceManager, workspaceEntry, userId);
    if (!workspace) {
      logger.debug(`Failed to load workspace for user access: ${workspaceIdentifier}`);
      return null;
    }

    return {
      workspace,
      access: {
        permissions: userData.permissions,
        description: userData.description || `Email-based access for ${user.email}`,
        grantedAt: userData.grantedAt,
        grantedBy: userData.grantedBy
      }
    };

  } catch (error) {
    logger.debug(`User access validation error: ${error.message}`);
    return null;
  }
}

/**
 * Find workspace by searching for user email in ACLs
 * @param {WorkspaceManager} workspaceManager - Workspace manager instance
 * @param {string} workspaceIdentifier - Workspace ID or name
 * @param {string} userEmail - User email to search for
 * @returns {Promise<Object|null>} Workspace config if found, null otherwise
 */
async function findWorkspaceByUserEmail(workspaceManager, workspaceIdentifier, userEmail) {
  try {
    // Check if workspaceIdentifier is a UUID (workspace ID)
    const isWorkspaceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceIdentifier);

    const allWorkspaces = await workspaceManager.listWorkspaces();

    if (isWorkspaceId) {
      // Direct lookup by workspace ID
      for (const workspaceEntry of allWorkspaces) {
        if (workspaceEntry.id === workspaceIdentifier) {
          const users = workspaceEntry.acl?.users || {};
          if (users[userEmail]) {
            logger.debug(`Found user ${userEmail} in workspace ACL: ${workspaceIdentifier}`);
            return workspaceEntry;
          }
        }
      }
    } else {
      // Search through all workspaces for a matching name and user email
      for (const workspaceEntry of allWorkspaces) {
        if (workspaceEntry.name === workspaceIdentifier) {
          const users = workspaceEntry.acl?.users || {};
          if (users[userEmail]) {
            logger.debug(`Found user ${userEmail} in workspace ACL: ${workspaceEntry.id} (name: ${workspaceIdentifier})`);
            return workspaceEntry;
          }
        }
      }
    }

    logger.debug(`User ${userEmail} not found in workspace ACL for: ${workspaceIdentifier}`);
    return null;

  } catch (error) {
    logger.debug(`Error finding workspace by user email: ${error.message}`);
    return null;
  }
}

/**
 * Load workspace instance for user-based access
 * @param {WorkspaceManager} workspaceManager - Workspace manager instance
 * @param {Object} workspaceEntry - Workspace entry from index
 * @param {string} userId - Accessing user ID
 * @returns {Promise<Workspace|null>} Workspace instance if successful, null otherwise
 */
async function loadWorkspaceForUserAccess(workspaceManager, workspaceEntry, userId) {
  try {
    // Load the workspace by ID with the owner as the requesting user
    // This allows the user to access a workspace they have email-based permissions for
    const workspace = await workspaceManager.getWorkspace(workspaceEntry.id, workspaceEntry.owner);
    return workspace;

  } catch (error) {
    logger.debug(`Error loading workspace for user access: ${error.message}`);
    return null;
  }
}

/**
 * Global scope clamp for workspace share tokens. They authenticate as the
 * workspace owner, so without this every authenticate-only route (documents
 * of other workspaces, contexts, agents, ...) would be reachable. A share
 * token may only address /rest/v2/workspaces/* routes bound to its workspace.
 * Registered as a root-level preHandler in transports/index.js.
 */
export async function enforceWorkspaceTokenScope(request, reply) {
  const binding = request.resourceToken;
  if (binding?.type !== 'workspace') return;

  const url = (request.raw?.url || request.url || '').split('?')[0];
  const workspaceId = request.params?.id;
  const inWorkspacesApi = url.startsWith('/rest/v2/workspaces/');
  const matchesBinding = workspaceId === binding.workspaceId
    || workspaceId === binding.workspaceName;

  if (inWorkspacesApi && matchesBinding) return;
  // Self-describing endpoint: lets a token holder discover its workspace.
  if (url === '/rest/v2/workspaces/token-info') return;

  const response = new ResponseObject().forbidden('Workspace token is only valid for its bound workspace');
  return reply.code(response.statusCode).send(response.getResponse());
}

/**
 * Convenience middleware factories for common permissions
 */
export const requireWorkspaceRead = (options) => createWorkspaceACLMiddleware('read', options);
export const requireWorkspaceWrite = (options) => createWorkspaceACLMiddleware('write', options);
export const requireWorkspaceAdmin = (options) => createWorkspaceACLMiddleware('admin', options);

export default {
  createWorkspaceACLMiddleware,
  requireWorkspaceRead,
  requireWorkspaceWrite,
  requireWorkspaceAdmin
};
