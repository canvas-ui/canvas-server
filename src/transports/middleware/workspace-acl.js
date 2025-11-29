'use strict';

import crypto from 'crypto';
import { createDebug } from '../../utils/log/index.js';
import ResponseObject from '../ResponseObject.js';

const debug = createDebug('canvas-server:middleware:workspace-acl');

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
 * @returns {Function} Fastify middleware function
 */
export function createWorkspaceACLMiddleware(requiredPermission = 'read') {
  return async function validateWorkspaceAccess(request, reply) {
    try {
      debug(`Validating workspace access for permission: ${requiredPermission}`);

      // 1. Extract workspace ID from route parameters
      const workspaceId = request.params.id;
      if (!workspaceId) {
        throw new Error('Workspace ID required in route parameters');
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
        debug(`Using JWT token for user: ${userId}`);
      } else {
        // For API tokens, verify through authService
        let tokenResult;
        try {
          tokenResult = await request.server.authService.verifyApiToken(token);
          if (!tokenResult) {
            throw new Error('Invalid API token');
          }
          userId = tokenResult.userId;
          debug(`Using API token for user: ${userId}`);
        } catch (error) {
          debug(`API token verification failed: ${error.message}`);
          throw new Error(`Token verification failed: ${error.message}`);
        }
      }

      // 4. Try owner access first (fastest path)
      const workspace = await tryOwnerAccess(
        request.server.workspaceManager,
        userId,
        workspaceId
      );

      if (workspace) {
        debug(`Owner access granted for workspace ${workspaceId}`);
        request.workspace = workspace;
        request.workspaceAccess = {
          permissions: ['read', 'write', 'admin'],
          isOwner: true,
          description: 'Workspace owner'
        };
        return; // Continue to route handler
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
          debug(`Token access granted for workspace ${workspaceId}: ${tokenAccess.access.description}`);
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
          request.server.userManager,
          workspaceId,
          userId,
          requiredPermission
        );

        if (userAccess) {
          debug(`User email access granted for workspace ${workspaceId}: ${userAccess.access.description}`);
          request.workspace = userAccess.workspace;
          request.workspaceAccess = {
            ...userAccess.access,
            isOwner: false
          };
          return; // Continue to route handler
        }
      }

      // 7. Access denied
      debug(`Access denied for workspace ${workspaceId}`);
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
      debug(`Workspace ACL validation error: ${error.message}`);
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
      // Try to get workspace by ID
      workspace = await workspaceManager.getWorkspace(userId, workspaceIdentifier, userId);
    } else {
      // Try to get workspace by name
      workspace = await workspaceManager.getWorkspaceByName(userId, workspaceIdentifier, userId);
    }

    return workspace;
  } catch (error) {
    debug(`Owner access failed: ${error.message}`);
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
      debug(`Token not found in any workspace ACL: ${tokenHash.substring(0, 16)}...`);
      return null;
    }

    // Validate token permissions and expiration
    const tokenData = workspaceEntry.acl.tokens[tokenHash];

    // Check expiration
    if (tokenData.expiresAt && new Date() > new Date(tokenData.expiresAt)) {
      debug(`Token has expired: ${tokenData.expiresAt}`);
      return null;
    }

    // Check permissions
    if (!tokenData.permissions.includes(requiredPermission)) {
      debug(`Token lacks required permission. Has: ${tokenData.permissions}, needs: ${requiredPermission}`);
      return null;
    }

    // Load the actual workspace instance for token access
    const workspace = await loadWorkspaceForTokenAccess(workspaceManager, workspaceEntry);
    if (!workspace) {
      debug(`Failed to load workspace for token access: ${workspaceIdentifier}`);
      return null;
    }

    return {
      workspace,
      access: tokenData,
      config: workspaceEntry
    };

  } catch (error) {
    debug(`Token access validation error: ${error.message}`);
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

    if (isWorkspaceId) {
      // Direct lookup by workspace ID
      const allWorkspaces = workspaceManager.getAllWorkspacesWithKeys();
      let workspaceEntry = null;

      // Search for workspace by ID across all users
      for (const [indexKey, entry] of Object.entries(allWorkspaces)) {
        const parsed = workspaceManager.constructor.prototype.constructor.parseWorkspaceIndexKey?.(indexKey) ||
                      (() => {
                        const parts = indexKey.split('::');
                        return parts.length === 2 ? { userId: parts[0], workspaceId: parts[1] } : null;
                      })();

        if (parsed && parsed.workspaceId === workspaceIdentifier) {
          workspaceEntry = entry;
          break;
        }
      }

      if (workspaceEntry) {
        // Check if token exists in this workspace's ACL
        const tokens = workspaceEntry.acl?.tokens || {};
        if (tokens[tokenHash]) {
          debug(`Found token in workspace ACL: ${workspaceIdentifier}`);
          return workspaceEntry;
        }
      }
    } else {
      // Search through all workspaces for a matching name and token
      const allWorkspaces = workspaceManager.getAllWorkspacesWithKeys();

      for (const [indexKey, workspaceEntry] of Object.entries(allWorkspaces)) {
        // Check if this workspace has the matching name and token
        if (workspaceEntry.name === workspaceIdentifier) {
          const tokens = workspaceEntry.acl?.tokens || {};
          if (tokens[tokenHash]) {
            const parsed = workspaceManager.constructor.prototype.constructor.parseWorkspaceIndexKey?.(indexKey) ||
                          (() => {
                            const parts = indexKey.split('::');
                            return parts.length === 2 ? { userId: parts[0], workspaceId: parts[1] } : null;
                          })();
            debug(`Found token in workspace ACL: ${parsed?.workspaceId || 'unknown'} (name: ${workspaceIdentifier})`);
            return workspaceEntry;
          }
        }
      }
    }

    debug(`Token not found in any workspace ACL: ${tokenHash.substring(0, 16)}...`);
    return null;

  } catch (error) {
    debug(`Error searching for token in workspace ACLs: ${error.message}`);
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
    const workspace = await workspaceManager.getWorkspaceById(workspaceEntry.id);
    return workspace;

  } catch (error) {
    debug(`Error loading workspace for token access: ${error.message}`);
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
    const user = await userManager.getUser(userId);
    if (!user || !user.email) {
      debug(`User not found or missing email: ${userId}`);
      return null;
    }

    // Find workspace and check user ACL
    const workspaceEntry = await findWorkspaceByUserEmail(workspaceManager, workspaceIdentifier, user.email);
    if (!workspaceEntry) {
      debug(`User ${user.email} not found in any workspace ACL for workspace: ${workspaceIdentifier}`);
      return null;
    }

    // Validate user permissions
    const userData = workspaceEntry.acl.users[user.email];
    if (!userData.permissions.includes(requiredPermission)) {
      debug(`User ${user.email} lacks required permission. Has: ${userData.permissions}, needs: ${requiredPermission}`);
      return null;
    }

    // Load the actual workspace instance
    const workspace = await loadWorkspaceForUserAccess(workspaceManager, workspaceEntry, userId);
    if (!workspace) {
      debug(`Failed to load workspace for user access: ${workspaceIdentifier}`);
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
    debug(`User access validation error: ${error.message}`);
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

    if (isWorkspaceId) {
      // Direct lookup by workspace ID
      const allWorkspaces = workspaceManager.getAllWorkspacesWithKeys();

      // Search for workspace by ID across all users
      for (const [indexKey, workspaceEntry] of Object.entries(allWorkspaces)) {
        if (workspaceEntry.id === workspaceIdentifier) {
          // Check if user email exists in this workspace's user ACL
          const users = workspaceEntry.acl?.users || {};
          if (users[userEmail]) {
            debug(`Found user ${userEmail} in workspace ACL: ${workspaceIdentifier}`);
            return workspaceEntry;
          }
        }
      }
    } else {
      // Search through all workspaces for a matching name and user email
      const allWorkspaces = workspaceManager.getAllWorkspacesWithKeys();

      for (const [indexKey, workspaceEntry] of Object.entries(allWorkspaces)) {
        // Check if this workspace has the matching name and user email
        if (workspaceEntry.name === workspaceIdentifier) {
          const users = workspaceEntry.acl?.users || {};
          if (users[userEmail]) {
            debug(`Found user ${userEmail} in workspace ACL: ${workspaceEntry.id} (name: ${workspaceIdentifier})`);
            return workspaceEntry;
          }
        }
      }
    }

    debug(`User ${userEmail} not found in workspace ACL for: ${workspaceIdentifier}`);
    return null;

  } catch (error) {
    debug(`Error finding workspace by user email: ${error.message}`);
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
    const workspace = await workspaceManager.getWorkspaceById(workspaceEntry.id, workspaceEntry.owner);
    return workspace;

  } catch (error) {
    debug(`Error loading workspace for user access: ${error.message}`);
    return null;
  }
}

/**
 * Convenience middleware factories for common permissions
 */
export const requireWorkspaceRead = () => createWorkspaceACLMiddleware('read');
export const requireWorkspaceWrite = () => createWorkspaceACLMiddleware('write');
export const requireWorkspaceAdmin = () => createWorkspaceACLMiddleware('admin');

export default {
  createWorkspaceACLMiddleware,
  requireWorkspaceRead,
  requireWorkspaceWrite,
  requireWorkspaceAdmin
};
