import { createDebug } from '../../../utils/log/index.js';

const debug = createDebug('websocket:context');

/**
 * Push-only WebSocket bridge for context events.
 *
 * Listens to **all** events emitted by ContextManager and forwards them to the
 * socket when the authenticated user has ACL/ownership access to the context.
 */
export default function registerContextWebSocket(fastify, socket) {
  const { contextManager } = fastify;
  if (!contextManager) {
    debug('⚠️  contextManager missing – skipping context WS setup');
    return;
  }

  const listeners = new Map();

  const wildcardListener = async function (payload) {
    debug('🎯 DEBUG: Wildcard listener received event:', this.event);
    debug('🎯 DEBUG: Event payload:', JSON.stringify(payload, null, 2));

    try {
      const eventName = this.event;
      const contextId = payload?.contextId || payload?.id;
      const userId = socket.user?.id;

      debug(`🎯 DEBUG: Processing event "${eventName}" for contextId="${contextId}", userId="${userId}"`);

      if (!userId) {
        debug('❌ User ID not found on socket - skipping event');
        return;
      }

      if (contextId) {
        try {
          // Use getContext instead of hasContext to properly check permissions
          const context = await contextManager.getContext(userId, contextId);
          if (!context) {
            debug(`❌ User ${userId} lacks access to context ${contextId} – skip ${eventName}`);
            return;
          }
          debug(`✅ User ${userId} has access to context ${contextId}`);

          // Forward only if this socket explicitly subscribed to this context
          const subscriptionKey = `context:${contextId}`;
          if (!socket.subscriptions?.has(subscriptionKey)) {
            debug(`📭 Socket ${socket.id} not subscribed to ${subscriptionKey} – skip ${eventName}`);
            return;
          }

          debug(`➡️  Forwarding ${eventName} to socket ${socket.id}`);
        } catch (error) {
          debug(`❌ Access check failed for user ${userId} to context ${contextId}: ${error.message} – skip ${eventName}`);
          return;
        }
      } else {
        debug(`🎯 Event "${eventName}" has no contextId, forwarding to all users`);
      }

      socket.emit(eventName, payload);
      debug(`➡️  sent ${eventName} to ${userId}`);
    } catch (err) {
      debug(`❌ Error forwarding context event: ${err.message}`);
      debug(`❌ Error stack:`, err.stack);
    }
  };

  contextManager.on('**', wildcardListener);
  listeners.set('contextWildcard', wildcardListener);

  debug(`✅ Context WebSocket bridge registered for socket ${socket.id} (user: ${socket.user?.id})`);

  socket.on('disconnect', () => {
    listeners.forEach((listener) => contextManager.off('**', listener));
    listeners.clear();
    debug(`Cleaned context WS listeners for socket ${socket.id}`);
  });
}
