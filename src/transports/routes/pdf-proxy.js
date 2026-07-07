'use strict';

import dns from 'node:dns';
import { isIP } from 'node:net';
import { fetch as undiciFetch, Agent } from 'undici';
import ResponseObject from '../ResponseObject.js';

/**
 * Authenticated same-origin proxy for remote PDF previews.
 *
 * The web UI previews PDF links (e.g. arxiv.org/pdf/...) inside a blob:
 * iframe, which requires reading the bytes client-side — impossible when the
 * host doesn't send CORS headers. This route fetches the PDF server-side and
 * streams it back same-origin.
 *
 * Scope is deliberately narrow (SSRF surface): https only, public addresses
 * only, response must be a PDF, capped size, no cookies forwarded. The
 * private-address check runs INSIDE the connection's DNS lookup (custom
 * undici connector), so it also covers DNS rebinding (public at pre-check,
 * private at connect) and every redirect hop — not just the initial URL.
 */

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export function isPrivateAddress(address) {
  if (address.includes(':')) {
    const lower = address.toLowerCase();
    return lower === '::1'
      || lower.startsWith('fe80:') // link-local
      || lower.startsWith('fc') || lower.startsWith('fd') // unique-local
      || lower.startsWith('::ffff:'); // v4-mapped — re-checked below via v4 rules anyway; block outright
  }
  const octets = address.split('.').map(Number);
  const [a, b] = octets;
  return a === 10 || a === 127 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

export function assertPublicHttpsUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Only https URLs can be proxied');
  }
  if (url.username || url.password) {
    throw new Error('Credentials in URL are not allowed');
  }
  // URL.hostname keeps the brackets on IPv6 literals ('[::1]') — strip them
  // or isIP() misses the literal entirely.
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && isPrivateAddress(hostname)) {
    throw new Error('Address not allowed');
  }
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Address not allowed');
  }
  return url;
}

// DNS lookup used for the ACTUAL connection: any resolved private address
// aborts the connect. Because the check and the connection share one
// resolution, a rebinding attacker has no gap to race, and redirect targets
// (same dispatcher) are validated too.
function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) { return callback(err); }
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: 4 }];
    if (!list.length || list.some((entry) => isPrivateAddress(entry.address))) {
      return callback(new Error('Address not allowed'));
    }
    if (options?.all) { return callback(null, list); }
    return callback(null, list[0].address, list[0].family);
  });
}

export const guardedDispatcher = new Agent({ connect: { lookup: guardedLookup } });

// Follow redirects manually so EVERY hop goes through assertPublicHttpsUrl —
// the lookup guard never runs for IP-literal hosts (no DNS involved), so a
// redirect to https://10.0.0.5/... would otherwise sail past it.
export async function guardedFetch(rawUrl, { maxRedirects = 5, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let url = assertPublicHttpsUrl(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await undiciFetch(url, {
      dispatcher: guardedDispatcher,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/pdf,*/*' },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) { return res; }
      await res.body?.cancel().catch(() => {});
      url = assertPublicHttpsUrl(new URL(location, url).href);
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

export default async function pdfProxyRoutes(fastify) {
  fastify.get('/pdf', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        required: ['url'],
        properties: { url: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    try {
      assertPublicHttpsUrl(request.query.url);
    } catch (error) {
      const response = new ResponseObject().badRequest(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }
    const url = request.query.url;

    try {
      const upstream = await guardedFetch(url);
      if (!upstream.ok) {
        const response = new ResponseObject().badRequest(`Upstream responded ${upstream.status}`);
        return reply.code(response.statusCode).send(response.getResponse());
      }

      const contentType = upstream.headers.get('content-type') || '';
      const buffer = Buffer.from(await upstream.arrayBuffer());
      if (buffer.length > MAX_PDF_BYTES) {
        const response = new ResponseObject().badRequest('PDF exceeds proxy size limit');
        return reply.code(response.statusCode).send(response.getResponse());
      }
      // Content check: header or magic bytes (%PDF-) — some hosts mislabel.
      const looksLikePdf = contentType.includes('application/pdf')
        || buffer.subarray(0, 5).toString('latin1') === '%PDF-';
      if (!looksLikePdf) {
        const response = new ResponseObject().badRequest('URL does not point at a PDF');
        return reply.code(response.statusCode).send(response.getResponse());
      }

      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', 'inline')
        .header('Cache-Control', 'private, max-age=3600')
        .send(buffer);
    } catch (error) {
      request.log.debug(`pdf-proxy fetch failed for ${url}: ${error.message}`);
      const response = new ResponseObject().badRequest('Failed to fetch the PDF');
      return reply.code(response.statusCode).send(response.getResponse());
    }
  });
}
