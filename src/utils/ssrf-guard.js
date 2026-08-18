'use strict';

import dns from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';

// Shared SSRF guard for server-side outbound fetches (remote workspace import,
// and any future proxy). Mirrors the model proven in transports/routes/pdf-proxy.js:
// reject private/loopback/link-local destinations both up front (URL literal)
// and at connection time (inside the DNS lookup, which also covers rebinding).

export function isPrivateAddress(address) {
  if (address.includes(':')) {
    const lower = address.toLowerCase();
    return lower === '::1'
      || lower.startsWith('fe80:') // link-local
      || lower.startsWith('fc') || lower.startsWith('fd') // unique-local
      || lower.startsWith('::ffff:'); // v4-mapped — block outright
  }
  const octets = address.split('.').map(Number);
  const [a, b] = octets;
  return a === 10 || a === 127 || a === 0
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254);
}

/**
 * Validate a URL for outbound fetch. https only, no embedded credentials, no
 * private/loopback/internal hostname. Returns the parsed URL.
 * @param {string} rawUrl
 * @param {Object} [opts]
 * @param {boolean} [opts.allowHttp=false] - permit plain http (avoid on public deployments)
 */
export function assertPublicUrl(rawUrl, { allowHttp = false } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  const okProtocol = url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
  if (!okProtocol) {
    throw new Error(allowHttp ? 'Only http(s) URLs are allowed' : 'Only https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new Error('Credentials in URL are not allowed');
  }
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
// aborts the connect. Check and connection share one resolution, so a
// rebinding attacker has no gap to race, and redirect targets (same
// dispatcher) are validated too.
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
