'use strict';

import { io } from 'socket.io-client';

const CHUNK_SIZE = 256 * 1024;

/**
 * canvas-edge tunnel client.
 *
 * Dials out to a canvas-server instance, announces what this runtime hosts,
 * and replays proxied requests into the local fastify app (`app.inject()`),
 * so the tunnel and localhost serve identical APIs by construction.
 * Reconnection/backoff and heartbeat come from socket.io.
 *
 * See docs/canvas-edge-protocol.md for the frame protocol.
 */
export default class EdgeClient {
  #serverUrl;
  #token;
  #localApp;
  #announce;
  #socket = null;
  #announced = false;
  #forwarded = [];

  constructor({ serverUrl, token, localApp, announce }) {
    if (!serverUrl || !token || !localApp?.inject || !announce?.instanceId) {
      throw new Error('EdgeClient requires serverUrl, token, localApp (fastify) and announce.instanceId');
    }
    this.#serverUrl = serverUrl.replace(/\/+$/, '');
    this.#token = token;
    this.#localApp = localApp;
    this.#announce = announce;
  }

  /**
   * One-time pairing: exchange a user API token for a device token via the
   * existing device registration endpoint. Persist the result locally and
   * never touch the user token again.
   */
  static async pair({ serverUrl, userToken, name, type = 'edge', ...deviceInfo }) {
    const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/rest/v2/auth/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ name, type, ...deviceInfo }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.payload?.token) {
      throw new Error(`Edge pairing failed: ${json?.message || res.statusText}`);
    }
    return { token: json.payload.token, deviceId: json.payload.deviceId || json.payload.id };
  }

  get connected() {
    return this.#socket?.connected === true;
  }

  connect() {
    if (this.#socket) return this;
    this.#socket = io(this.#serverUrl, {
      auth: { token: this.#token },
      transports: ['websocket'],
    });
    // Announce on every (re)connect — announce is idempotent full state.
    this.#socket.on('connect', () => this.#socket.emit('edge:announce', this.#announce));
    this.#socket.on('edge:announced', () => { this.#announced = true; });
    this.#socket.on('disconnect', () => { this.#announced = false; });
    this.#socket.on('edge:req', (frame) => this.handleRequest(frame));
    return this;
  }

  /** Resolves once the server has acked the announce; rejects on timeout. */
  waitForAnnounce(timeoutMs = 10_000) {
    if (this.#announced) return Promise.resolve();
    if (!this.#socket) return Promise.reject(new Error('not connected — call connect() first'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#socket?.off('edge:announced', onAck);
        reject(new Error(`edge announce not acked within ${timeoutMs}ms`));
      }, timeoutMs);
      const onAck = () => { clearTimeout(timer); resolve(); };
      this.#socket.once('edge:announced', onAck);
    });
  }

  /**
   * Dispatch a proxied request into the local app and stream the answer back.
   * `socket` is injectable for tests.
   */
  async handleRequest(frame = {}, socket = this.#socket) {
    const { id, method, path, headers = {}, body, bodyEncoding } = frame;
    if (!id || !method || !path) return;
    try {
      const payload = body == null
        ? undefined
        : (bodyEncoding === 'base64' ? Buffer.from(body, 'base64') : body);
      const res = await this.#localApp.inject({ method, url: path, headers, payload });
      socket.emit('edge:res', { id, status: res.statusCode, headers: res.headers });
      const buf = res.rawPayload;
      for (let offset = 0, seq = 0; offset < buf.length; offset += CHUNK_SIZE, seq++) {
        socket.emit('edge:chunk', { id, seq, data: buf.subarray(offset, offset + CHUNK_SIZE).toString('base64') });
      }
      socket.emit('edge:end', { id });
    } catch (err) {
      socket.emit('edge:err', { id, code: 'EDGE_DISPATCH_FAILED', message: err.message });
    }
  }

  /**
   * Relay all events from a local wildcard emitter (EventEmitter2) up the
   * tunnel; the server re-emits them through its WorkspaceManager.
   */
  forwardEvents(emitter) {
    const socket = () => this.#socket;
    const listener = function (payload) {
      socket()?.emit('edge:event', { name: this.event, payload });
    };
    emitter.on('**', listener);
    this.#forwarded.push([emitter, listener]);
    return this;
  }

  close() {
    for (const [emitter, listener] of this.#forwarded) emitter.off('**', listener);
    this.#forwarded = [];
    this.#socket?.disconnect();
    this.#socket = null;
  }
}
