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
      // Share-token sockets may only announce as the workspace their token
      // is bound to (workspace id doubles as tunnel instanceId).
      const binding = socket.workspaceBinding;
      if (binding && announce?.instanceId !== binding.workspaceId) {
        socket.emit('edge:err', {
          code: 'EDGE_ANNOUNCE_FAILED',
          message: 'Workspace token is not bound to this instance',
        });
        return;
      }
      const instanceId = edges.register(socket, announce);
      logger.info(`Edge announced: ${instanceId} (${announce.runtime || 'unknown'}) for user ${socket.user.id}`);
      socket.emit('edge:announced', { instanceId });
    } catch (err) {
      socket.emit('edge:err', { code: 'EDGE_ANNOUNCE_FAILED', message: err.message });
    }
  });

  // Response frames are bound to this socket in the registry — a frame for a
  // request that was issued to a different socket is dropped.
  socket.on('edge:res', (frame) => edges.handleRes(frame, socket.id));
  socket.on('edge:chunk', (frame) => edges.handleChunk(frame, socket.id));
  socket.on('edge:end', (frame) => edges.handleEnd(frame, socket.id));
  socket.on('edge:err', (frame) => edges.handleErr(frame, socket.id));

  socket.on('edge:event', ({ name, payload } = {}) => {
    // Only workspace-namespace events may be relayed; fan-out access control
    // stays with the workspace channel's per-socket ACL check.
    if (typeof name !== 'string' || !name.startsWith('workspace')) return;

    // Relaying is an edge-device privilege, not something any authenticated
    // client can do: without this gate a normal web/PWA socket could emit
    // arbitrary workspace events into every other user's client. Share-token
    // sockets are edges too (they announce their bound workspace).
    const binding = socket.workspaceBinding;
    if (!binding && !edges.socketHasEdge(socket.id)) return;

    // The event must carry a workspace tag. Untagged events are fanned out to
    // every connected socket with no ACL check (channels/workspace.js), so an
    // untagged relay is a broadcast primitive — drop it here.
    const workspaceId = payload?.workspaceId;
    const workspaceName = payload?.workspaceName;
    if (!workspaceId && !workspaceName) return;

    if (binding) {
      // Share-token sockets may only relay events for their bound workspace.
      if (workspaceId !== binding.workspaceId && workspaceName !== binding.workspaceName) return;
    } else if (!edges.socketExportsWorkspace(socket.id, socket.user?.id, { workspaceId, workspaceName })) {
      // A device may only relay events for workspaces its own edge exports —
      // it cannot forge events tagged with another user's workspace id.
      return;
    }

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
