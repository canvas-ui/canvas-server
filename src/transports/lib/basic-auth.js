'use strict';

/*
 * Basic-auth parsing shared by the three transports that speak it: git HTTP,
 * WebDAV and context WebDAV. Each had its own copy, and each copy split the
 * decoded credential on ':' in a way that corrupts any password containing a
 * colon.
 */

/**
 * Decode an `Authorization: Basic …` header.
 *
 * The username is everything before the FIRST colon and the password is
 * everything after it — RFC 7617's rule, and the reason this is not a plain
 * `split(':')`: a password may contain colons, and truncating it turns a valid
 * credential into a failed login.
 *
 * @param {string} header
 * @returns {{username: string, password: string}|null}
 */
export function parseBasicAuth(header) {
    if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
    try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
        const idx = decoded.indexOf(':');
        if (idx < 0) return null;
        return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
    } catch {
        return null;
    }
}

/**
 * Does this credential look like a bearer token rather than a password?
 *
 * Both kinds the server issues qualify: an API token (`canvas-…`) and a JWT
 * from `POST /auth/login`, which is what every client stores after a normal
 * login. Checking only the `canvas-` prefix meant a perfectly valid JWT was
 * treated as a password — silently unusable for git, and one wasted throttle
 * slot for WebDAV.
 *
 * Shape only; validity is the auth strategy's job.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeToken(value) {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (value.startsWith('canvas-')) return true;
    // JWT: three base64url segments. A password could in principle look like
    // this; one that does would fail verification anyway, exactly as before.
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}
