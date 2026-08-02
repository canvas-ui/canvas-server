'use strict';

import ResponseObject from '../ResponseObject.js';
import { createLogger } from '../../utils/log.js';

const logger = createLogger('canvas-server:edge-proxy');

// Hop-by-hop / recomputed headers that must not cross the tunnel.
const STRIP_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding']);
const STRIP_RESPONSE_HEADERS = new Set(['connection', 'content-length', 'transfer-encoding']);

const ERROR_STATUS = {
  EDGE_GONE: 503,
  EDGE_TIMEOUT: 504,
};

function filterHeaders(headers, strip) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!strip.has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

/**
 * preHandler for the workspaces route scope (server policy, injected at
 * mount): when `:id` resolves to a workspace exported by one of the user's
 * connected edges, forward the request over the tunnel and short-circuit the
 * local handlers. Local workspaces fall through untouched.
 *
 * Runs after route-level auth (request.user is set) and after body parsing —
 * parsed JSON bodies are re-serialized; raw streaming uploads over the
 * tunnel are a later refinement.
 */
export async function proxyRemoteWorkspaces(request, reply) {
  const edges = request.server.edges;
  const identifier = request.params?.id;
  if (!edges || !identifier || !request.user?.id) return;

  const remote = edges.findByExport('workspace', identifier, request.user.id);
  if (!remote) return;

  let body;
  if (request.body != null) {
    body = Buffer.isBuffer(request.body) || typeof request.body === 'string'
      ? Buffer.from(request.body)
      : Buffer.from(JSON.stringify(request.body));
  }

  try {
    const res = await edges.proxyRequest(remote.instanceId, {
      method: request.method,
      path: request.raw.url,
      headers: filterHeaders(request.headers, STRIP_REQUEST_HEADERS),
      body,
    });
    reply.code(res.status).headers(filterHeaders(res.headers, STRIP_RESPONSE_HEADERS));
    return reply.send(res.body);
  } catch (err) {
    const statusCode = ERROR_STATUS[err.code] || 502;
    logger.debug(`Edge proxy failed for workspace ${identifier} (${remote.instanceId}): ${err.message}`);
    const response = new ResponseObject().error(
      `Remote workspace unreachable: ${err.message}`, null, statusCode);
    return reply.code(statusCode).send(response.getResponse());
  }
}
