'use strict';

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
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
 * only, response must be a PDF, capped size, no cookies forwarded.
 */

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

function isPrivateAddress(address) {
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

async function assertPublicHttpsUrl(rawUrl) {
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
  const hostname = url.hostname;
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) { throw new Error('Address not allowed'); }
    return url;
  }
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Address not allowed');
  }
  const resolved = await lookup(hostname, { all: true }).catch(() => []);
  if (!resolved.length || resolved.some((r) => isPrivateAddress(r.address))) {
    throw new Error('Address not allowed');
  }
  return url;
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
    let url;
    try {
      url = await assertPublicHttpsUrl(request.query.url);
    } catch (error) {
      const response = new ResponseObject().badRequest(error.message);
      return reply.code(response.statusCode).send(response.getResponse());
    }

    try {
      const upstream = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/pdf,*/*' },
      });
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
