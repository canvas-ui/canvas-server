import { createLogger } from '../../../utils/log.js';

const logger = createLogger('websocket:context');

/**
 * Push-only WebSocket bridge for context events.
 *
 * Listens to **all** events emitted by ContextManager and forwards them to the
 * socket when the authenticated user has ACL/ownership access to the context.
 */
export default function registerContextWebSocket(fastify, socket) {
  const { contextManager } = fastify;
  if (!contextManager) {
    logger.debug('⚠️  contextManager missing – skipping context WS setup');
    return;
  }

  const listeners = new Map();

  const wildcardListener = async function (payload) {
    logger.debug('🎯 DEBUG: Wildcard listener received event:', this.event);
    logger.debug('🎯 DEBUG: Event payload:', JSON.stringify(payload, null, 2));

    try {
      const eventName = this.event;
      const contextId = payload?.contextId || payload?.id;
      const userId = socket.user?.id;

      logger.debug(`🎯 DEBUG: Processing event "${eventName}" for contextId="${contextId}", userId="${userId}"`);

      if (!userId) {
        logger.debug('❌ User ID not found on socket - skipping event');
        return;
      }

      if (contextId) {
        try {
          // Use getContext instead of hasContext to properly check permissions
          const context = await contextManager.getContext(userId, contextId);
          if (!context) {
            logger.debug(`❌ User ${userId} lacks access to context ${contextId} – skip ${eventName}`);
            return;
          }
          logger.debug(`✅ User ${userId} has access to context ${contextId}`);

          // Forward only if this socket explicitly subscribed to this context
          const subscriptionKey = `context:${contextId}`;
          if (!socket.subscriptions?.has(subscriptionKey)) {
            logger.debug(`📭 Socket ${socket.id} not subscribed to ${subscriptionKey} – skip ${eventName}`);
            return;
          }

          logger.debug(`➡️  Forwarding ${eventName} to socket ${socket.id}`);
        } catch (error) {
          logger.debug(`❌ Access check failed for user ${userId} to context ${contextId}: ${error.message} – skip ${eventName}`);
          return;
        }
      } else {
        logger.debug(`🎯 Event "${eventName}" has no contextId, forwarding to all users`);
      }

      socket.emit(eventName, payload);
      logger.debug(`➡️  sent ${eventName} to ${userId}`);
    } catch (err) {
      logger.debug(`❌ Error forwarding context event: ${err.message}`);
      logger.debug(`❌ Error stack:`, err.stack);
    }
  };

  contextManager.on('**', wildcardListener);
  listeners.set('contextWildcard', wildcardListener);

  logger.debug(`✅ Context WebSocket bridge registered for socket ${socket.id} (user: ${socket.user?.id})`);

  socket.on('disconnect', () => {
    listeners.forEach((listener) => contextManager.off('**', listener));
    listeners.clear();
    logger.debug(`Cleaned context WS listeners for socket ${socket.id}`);
  });
}
