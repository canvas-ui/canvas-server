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
    logger.debug('contextManager missing, skipping context WS setup');
    return;
  }

  const listeners = new Map();

  const wildcardListener = async function (payload) {
    try {
      const eventName = this.event;
      const contextId = payload?.contextId || payload?.id;
      const userId = socket.user?.id;

      if (!userId) {
        return;
      }

      if (contextId) {
        try {
          const context = await contextManager.getContext(userId, contextId);
          if (!context) {
            return;
          }

          const subscriptionKey = `context:${contextId}`;
          if (!socket.subscriptions?.has(subscriptionKey)) {
            return;
          }
        } catch (error) {
          logger.debug(`Context access check failed for ${userId}/${contextId}: ${error.message}`);
          return;
        }
      }

      socket.emit(eventName, payload);
      logger.debug(`Forwarded ${eventName} to ${userId}`);
    } catch (err) {
      logger.debug(`Error forwarding context event: ${err.message}`);
    }
  };

  contextManager.on('**', wildcardListener);
  listeners.set('contextWildcard', wildcardListener);

  logger.debug(`Context WebSocket bridge registered for socket ${socket.id}`);

  socket.on('disconnect', () => {
    listeners.forEach((listener) => contextManager.off('**', listener));
    listeners.clear();
    logger.debug(`Cleaned context WS listeners for socket ${socket.id}`);
  });
}
