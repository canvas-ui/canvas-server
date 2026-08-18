'use strict';

import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Server-side registry of connected canvas-edge instances.
 *
 * Tracks announced edges by instanceId and implements the request/response
 * side of the tunnel protocol: proxyRequest() emits an `edge:req` frame to
 * the edge's socket and assembles the `edge:res`/`edge:chunk`/`edge:end`
 * frames back into a single response. Frame routing is fed by the websocket
 * channel handler (channels/edge.js).
 */
export class EdgeRegistry {
  #edges = new Map(); // instanceId → { socket, userId, announce, connectedAt }
  #pending = new Map(); // requestId → { resolve, reject, timer, res, chunks, socketId }

  register(socket, announce = {}) {
    const instanceId = String(announce.instanceId || '').trim();
    if (!instanceId) throw new Error('edge announce requires instanceId');
    this.#edges.set(instanceId, {
      socket,
      userId: socket.user?.id,
      announce,
      connectedAt: new Date().toISOString(),
    });
    return instanceId;
  }

  get(instanceId) {
    return this.#edges.get(instanceId) || null;
  }

  list(userId) {
    const all = Array.from(this.#edges.entries()).map(([instanceId, e]) => ({
      instanceId,
      userId: e.userId,
      announce: e.announce,
      connectedAt: e.connectedAt,
    }));
    return userId ? all.filter((e) => e.userId === userId) : all;
  }

  /**
   * Find the connected edge that exports a given resource (by export id or
   * name), scoped to its owning user — a user can only reach their own edges.
   */
  findByExport(type, identifier, userId) {
    if (!identifier || !userId) return null;
    for (const [instanceId, edge] of this.#edges) {
      if (edge.userId !== userId) continue;
      const exportsList = Array.isArray(edge.announce?.exports) ? edge.announce.exports : [];
      const match = exportsList.find((entry) => entry?.type === type
        && (entry.id === identifier || entry.name === identifier));
      if (match) return { instanceId, export: match };
    }
    return null;
  }

  /**
   * Does an edge announced over THIS socket (owned by userId) export the given
   * workspace? Gates edge:event relay so a socket can only inject events for
   * workspaces its own edge actually serves — not arbitrary (or another user's)
   * workspace ids.
   */
  socketExportsWorkspace(socketId, userId, { workspaceId, workspaceName } = {}) {
    if (!socketId || !userId) { return false; }
    for (const [instanceId, edge] of this.#edges) {
      if (edge.socket.id !== socketId || edge.userId !== userId) { continue; }
      // The workspace id doubles as the tunnel instanceId for single-workspace
      // edges, so an exact instanceId match counts.
      if (instanceId === workspaceId || instanceId === workspaceName) { return true; }
      const exportsList = Array.isArray(edge.announce?.exports) ? edge.announce.exports : [];
      const hit = exportsList.some((entry) => entry?.type === 'workspace' && (
        entry.id === workspaceId || entry.name === workspaceName
        || entry.id === workspaceName || entry.name === workspaceId
      ));
      if (hit) { return true; }
    }
    return false;
  }

  /** True if this socket has announced at least one edge (i.e. it is an edge). */
  socketHasEdge(socketId) {
    for (const edge of this.#edges.values()) {
      if (edge.socket.id === socketId) { return true; }
    }
    return false;
  }

  /** Drop every edge announced over this socket, failing its in-flight requests. */
  removeBySocket(socketId) {
    const removed = [];
    for (const [instanceId, edge] of this.#edges) {
      if (edge.socket.id === socketId) {
        this.#edges.delete(instanceId);
        removed.push(instanceId);
        for (const [id, pending] of this.#pending) {
          if (pending.socketId === socketId) this.#fail(id, 'EDGE_GONE', 'edge disconnected');
        }
      }
    }
    return removed;
  }

  /**
   * Forward one HTTP request over the tunnel. Resolves with
   * `{ status, headers, body }` (body is a Buffer).
   */
  proxyRequest(instanceId, { method, path, headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    const edge = this.#edges.get(instanceId);
    if (!edge) {
      const err = new Error(`edge not connected: ${instanceId}`);
      err.code = 'EDGE_GONE';
      return Promise.reject(err);
    }

    // Unguessable request id: the id is the only key on #pending, so a
    // predictable sequential counter let any connected socket resolve another
    // socket's in-flight request with a forged edge:res/edge:end frame.
    const id = `r${crypto.randomBytes(18).toString('hex')}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(id, 'EDGE_TIMEOUT', `edge request timed out after ${timeoutMs}ms`), timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, res: null, chunks: [], socketId: edge.socket.id });
      const frame = { id, method, path, headers };
      if (body != null) {
        frame.body = Buffer.isBuffer(body) ? body.toString('base64') : Buffer.from(body).toString('base64');
        frame.bodyEncoding = 'base64';
      }
      edge.socket.emit('edge:req', frame);
    });
  }

  // Every response frame is bound to the socket that received the matching
  // edge:req. A frame arriving from any other socket is ignored, so a
  // guessed/sprayed id cannot inject a response into another socket's request.
  #ownedPending(id, socketId) {
    const pending = this.#pending.get(id);
    if (!pending || pending.socketId !== socketId) { return null; }
    return pending;
  }

  handleRes({ id, status, headers } = {}, socketId) {
    const pending = this.#ownedPending(id, socketId);
    if (pending) pending.res = { status, headers };
  }

  handleChunk({ id, data } = {}, socketId) {
    const pending = this.#ownedPending(id, socketId);
    if (pending && data) pending.chunks.push(Buffer.from(data, 'base64'));
  }

  handleEnd({ id } = {}, socketId) {
    const pending = this.#ownedPending(id, socketId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    if (!pending.res) {
      const err = new Error('edge closed stream before response head');
      err.code = 'EDGE_PROTOCOL';
      pending.reject(err);
      return;
    }
    pending.resolve({ ...pending.res, body: Buffer.concat(pending.chunks) });
  }

  handleErr({ id, code, message } = {}, socketId) {
    if (!this.#ownedPending(id, socketId)) { return; }
    this.#fail(id, code || 'EDGE_ERROR', message || 'edge request failed');
  }

  #fail(id, code, message) {
    const pending = this.#pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    const err = new Error(message);
    err.code = code;
    pending.reject(err);
  }
}

export default EdgeRegistry;
