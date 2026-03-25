import { createLogger } from '../../../utils/log.js';
import crypto from 'crypto';

const logger = createLogger('websocket:workspace');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    logger.debug('⚠️  workspaceManager not present on fastify – skipping workspace WS setup');
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
      const workspaceIdentifiers = [
        eventPayload?.workspaceId,
        eventPayload?.workspaceName,
        eventPayload?.id
      ].filter(Boolean);
      const userId = socket.user?.id;

      if (workspaceIdentifiers.length === 0) {
        socket.emit(eventName, eventPayload);
        return;
      }

      // Only forward if client explicitly subscribed to this workspace channel
      const hasSubscription = workspaceIdentifiers.some((identifier) => socket.subscriptions?.has?.(`workspace:${identifier}`));
      if (!hasSubscription) {
        return;
      }

      // Verify access using token-based ACL validation
      const hasAccess = await validateWorkspaceAccess(socket, workspaceIdentifiers);
      if (!hasAccess) {
        logger.debug(`Access denied for user ${userId} to workspace ${workspaceIdentifiers.join(', ')} – not forwarding ${eventName}`);
        return;
      }

      socket.emit(eventName, eventPayload);
      logger.debug(`➡️  forwarded ${eventName} to ${userId}`);
    } catch (err) {
      logger.debug(`Error forwarding workspace event: ${err.message}`);
    }
  };

  // Listen to *all* events.
  workspaceManager.on('**', wildcardListener);
  listeners.set('workspaceWildcard', wildcardListener);

  // Clean-up on disconnect.
  socket.on('disconnect', () => {
    listeners.forEach((listener) => workspaceManager.off('**', listener));
    listeners.clear();
    logger.debug(`Cleaned workspace WS listeners for socket ${socket.id}`);
  });
}

/**
 * Validate workspace access using token-based ACLs
 * @param {Socket} socket - Authenticated socket with user info
 * @param {string|string[]} workspaceIdentifierInput - Workspace ID or name to validate access for
 * @returns {Promise<boolean>} True if access is granted, false otherwise
 */
async function validateWorkspaceAccess(socket, workspaceIdentifierInput) {
  try {
    const userId = socket.user?.id;
    if (!userId) {
      logger.debug(`No user ID found on socket for workspace access validation`);
      return false;
    }

    // Token is only required for token-based ACL shares.
    // Owner access should work for JWT-authenticated sockets as well.
    const token = socket.handshake?.auth?.token;

    // Try owner access first (fastest path)
    const workspaceManager = socket.server?.workspaceManager;
    if (!workspaceManager) {
      logger.debug(`WorkspaceManager not available for access validation`);
      return false;
    }

    const workspaceIdentifiers = Array.isArray(workspaceIdentifierInput)
      ? workspaceIdentifierInput.filter(Boolean)
      : [workspaceIdentifierInput].filter(Boolean);

    try {
      for (const workspaceIdentifier of workspaceIdentifiers) {
        const isWorkspaceId = UUID_RE.test(workspaceIdentifier);
        const workspace = isWorkspaceId
          ? await workspaceManager.getWorkspaceById(workspaceIdentifier, userId)
          : await workspaceManager.getWorkspaceByName(userId, workspaceIdentifier, userId);

        if (workspace) {
          logger.debug(`Owner access granted for workspace ${workspaceIdentifier}`);
          return true;
        }
      }
    } catch (error) {
      logger.debug(`Owner access check failed: ${error.message}`);
    }

    // Try token-based access (only for canvas-* tokens)
    if (!token || !token.startsWith('canvas-')) {
      return false;
    }
    const tokenHash = `sha256:${crypto.createHash('sha256').update(token).digest('hex')}`;
    const allWorkspaces = await workspaceManager.listWorkspaces();

    for (const workspaceIdentifier of workspaceIdentifiers) {
      const isWorkspaceId = UUID_RE.test(workspaceIdentifier);
      for (const workspaceEntry of allWorkspaces) {
        const matches = isWorkspaceId
          ? workspaceEntry.id === workspaceIdentifier
          : workspaceEntry.name === workspaceIdentifier;
        if (!matches) {
          continue;
        }

        const tokens = workspaceEntry.acl?.tokens || {};
        const tokenData = tokens[tokenHash];

        if (!tokenData) {
          continue;
        }
        if (tokenData.expiresAt && new Date() > new Date(tokenData.expiresAt)) {
          logger.debug(`Token has expired for workspace ${workspaceIdentifier}`);
          continue;
        }
        if (tokenData.permissions.includes('read')) {
          logger.debug(`Token access granted for workspace ${workspaceIdentifier}`);
          return true;
        }
      }
    }

    logger.debug(`No valid access found for workspace ${workspaceIdentifiers.join(', ')}`);
    return false;

  } catch (error) {
    logger.debug(`Error validating workspace access: ${error.message}`);
    return false;
  }
}
