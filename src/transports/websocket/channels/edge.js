'use strict';

import { createLogger } from '../../../utils/log.js';

const logger = createLogger('canvas-server:websocket:edge');

/**
 * canvas-edge channel — the server side of the tunnel.
 *
 *  • `edge:announce`  registers the edge instance (idempotent full state).
 *  • `edge:res/chunk/end/err` are routed into the EdgeRegistry, which
 *    assembles them into responses for in-flight proxyRequest() calls.
 *  • `edge:event` relays a local workspace event up the tunnel; re-emitting
 *    it through WorkspaceManager makes the existing workspace channel fan it
 *    out to webui/PWA clients with its usual per-user ACL check — remote
 *    workspaces become indistinguishable from local ones on the event path.
 *
 * Sockets arrive here already authenticated (device or API token) by the
 * websocket auth middleware.
 */
export default function registerEdgeWebSocket(fastify, socket) {
  const edges = fastify.edges;
  if (!edges) return;

  socket.on('edge:announce', (announce = {}) => {
    try {
      const instanceId = edges.register(socket, announce);
      logger.info(`Edge announced: ${instanceId} (${announce.runtime || 'unknown'}) for user ${socket.user.id}`);
      socket.emit('edge:announced', { instanceId });
    } catch (err) {
      socket.emit('edge:err', { code: 'EDGE_ANNOUNCE_FAILED', message: err.message });
    }
  });

  socket.on('edge:res', (frame) => edges.handleRes(frame));
  socket.on('edge:chunk', (frame) => edges.handleChunk(frame));
  socket.on('edge:end', (frame) => edges.handleEnd(frame));
  socket.on('edge:err', (frame) => edges.handleErr(frame));

  socket.on('edge:event', ({ name, payload } = {}) => {
    // Only workspace-namespace events may be relayed; fan-out access control
    // stays with the workspace channel's per-socket ACL check.
    if (typeof name !== 'string' || !name.startsWith('workspace')) return;
    try {
      fastify.workspaceManager?.emit(name, payload);
    } catch (err) {
      logger.debug(`Failed to relay edge event ${name}: ${err.message}`);
    }
  });

  socket.on('disconnect', () => {
    const removed = edges.removeBySocket(socket.id);
    if (removed.length) logger.info(`Edge disconnected: ${removed.join(', ')}`);
  });
}
