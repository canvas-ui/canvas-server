'use strict';

import { createDebug } from '../../utils/log/index.js';
import { authService } from '../auth/strategies.js';
import registerContextWebSocket from './channels/context.js';
import registerWorkspaceWebSocket from './channels/workspace.js';
import registerAgentWebSocket from './channels/agent.js';

const debug = createDebug('canvas-server:websocket:main');

/**
 * WebSocket bootstrap – push-only design.
 *  • Authenticates sockets (JWT or API token handled by fastify.authService).
 *  • Tracks active connections & rate-limits handshake abuse.
 *  • Exposes broadcast helpers used by core managers.
 *  • Delegates actual event forwarding to dedicated modules:
 *      – context.js     (ContextManager → client)
 *      – workspace.js   (WorkspaceManager → client)
 */
export default function setupWebSocketHandlers(fastify) {
  const io = fastify.io;
  const connections = new Map(); // socket.id → { socket, user, lastActivity }
  const connectionAttempts = new Map(); // ip → { count, timestamp }

  debug('🚀 Setting up WebSocket handlers...');

  /* ---------------- Authentication middleware ---------------- */
  io.use(async (socket, next) => {
    try {
      const clientIp = socket.handshake.address;
      const connectionId = socket.handshake.headers['x-connection-id'] || generateConnectionId();

      debug(`🔐 Authenticating WebSocket connection from ${clientIp}`);

      // rudimentary rate-limit on handshake attempts per IP
      const attempt = connectionAttempts.get(clientIp) || { count: 0, timestamp: Date.now() };
      attempt.count += 1;
      connectionAttempts.set(clientIp, attempt);
      if (attempt.count > 10 && (Date.now() - attempt.timestamp) < 60_000) {
        const error = new Error('Too many connection attempts');
        debug(`❌ Rate limit exceeded for ${clientIp}`);
        next(error);
        // Force disconnect to close TCP connection
        socket.disconnect(true);
        return;
      }
      if ((Date.now() - attempt.timestamp) > 60_000) {
        attempt.count = 1;
        attempt.timestamp = Date.now();
      }

      // extract bearer / ws auth token
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        const error = new Error('Authentication token required');
        debug(`❌ No token provided for ${clientIp}`);
        next(error);
        // Force disconnect to close TCP connection
        socket.disconnect(true);
        return;
      }

      let user;
      if (token.startsWith('canvas-')) {
        debug(`🎫 Verifying Canvas API token for ${clientIp}`);
        const apiRes = await authService.verifyApiToken(token);
        if (!apiRes) {
          const error = new Error('Invalid API token');
          debug(`❌ Invalid Canvas API token for ${clientIp}`);
          next(error);
          // Force disconnect to close TCP connection
          socket.disconnect(true);
          return;
        }
        user = await fastify.userManager.getUserById(apiRes.userId);
      } else {
        debug(`🎫 Verifying JWT token for ${clientIp}`);
        // Use authService to verify JWT token consistently with REST API
        const verificationResult = await authService.verifyToken(token);
        if (!verificationResult.valid) {
          const error = new Error(`JWT verification failed: ${verificationResult.message}`);
          debug(`❌ JWT verification failed for ${clientIp}: ${verificationResult.message}`);
          next(error);
          socket.disconnect(true);
          return;
        }
        user = verificationResult.user;
      }

      if (!user || user.status !== 'active') {
        const error = new Error('Invalid user');
        debug(`❌ Invalid or inactive user for ${clientIp}`);
        next(error);
        // Force disconnect to close TCP connection
        socket.disconnect(true);
        return;
      }

      socket.user = { id: user.id, email: user.email.toLowerCase() };
      socket.connectionId = connectionId;
      debug(`✅ WebSocket authenticated: ${user.email} (${user.id}) from ${clientIp}`);
      next();
    } catch (err) {
      const error = new Error(`Auth error: ${err.message}`);
      debug(`❌ Authentication error: ${err.message}`);
      next(error);
      // Force disconnect to close TCP connection
      socket.disconnect(true);
    }
  });

  /* ---------------- Broadcast helpers ---------------- */
  fastify.decorate('broadcastToUser', (userId, event, payload) => {
    debug(`📡 Broadcasting event "${event}" to user ${userId}`);
    let sent = 0;
    connections.forEach((conn) => {
      if (conn.user.id === userId) {
        try {
          debug(`  ➡️  Sending to socket ${conn.socket.id}`);
          conn.socket.emit(event, payload);
          sent++;
        } catch (error) {
          debug(`  ❌ Failed to send to socket ${conn.socket.id}:`, error.message);
        }
      }
    });
    debug(`📡 Broadcast complete: sent to ${sent} connections for user ${userId}`);
    return sent;
  });

  fastify.decorate('broadcastToWorkspace', (workspaceId, event, payload) => {
    debug(`📡 Broadcasting event "${event}" to workspace ${workspaceId}`);
    let sent = 0;
    connections.forEach((conn) => {
      if (conn.socket.subscriptions?.has?.(`workspace:${workspaceId}`)) {
        try {
          debug(`  ➡️  Sending to socket ${conn.socket.id}`);
          conn.socket.emit(event, payload);
          sent++;
        } catch (error) {
          debug(`  ❌ Failed to send to socket ${conn.socket.id}:`, error.message);
        }
      }
    });
    debug(`📡 Broadcast complete: sent to ${sent} connections for workspace ${workspaceId}`);
    return sent;
  });

  fastify.decorate('broadcastToContext', (contextId, event, payload) => {
    debug(`📡 Broadcasting event "${event}" to context ${contextId}`);
    let sent = 0;
    connections.forEach((conn) => {
      if (conn.socket.subscriptions?.has?.(`context:${contextId}`)) {
        try {
          debug(`  ➡️  Sending to socket ${conn.socket.id}`);
          conn.socket.emit(event, payload);
          sent++;
        } catch (error) {
          debug(`  ❌ Failed to send to socket ${conn.socket.id}:`, error.message);
        }
      }
    });
    debug(`📡 Broadcast complete: sent to ${sent} connections for context ${contextId}`);
    return sent;
  });

  fastify.decorate('getUserConnectionCount', (userId) => {
    let c = 0;
    connections.forEach((conn) => { if (conn.user.id === userId) c++; });
    debug(`👥 User ${userId} has ${c} active connections`);
    return c;
  });

  /* ---------------- Connection handler ---------------- */
  io.on('connection', (socket) => {
    const { user } = socket;
    connections.set(socket.id, { socket, user, lastActivity: Date.now() });

    debug(`🔌 New WebSocket connection: ${socket.id} for user ${user.email} (${user.id})`);
    debug(`👥 Total connections: ${connections.size}`);

    // Initialize per-socket subscription set
    if (!socket.subscriptions) {
      socket.subscriptions = new Set();
    }

    /* ----------------------------------------------------
     * Generic subscribe / unsubscribe implementation
     * -------------------------------------------------- */
    socket.on('subscribe', async (data = {}) => {
      try {
        const { channel } = data;
        if (!channel || typeof channel !== 'string') {
          socket.emit('error', { message: 'Channel name required for subscription' });
          return;
        }

        // Skip if already subscribed
        if (socket.subscriptions.has(channel)) {
          return;
        }

        // Basic ACL checks for context / workspace channels
        if (channel.startsWith('context:')) {
          const contextId = channel.split(':')[1];
          try {
            // Throws if user has no access
            await fastify.contextManager.getContext(user.id, contextId);
          } catch (err) {
            socket.emit('error', { message: `Access denied to context ${contextId}` });
            return;
          }
        } else if (channel.startsWith('workspace:')) {
          const workspaceId = channel.split(':')[1];
          try {
            const workspace = await fastify.workspaceManager.getWorkspace(user.id, workspaceId, user.id);
            if (!workspace) {
              socket.emit('error', { message: `Access denied to workspace ${workspaceId}` });
              return;
            }
          } catch (err) {
            socket.emit('error', { message: `Access denied to workspace ${workspaceId}` });
            return;
          }
        }

        socket.subscriptions.add(channel);
        socket.join(channel);
        debug(`🛎️  Socket ${socket.id} subscribed to ${channel}`);
        socket.emit('subscribed', { channel });
      } catch (err) {
        debug(`❌ Subscription error on socket ${socket.id}: ${err.message}`);
        socket.emit('error', { message: 'Subscription failed' });
      }
    });

    socket.on('unsubscribe', (data = {}) => {
      try {
        const { channel } = data;
        if (!channel || typeof channel !== 'string') {
          return;
        }
        socket.subscriptions.delete(channel);
        socket.leave(channel);
        debug(`🔕 Socket ${socket.id} unsubscribed from ${channel}`);
        socket.emit('unsubscribed', { channel });
      } catch (err) {
        debug(`❌ Unsubscribe error on socket ${socket.id}: ${err.message}`);
      }
    });

    // Register push modules
    debug(`📋 Registering context WebSocket for socket ${socket.id}`);
    registerContextWebSocket(fastify, socket);
    debug(`📋 Registering workspace WebSocket for socket ${socket.id}`);
    registerWorkspaceWebSocket(fastify, socket);
    debug(`📋 Registering agent WebSocket for socket ${socket.id}`);
    registerAgentWebSocket(fastify, socket);

    socket.emit('authenticated', { userId: user.id, email: user.email });
    debug(`✅ Sent authentication confirmation to ${socket.id}`);

    // heartbeat
    socket.on('ping', () => {
      debug(`💗 Heartbeat from ${socket.id}`);
      socket.emit('pong', { time: Date.now() });
    });

    socket.on('disconnect', () => {
      debug(`🔌 WebSocket disconnected: ${socket.id} for user ${user.email}`);
      connections.delete(socket.id);
      fastify.broadcastToUser(user.id, 'connection.change', {
        event: 'disconnect',
        count: fastify.getUserConnectionCount(user.id)
      });
    });
  });

  /* ---------------- Periodic cleanup ---------------- */
  setInterval(() => {
    const now = Date.now();
    connections.forEach((conn, id) => {
      if (now - conn.lastActivity > 30 * 60_000) {
        try { conn.socket.disconnect(true); } catch {}
        connections.delete(id);
      }
    });
    // clear old attempt logs
    connectionAttempts.forEach((val, ip) => {
      if (now - val.timestamp > 5 * 60_000) connectionAttempts.delete(ip);
    });
  }, 5 * 60_000);
}

function generateConnectionId() {
  return `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
