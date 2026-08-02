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

  // Positive-only access cache for this socket. Avoids re-validating the same
  // workspace on every event during bulk operations (e.g. WebDAV uploads).
  // Negatives are not cached so a share granted mid-session still takes effect.
  const accessCache = new Set();

  // Resolve a user id to a human-readable email for log messages (best-effort,
  // synchronous index lookup – no disk I/O).
  const emailFor = (userId) => {
    try { return fastify.users?.indexStore?.get?.(userId)?.email || userId; }
    catch { return userId; }
  };

  /**
   * Wildcard listener -> forwards every event from WorkspaceManager.
   * Uses standard EventEmitter2 "this.event" to determine event name.
   */
  const wildcardListener = async function (eventPayload) {
    try {
      const eventName = this.event; // event string from EventEmitter2
      // Only treat eventPayload.id as a workspace identifier when it looks like
      // a workspace UUID. Document events carry a numeric `id` that must not be
      // mistaken for a workspace.
      const payloadId = eventPayload?.id;
      const workspaceIdentifiers = [
        eventPayload?.workspaceId,
        eventPayload?.workspaceName,
        UUID_RE.test(String(payloadId ?? '')) ? payloadId : null
      ].filter(Boolean);
      const userId = socket.user?.id;

      // Share-token sockets authenticate as the owner but are bound to one
      // workspace: only events explicitly tagged with that workspace pass.
      const binding = socket.workspaceBinding;
      if (binding) {
        const matchesBinding = workspaceIdentifiers.some(
          (identifier) => identifier === binding.workspaceId || identifier === binding.workspaceName
        );
        if (!matchesBinding || !binding.permissions?.includes('read')) {
          return;
        }
      }

      if (workspaceIdentifiers.length === 0) {
        socket.emit(eventName, eventPayload);
        return;
      }

      // Only forward if client explicitly subscribed to this workspace channel
      const hasSubscription = workspaceIdentifiers.some((identifier) => socket.subscriptions?.has?.(`workspace:${identifier}`));
      if (!hasSubscription) {
        return;
      }

      // Verify access (cached positives skip revalidation on the hot path).
      let hasAccess = workspaceIdentifiers.some((identifier) => accessCache.has(identifier));
      if (!hasAccess) {
        hasAccess = await validateWorkspaceAccess(socket, workspaceIdentifiers, workspaceManager);
        if (hasAccess) {
          for (const identifier of workspaceIdentifiers) accessCache.add(identifier);
        }
      }

      if (!hasAccess) {
        logger.debug(`Access denied for user ${emailFor(userId)} to workspace ${workspaceIdentifiers.join(', ')} – not forwarding ${eventName}`);
        return;
      }

      socket.emit(eventName, eventPayload);
      logger.debug(`➡️  forwarded ${eventName} to ${emailFor(userId)}`);
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
async function validateWorkspaceAccess(socket, workspaceIdentifierInput, workspaceManager) {
  try {
    const userId = socket.user?.id;
    if (!userId) {
      logger.debug(`No user ID found on socket for workspace access validation`);
      return false;
    }

    // Token is only required for token-based ACL shares.
    // Owner access should work for JWT-authenticated sockets as well.
    const token = socket.handshake?.auth?.token;

    // Try owner access first (fastest path). The manager is passed in from the
    // channel closure (fastify.workspaceManager) — it is NOT available via
    // socket.server, which previously made every owner check fail.
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
        // Names resolve to an id via the in-memory name index; ids are used
        // directly. hasWorkspace performs an index-only owner check (no
        // workspace instantiation, no disk I/O).
        const workspaceId = isWorkspaceId
          ? workspaceIdentifier
          : workspaceManager.resolveWorkspaceId(userId, workspaceIdentifier);

        if (workspaceId && await workspaceManager.hasWorkspace(workspaceId, userId)) {
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
