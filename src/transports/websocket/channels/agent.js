'use strict';

import { createDebug } from '../../../utils/log/index.js';

const debug = createDebug('canvas-server:websocket:agent');

/**
 * Agent WebSocket channel for real-time agent interactions
 * Handles streaming chat responses and agent status updates
 *
 * @param {FastifyInstance} fastify - Fastify instance
 * @param {Socket} socket - Socket.io socket instance
 */
export default function registerAgentWebSocket(fastify, socket) {
  const { user } = socket;

  debug(`🎭 Registering agent WebSocket for socket ${socket.id}, user ${user.email}`);

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

      debug(`✅ Socket ${socket.id} subscribed to agent ${agentId}`);
      socket.emit('agent:subscribed', { agentId });
    } catch (error) {
      debug(`❌ Agent subscription error for ${socket.id}: ${error.message}`);
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

      debug(`🔇 Socket ${socket.id} unsubscribed from agent ${agentId}`);
      socket.emit('agent:unsubscribed', { agentId });
    } catch (error) {
      debug(`❌ Agent unsubscription error for ${socket.id}: ${error.message}`);
    }
  });

  // Handle streaming chat requests
  socket.on('agent:chat:stream', async (data) => {
    try {
      const { agentId, message, context, mcpContext = true, maxTokens, temperature } = data;

      if (!agentId || !message) {
        socket.emit('agent:chat:error', {
          agentId,
          error: 'Agent ID and message are required'
        });
        return;
      }

      // Verify agent access and status
      const agent = await fastify.agents.open(user.id, agentId, user.id);
      if (!agent) {
        socket.emit('agent:chat:error', {
          agentId,
          error: 'Agent not found or access denied'
        });
        return;
      }

      if (!agent.isActive) {
        socket.emit('agent:chat:error', {
          agentId,
          error: 'Agent is not active. Please start the agent first.'
        });
        return;
      }

      // Start streaming response
      socket.emit('agent:chat:start', { agentId, messageId: data.messageId });

      const onChunk = (chunk) => {
        socket.emit('agent:chat:chunk', {
          agentId,
          messageId: data.messageId,
          type: chunk.type,
          content: chunk.content,
          delta: chunk.delta
        });
      };

      // Execute streaming chat
      const result = await agent.chatStream(message, {
        context,
        mcpContext,
        maxTokens,
        temperature,
        onChunk
      });

      // Send completion
      socket.emit('agent:chat:complete', {
        agentId,
        messageId: data.messageId,
        result
      });

      debug(`💬 Streaming chat completed for agent ${agentId} by user ${user.id}`);
    } catch (error) {
      debug(`❌ Streaming chat error for ${socket.id}: ${error.message}`);
      socket.emit('agent:chat:error', {
        agentId: data?.agentId,
        messageId: data?.messageId,
        error: error.message || 'Failed to process chat stream'
      });
    }
  });

  // Clean up subscriptions on disconnect
  socket.on('disconnect', () => {
    debug(`🔌 Agent WebSocket cleanup for socket ${socket.id}`);
    // Subscriptions are automatically cleaned up by socket.io
  });

  debug(`✅ Agent WebSocket registered for socket ${socket.id}`);
}
