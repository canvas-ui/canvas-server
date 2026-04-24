'use strict';

import { createLogger } from '../../../utils/log.js';

const logger = createLogger('canvas-server:websocket:agent');

/**
 * Agent WebSocket channel for real-time agent interactions
 * Handles streaming chat responses and agent status updates
 *
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Socket} socket - Socket.io socket instance
 */
export default function registerAgentWebSocket(fastify, socket) {
  const { user } = socket;

  logger.debug(`🎭 Registering agent WebSocket for socket ${socket.id}, user ${user.email}`);

  // Initialize subscriptions if not exists
  if (!socket.subscriptions) {
    socket.subscriptions = new Set();
  }

  // Handle agent subscriptions
  socket.on('agent:subscribe', async (data) => {
    try {
      const { agentId } = data;
      if (!agentId) {
        socket.emit('error', { message: 'Agent ID required for subscription' });
        return;
      }

      // Verify agent access
      const agent = await fastify.agents.open(user.id, agentId, user.id);
      if (!agent) {
        socket.emit('error', { message: 'Agent not found or access denied' });
        return;
      }

      const subscriptionKey = `agent:${agentId}`;
      socket.subscriptions.add(subscriptionKey);
      socket.join(`agent:${agentId}`);

      logger.debug(`✅ Socket ${socket.id} subscribed to agent ${agentId}`);
      socket.emit('agent:subscribed', { agentId });
    } catch (error) {
      logger.debug(`❌ Agent subscription error for ${socket.id}: ${error.message}`);
      socket.emit('error', { message: 'Failed to subscribe to agent' });
    }
  });

  // Handle agent unsubscriptions
  socket.on('agent:unsubscribe', (data) => {
    try {
      const { agentId } = data;
      if (!agentId) return;

      const subscriptionKey = `agent:${agentId}`;
      socket.subscriptions.delete(subscriptionKey);
      socket.leave(`agent:${agentId}`);

      logger.debug(`🔇 Socket ${socket.id} unsubscribed from agent ${agentId}`);
      socket.emit('agent:unsubscribed', { agentId });
    } catch (error) {
      logger.debug(`❌ Agent unsubscription error for ${socket.id}: ${error.message}`);
    }
  });

  // Handle streaming prompt requests
  socket.on('agent:chat:stream', async (data) => {
    try {
      const { agentId, message } = data;

      if (!agentId || !message) {
        socket.emit('agent:chat:error', { agentId, error: 'agentId and message are required' });
        return;
      }

      const agent = await fastify.agents.open(user.id, agentId, user.id);
      if (!agent) {
        socket.emit('agent:chat:error', { agentId, error: 'Agent not found or access denied' });
        return;
      }

      if (!agent.isActive) {
        socket.emit('agent:chat:error', { agentId, error: 'Agent is not active' });
        return;
      }

      socket.emit('agent:chat:start', { agentId, messageId: data.messageId });

      const collectedMessages = [];

      const onEvent = (event) => {
        switch (event.type) {
          case 'message_update': {
            const ae = event.assistantMessageEvent;
            if (ae?.type === 'text_delta') {
              socket.emit('agent:chat:chunk', { agentId, messageId: data.messageId, type: 'chunk', delta: ae.delta });
            }
            if (ae?.type === 'thinking_delta') {
              socket.emit('agent:chat:chunk', { agentId, messageId: data.messageId, type: 'thinking', delta: ae.delta });
            }
            break;
          }
          case 'tool_execution_start':
            socket.emit('agent:chat:chunk', { agentId, messageId: data.messageId, type: 'tool_start', toolName: event.toolName });
            break;
          case 'tool_execution_end':
            socket.emit('agent:chat:chunk', { agentId, messageId: data.messageId, type: 'tool_end', toolName: event.toolName, isError: event.isError ?? false });
            break;
          case 'message_end':
            if (event.message?.role === 'assistant') collectedMessages.push(event.message);
            break;
        }
      };

      await agent.stream(message, onEvent);

      socket.emit('agent:chat:complete', { agentId, messageId: data.messageId, messages: collectedMessages });
      logger.debug(`Streaming prompt completed for agent ${agentId} by user ${user.id}`);
    } catch (error) {
      logger.debug(`Streaming error for ${socket.id}: ${error.message}`);
      socket.emit('agent:chat:error', { agentId: data?.agentId, messageId: data?.messageId, error: error.message });
    }
  });

  // Forward Agents service events to this socket (status changes, create, update, delete)
  if (fastify.agents) {
    const userId = user.id;

    const agentEventListener = function (payload) {
      const eventName = this.event;
      const eventUserId = payload?.userId || payload?.agent?.owner;
      if (eventUserId !== userId) return;

      switch (eventName) {
        case 'agent.created':
          socket.emit('agent.created', payload);
          break;
        case 'agent.updated':
          socket.emit('agent.updated', payload);
          break;
        case 'agent.deleted':
          socket.emit('agent.deleted', payload);
          break;
        case 'agent.started':
          socket.emit('agent.status.changed', { agentId: payload.agentId, status: 'active' });
          break;
        case 'agent.stopped':
          socket.emit('agent.status.changed', { agentId: payload.agentId, status: 'inactive' });
          break;
        case 'agent.startFailed':
        case 'agent.stopFailed':
          socket.emit('agent.status.changed', { agentId: payload.agentId, status: 'error' });
          break;
      }
    };

    fastify.agents.on('**', agentEventListener);
    socket.on('disconnect', () => {
      fastify.agents.off('**', agentEventListener);
      logger.debug(`🔌 Agent WebSocket cleanup for socket ${socket.id}`);
    });
  } else {
    socket.on('disconnect', () => {
      logger.debug(`🔌 Agent WebSocket cleanup for socket ${socket.id}`);
    });
  }

  logger.debug(`✅ Agent WebSocket registered for socket ${socket.id}`);
}
