'use strict';

import path from 'node:path';
import { Readable } from 'node:stream';
import cacache from 'cacache';
import { fetch } from 'undici';
import ResponseObject from '../ResponseObject.js';
import { createLogger } from '../../utils/log.js';

const logger = createLogger('canvas-server:remote-proxy');

// Hop-by-hop headers, plus everything that would leak THIS server's session
// (cookies, authorization) or that the remote recomputes.
const STRIP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'expect', 'authorization', 'cookie', 'accept-encoding', 'if-none-match',
]);
const STRIP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'x-source-code', 'strict-transport-security',
]);

// The media-ticket cookie minted by /documents/:docId/content-ticket — the
// one cookie that must cross to the remote (it is the remote's own ticket).
const MEDIA_COOKIE = 'cvs_media';

// Content-addressed bytes worth caching: whole-document content (no Range,
// no ?url= attachment pick) and thumbnails. Both routes answer with an ETag
// derived from the document checksum and honour If-None-Match.
const CONTENT_SUFFIX = /^\/documents\/\d+\/content$/;
const THUMBNAIL_SUFFIX = /^\/documents\/\d+\/thumbnail$/;

const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function readCookie(request, name) {
  const raw = request.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function filterHeaders(headers, strip) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null) continue;
    if (!strip.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

/**
 * Split `/rest/v2/workspaces/<id>[/suffix][?query]` into the part after the
 * id segment and the query string. The id segment is taken verbatim from the
 * raw URL so it can be swapped for the remote's id without re-encoding.
 */
function splitWorkspaceUrl(rawUrl) {
  const qIndex = rawUrl.indexOf('?');
  const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
  const query = qIndex === -1 ? '' : rawUrl.slice(qIndex);
  const segments = pathname.split('/'); // ['', 'rest', 'v2', 'workspaces', '<id>', ...]
  if (segments.length < 5 || segments[3] !== 'workspaces') return null;
  const idSegment = segments[4];
  const suffix = segments.length > 5 ? `/${segments.slice(5).join('/')}` : '';
  return { prefix: segments.slice(0, 4).join('/'), idSegment, suffix, query };
}

/**
 * Pull-through cache for content-addressed bytes served by remote workspaces.
 * One cacache store for ALL remotes: cacache keys entries by our lookup key
 * but stores content by its own integrity hash, so identical bytes reached
 * through two hosts (or two workspaces) occupy the disk once.
 */
export class RemoteBlobCache {
  #root;

  constructor(root) {
    if (!root) throw new Error('RemoteBlobCache root required');
    this.#root = root;
  }

  get root() { return this.#root; }

  static key(ws, suffix, query) {
    return `remote-workspace|${ws.remote.url}|${ws.remote.workspaceId}|${suffix}${query}`;
  }

  info(key) {
    return cacache.get.info(this.#root, key).catch(() => null);
  }

  stream(key) {
    return cacache.get.stream(this.#root, key, { memoize: false });
  }

  putStream(key, metadata) {
    return cacache.put.stream(this.#root, key, { metadata, memoize: false });
  }

  remove(key) {
    return cacache.rm.entry(this.#root, key, { removeFully: true }).catch(() => null);
  }

  async stats() {
    let entries = 0;
    let size = 0;
    try {
      for await (const entry of cacache.ls.stream(this.#root)) {
        entries += 1;
        size += entry.size || 0;
      }
    } catch { /* no store yet */ }
    return { root: this.#root, entries, size };
  }
}

export function defaultRemoteCacheRoot(serverHome) {
  return path.join(serverHome, 'cache', 'remote-workspaces');
}

/**
 * Scope-level onRequest hook for the workspaces API (mounted in
 * transports/index.js): when `:id` names a remote workspace reference owned
 * by the caller, stream the request to the remote server — same path with the
 * remote's workspace id, authenticated with the stored share token — and
 * answer with whatever the remote answered. Local workspaces fall through
 * untouched, at the cost of one map lookup.
 *
 * It runs at onRequest (before route-level auth/ACL and before body parsing)
 * on purpose: the route ACL cannot validate a remote workspace, and the raw
 * request body is still unread so uploads stream through without buffering.
 *
 * Not forwarded: `DELETE /:id` (removes the local reference — the workspace
 * on the remote is never deleted from here) and `PATCH /:id` (label, color,
 * order … are this user's view of the reference and live in the local index).
 */
export function createRemoteWorkspaceForwarder(fastify, { cache } = {}) {
  return async function forwardRemoteWorkspaces(request, reply) {
    const identifier = request.params?.id;
    if (!identifier) return;

    const manager = fastify.workspaceManager;
    const entry = manager?.peekRemoteWorkspaceEntry?.(identifier);
    if (!entry) return;

    const parts = splitWorkspaceUrl(request.raw.url || request.url);
    if (!parts) return;
    const { idSegment, suffix, query } = parts;

    if (suffix === '' && (request.method === 'DELETE' || request.method === 'PATCH')) return; // local reference only

    // Media-ticket requests (<video src=…> cannot send Authorization) carry the
    // REMOTE's ticket cookie: it was minted through this very forwarder and only
    // the remote can verify it, so pass them through unauthenticated — the
    // remote still rejects anything but a valid ticket for that workspace.
    const mediaTicket = request.method === 'GET' && CONTENT_SUFFIX.test(suffix) && !request.headers.authorization
      ? readCookie(request, MEDIA_COOKIE)
      : null;

    if (!mediaTicket) {
      try {
        await fastify.authenticate(request, reply);
      } catch (err) {
        const response = new ResponseObject().unauthorized(err.message || 'Authentication required');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      if (reply.sent) return reply;
      // A reference is personal — only its owner may use it. Anyone else falls
      // through to the local routes, which answer 403/404 as for any workspace.
      if (request.user?.id !== entry.owner) return;
      // Principals scoped to one LOCAL workspace (share/agent tokens bound to
      // something else) must not reach through a remote reference.
      const binding = request.resourceToken;
      if (binding?.type === 'workspace') return;
      if (binding?.type === 'agent' && binding.workspaceId !== '*' && binding.workspaceId !== entry.id) return;
    }

    let ws;
    try {
      ws = await manager.getWorkspaceOrThrow(entry.id, entry.owner);
    } catch (err) {
      const statusCode = err.statusCode || 503;
      const response = new ResponseObject().error(err.message, null, statusCode);
      return reply.code(statusCode).send(response.getResponse());
    }
    if (!ws?.isRemote) return;

    return forward({ ws, request, reply, idSegment, suffix, query, cache, mediaTicket });
  };
}

async function forward({ ws, request, reply, idSegment, suffix, query, cache, mediaTicket }) {
  const method = request.method;
  const headers = filterHeaders(request.headers, STRIP_REQUEST_HEADERS);
  headers.authorization = `Bearer ${ws.token}`;
  // identity: what the remote sends is what we relay (content-length stays
  // truthful and cacheable bytes are the real bytes).
  headers['accept-encoding'] = 'identity';
  if (mediaTicket) headers.cookie = `${MEDIA_COOKIE}=${mediaTicket}`;

  const cacheable = !!cache && method === 'GET' && !request.headers.range
    && ((CONTENT_SUFFIX.test(suffix) && !/[?&]url=/.test(query)) || THUMBNAIL_SUFFIX.test(suffix));
  const cacheKey = cacheable ? RemoteBlobCache.key(ws, suffix, query) : null;
  const cached = cacheable ? await cache.info(cacheKey) : null;
  const clientEtag = request.headers['if-none-match'] || null;
  if (cached?.metadata?.etag) headers['if-none-match'] = cached.metadata.etag;
  else if (clientEtag) headers['if-none-match'] = clientEtag;

  const hasBody = !BODYLESS_METHODS.has(method);
  let res;
  try {
    res = await fetch(ws.remoteUrl(`${suffix}${query}`), {
      method,
      headers,
      body: hasBody ? request.raw : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
      dispatcher: ws.dispatcher,
    });
  } catch (err) {
    const reason = err.cause?.message || err.message;
    ws.markOffline(reason);
    logger.debug(`Remote workspace ${ws.name} unreachable (${method} ${suffix || '/'}): ${reason}`);
    if (cached) return serveCached(reply, cache, cacheKey, cached, 'stale');
    const response = new ResponseObject().error(`Remote workspace unreachable: ${reason}`, null, 502);
    return reply.code(502).send(response.getResponse());
  }
  ws.markOnline();

  // Revalidated: our copy is current. Hand the browser its own 304 only when
  // IT presented the same tag; otherwise serve the bytes.
  if (cached && res.status === 304) {
    if (clientEtag && clientEtag === cached.metadata.etag) {
      reply.header('ETag', cached.metadata.etag);
      return reply.code(304).send();
    }
    return serveCached(reply, cache, cacheKey, cached, 'hit');
  }

  const responseHeaders = filterHeaders(Object.fromEntries(res.headers.entries()), STRIP_RESPONSE_HEADERS);
  // Cookies scoped by the remote to ITS workspace path must land on ours.
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (setCookies.length) {
    responseHeaders['set-cookie'] = setCookies.map((cookie) =>
      cookie.replace(/(Path=\/rest\/v2\/workspaces\/)[^/;]+/i, `$1${idSegment}`));
  }
  // The workspace record itself: clients derive further calls from the
  // `workspace.name` they get back (timelines, pins, tree panes …), so the
  // remote's bare name must come back as this server's `name@host` address —
  // the same identity the listing hands out.
  if (suffix === '' && method === 'GET' && res.ok && /json/i.test(res.headers.get('content-type') || '')) {
    const text = await res.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* relay untouched below */ }
    if (payload?.payload?.workspace) {
      const record = payload.payload.workspace;
      ws.observe(record);
      payload.payload.workspace = { ...record, ...ws.localIdentity(), remoteName: record.name };
      payload.payload.resourceAddress = ws.name;
      delete responseHeaders['content-length'];
      return reply.code(res.status).headers(responseHeaders).send(payload);
    }
    return reply.code(res.status).headers(responseHeaders).send(text);
  }

  reply.code(res.status).headers(responseHeaders);
  if (!res.body) return reply.send();

  // Small non-cacheable payloads (JSON answers — the bulk of forwarded
  // traffic) are buffered: the web-stream → node-stream bridge adds
  // milliseconds of scheduling latency that a Buffer send does not.
  const contentLength = Number(res.headers.get('content-length') ?? NaN);
  if (!cacheable && Number.isFinite(contentLength) && contentLength <= 262_144) {
    return reply.send(Buffer.from(await res.arrayBuffer()));
  }

  const body = Readable.fromWeb(res.body);
  const etag = res.headers.get('etag');
  if (cacheable && res.status === 200 && etag) {
    teeIntoCache(body, cache, cacheKey, {
      etag,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      size: res.headers.has('content-length') ? Number(res.headers.get('content-length')) : null,
      cachedAt: new Date().toISOString(),
    });
  }
  return reply.send(body);
}

function serveCached(reply, cache, key, info, state) {
  const { etag, contentType } = info.metadata || {};
  reply.header('Content-Type', contentType || 'application/octet-stream');
  reply.header('Content-Length', info.size);
  reply.header('Cache-Control', 'private, no-cache');
  reply.header('X-Canvas-Remote-Cache', state);
  if (etag) reply.header('ETag', etag);
  return reply.code(200).send(cache.stream(key));
}

/**
 * Write the bytes flowing to the client into the cache as they pass. A client
 * that disconnects mid-stream must not leave a truncated entry behind, so the
 * decision is made on bytes, not on event order (Readable.fromWeb can close
 * before 'end' is observed): a stream that closed with every announced byte
 * written is finished into the store, anything short is torn down, and an
 * entry whose size disagrees with the remote's Content-Length is dropped.
 */
function teeIntoCache(body, cache, key, metadata) {
  let written = 0;
  let settled = false;
  let writer;
  try {
    writer = cache.putStream(key, metadata);
  } catch (err) {
    logger.debug(`Remote cache write refused for ${key}: ${err.message}`);
    return;
  }
  const complete = () => metadata.size != null && written === metadata.size;
  const finish = () => {
    if (settled) return;
    settled = true;
    if (complete()) { try { writer.end(); } catch { /* already ended */ } }
    else { try { writer.destroy(new Error(`incomplete (${written}/${metadata.size ?? '?'} bytes)`)); } catch { /* already gone */ } }
  };
  writer.on('error', (err) => logger.debug(`Remote cache write failed for ${key}: ${err.message}`));
  body.on('data', (chunk) => {
    written += chunk.length;
    if (!settled) writer.write(chunk);
  });
  body.on('end', finish);
  body.on('close', finish);
  body.on('error', finish);
  writer.promise()
    .then(async () => { if (!complete()) await cache.remove(key); })
    .catch(() => cache.remove(key));
}
