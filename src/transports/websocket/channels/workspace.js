import { createDebug } from '../../../utils/log/index.js';
import crypto from 'crypto';

const debug = createDebug('websocket:workspace');

/**
 * Register workspace-update websocket forwarding for a specific socket.
 * The module listens to *all* events emitted by WorkspaceManager and
 * forwards them to the connected client if the user has access to the
 * referenced workspace.
 *
 * We deliberately do *not* implement any RPC or data-retrieval over the
 * socket – those actions are available through the REST API. The socket
 * channel is used exclusively for real-time update pushes.
 *
 * @param {import('fastify').FastifyInstance} fastify Fastify instance
 * @param {import('socket.io').Socket}            socket  Authenticated socket
 */
export default function registerWorkspaceWebSocket(fastify, socket) {
  const { workspaceManager } = fastify;
  if (!workspaceManager) {
    debug('⚠️  workspaceManager not present on fastify – skipping workspace WS setup');
    return;
  }

  // Map<key, listener> so we can cleanly remove on disconnect.
  const listeners = new Map();

  /**
   * Wildcard listener -> forwards every event from WorkspaceManager.
   * Uses standard EventEmitter2 "this.event" to determine event name.
   */
  const wildcardListener = async function (eventPayload) {
    try {
      const eventName = this.event; // event string from EventEmitter2
      const workspaceId = eventPayload?.workspaceId || eventPayload?.id;
      const userId = socket.user?.id;

      if (!workspaceId) {
        // If event isn't workspace-specific just forward.
        socket.emit(eventName, eventPayload);
        return;
      }

      // Verify access using token-based ACL validation
      const hasAccess = await validateWorkspaceAccess(socket, workspaceId);
      if (!hasAccess) {
        debug(`Access denied for user ${userId} to workspace ${workspaceId} – not forwarding ${eventName}`);
        return;
      }

      socket.emit(eventName, eventPayload);
      debug(`➡️  forwarded ${eventName} to ${userId}`);
    } catch (err) {
      debug(`Error forwarding workspace event: ${err.message}`);
    }
  };

  // Listen to *all* events.
  workspaceManager.on('**', wildcardListener);
  listeners.set('workspaceWildcard', wildcardListener);

  // Clean-up on disconnect.
  socket.on('disconnect', () => {
    listeners.forEach((listener) => workspaceManager.off('**', listener));
    listeners.clear();
    debug(`Cleaned workspace WS listeners for socket ${socket.id}`);
  });
}

/**
 * Validate workspace access using token-based ACLs
 * @param {Socket} socket - Authenticated socket with user info
 * @param {string} workspaceIdentifier - Workspace ID or name to validate access for
 * @returns {Promise<boolean>} True if access is granted, false otherwise
 */
async function validateWorkspaceAccess(socket, workspaceIdentifier) {
  try {
    const userId = socket.user?.id;
    if (!userId) {
      debug(`No user ID found on socket for workspace access validation`);
      return false;
    }

    // Get the token from the socket handshake
    const token = socket.handshake?.auth?.token;
    if (!token || !token.startsWith('canvas-')) {
      debug(`Invalid or missing Canvas token for workspace access`);
      return false;
    }

    // Try owner access first (fastest path)
    const workspaceManager = socket.server?.workspaceManager;
    if (!workspaceManager) {
      debug(`WorkspaceManager not available for access validation`);
      return false;
    }

    try {
      // Check if identifier is a workspace ID (12 chars) or name
      const isWorkspaceId = workspaceIdentifier.length === 12 && /^[a-zA-Z0-9]+$/.test(workspaceIdentifier);

      let workspace;
      if (isWorkspaceId) {
        workspace = await workspaceManager.getWorkspaceById(workspaceIdentifier, userId);
      } else {
        workspace = await workspaceManager.getWorkspaceByName(userId, workspaceIdentifier, userId);
      }

      if (workspace) {
        debug(`Owner access granted for workspace ${workspaceIdentifier}`);
        return true;
      }
    } catch (error) {
      debug(`Owner access check failed: ${error.message}`);
    }

    // Try token-based access
    const tokenHash = `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
    const allWorkspaces = workspaceManager.getAllWorkspacesWithKeys();

    // Check if identifier is a workspace ID (12 chars) or name
    const isWorkspaceId = workspaceIdentifier.length === 12 && /^[a-zA-Z0-9]+$/.test(workspaceIdentifier);

    if (isWorkspaceId) {
      // Direct lookup by workspace ID
      let workspaceEntry = null;

      // Search for workspace by ID across all users
      for (const [indexKey, entry] of Object.entries(allWorkspaces)) {
        const parsed = (() => {
          const parts = indexKey.split('/');
          return parts.length === 2 ? { userId: parts[0], workspaceId: parts[1] } : null;
        })();

        if (parsed && parsed.workspaceId === workspaceIdentifier) {
          workspaceEntry = entry;
          break;
        }
      }

      if (workspaceEntry) {
        const tokens = workspaceEntry.acl?.tokens || {};
        const tokenData = tokens[tokenHash];

        if (tokenData) {
          // Check expiration
          if (tokenData.expiresAt && new Date() > new Date(tokenData.expiresAt)) {
            debug(`Token has expired for workspace ${workspaceIdentifier}`);
            return false;
          }

          // WebSocket access requires at least read permission
          if (tokenData.permissions.includes('read')) {
            debug(`Token access granted for workspace ${workspaceIdentifier}`);
            return true;
          }
        }
      }
    } else {
      // Search through all workspaces for a matching name and token
      for (const [indexKey, workspaceEntry] of Object.entries(allWorkspaces)) {
        if (workspaceEntry.name === workspaceIdentifier) {
          const tokens = workspaceEntry.acl?.tokens || {};
          const tokenData = tokens[tokenHash];

          if (tokenData) {
            // Check expiration
            if (tokenData.expiresAt && new Date() > new Date(tokenData.expiresAt)) {
              debug(`Token has expired for workspace ${workspaceIdentifier}`);
              continue;
            }

            // WebSocket access requires at least read permission
            if (tokenData.permissions.includes('read')) {
              debug(`Token access granted for workspace ${workspaceIdentifier}`);
              return true;
            }
          }
        }
      }
    }

    debug(`No valid access found for workspace ${workspaceIdentifier}`);
    return false;

  } catch (error) {
    debug(`Error validating workspace access: ${error.message}`);
    return false;
  }
}
