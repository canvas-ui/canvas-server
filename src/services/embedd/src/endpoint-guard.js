'use strict';

import dns from 'dns/promises';
import net from 'net';

/**
 * Endpoint guard for user-supplied provider URLs.
 *
 * Any non-admin can type a `baseUrl` that the SERVER then fetches, which is a
 * server-side request forgery primitive: without a check, a user can aim a
 * provider at cloud metadata or an internal service and read the outcome back
 * through the settings UI. Two defences, because neither alone is enough:
 *
 *  1. This guard — refuses link-local / cloud-metadata targets outright. Private
 *     and loopback ranges stay ALLOWED by design: `127.0.0.1:11434` is the
 *     Ollama default and `10.x`/`192.168.x` is where a home GPU box lives.
 *     Blocking them would break the feature's main use case. An admin who wants
 *     a tighter policy sets an explicit host allowlist.
 *  2. Response-body redaction at the route layer — because loopback and private
 *     ranges ARE reachable, the remaining leak is what a failed request reveals.
 *     Provider error bodies are logged server-side and never returned to a
 *     non-admin; they get a bare status instead.
 *
 * DNS is resolved before the verdict so `evil.example.com -> 169.254.169.254`
 * is caught. This is a best-effort check, not a rebinding-proof one: the address
 * can change between this lookup and the request. It raises the cost enough to
 * matter without pretending to be airtight.
 */

// Ranges with no legitimate embedding endpoint, and a well-known credential
// endpoint on every major cloud.
const BLOCKED_V4 = [
    { cidr: '169.254.0.0/16', why: 'link-local / cloud instance metadata' },
    { cidr: '0.0.0.0/8', why: 'unspecified' },
];
const BLOCKED_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog']);

function v4ToInt(ip) {
    return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inCidr(ip, cidr) {
    const [range, bitsRaw] = cidr.split('/');
    const bits = Number(bitsRaw);
    if (bits === 0) { return true; }
    const mask = (~0 << (32 - bits)) >>> 0;
    return (v4ToInt(ip) & mask) === (v4ToInt(range) & mask);
}

function blockedAddress(ip) {
    if (net.isIPv4(ip)) {
        for (const { cidr, why } of BLOCKED_V4) {
            if (inCidr(ip, cidr)) { return why; }
        }
        return null;
    }
    const lower = String(ip).toLowerCase();
    // IPv6 link-local (fe80::/10) and the IPv6 metadata address.
    if (/^fe[89ab]/.test(lower)) { return 'link-local'; }
    if (lower === 'fd00:ec2::254') { return 'cloud instance metadata'; }
    return null;
}

/**
 * @param {string} rawUrl
 * @param {{allowHosts?: string[]}} [policy] optional admin allowlist. When set,
 *   the URL's hostname must match one of the entries exactly (or by `*.suffix`).
 * @returns {Promise<{ok: true, url: URL} | {ok: false, reason: string}>}
 */
export async function checkEndpoint(rawUrl, policy = {}) {
    let url;
    try { url = new URL(String(rawUrl)); }
    catch { return { ok: false, reason: 'not a valid URL' }; }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, reason: `unsupported scheme '${url.protocol.replace(':', '')}' (use http or https)` };
    }

    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (BLOCKED_HOSTNAMES.has(host)) {
        return { ok: false, reason: 'cloud instance metadata endpoint' };
    }

    const allow = Array.isArray(policy.allowHosts) ? policy.allowHosts.filter(Boolean) : [];
    if (allow.length > 0) {
        const permitted = allow.some((entry) => {
            const e = String(entry).toLowerCase();
            return e.startsWith('*.') ? host.endsWith(e.slice(1)) : host === e;
        });
        if (!permitted) {
            return { ok: false, reason: `host '${host}' is not in the server's allowed embedding hosts` };
        }
    }

    // Literal address, or resolve the name — a hostname pointing at metadata
    // must be caught too.
    let addresses = [];
    if (net.isIP(host)) {
        addresses = [host];
    } else {
        try {
            addresses = (await dns.lookup(host, { all: true })).map((a) => a.address);
        } catch (e) {
            return { ok: false, reason: `could not resolve host '${host}': ${e.code || e.message}` };
        }
    }

    for (const address of addresses) {
        const why = blockedAddress(address);
        if (why) { return { ok: false, reason: `'${host}' resolves to ${address} (${why})` }; }
    }

    return { ok: true, url };
}

/**
 * Check every openai-type provider in a config. Local provider types (onnx,
 * clip) have no URL; ollama's host is checked the same way.
 */
export async function checkConfigEndpoints(config, policy = {}) {
    const problems = [];
    for (const [id, spec] of Object.entries(config?.providers || {})) {
        const target = spec?.baseUrl || spec?.host;
        if (!target) { continue; }
        const verdict = await checkEndpoint(target, policy);
        if (!verdict.ok) { problems.push(`provider '${id}': ${verdict.reason}`); }
    }
    return problems;
}

export default { checkEndpoint, checkConfigEndpoints };
