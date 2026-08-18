'use strict';

// Failure-only throttle for HTTP Basic password auth (WebDAV). The global
// @fastify/rate-limit is deliberately kept OFF DAV routes (bulk transfers), so
// this narrow bucket guards just the password-verify path: it counts FAILURES
// per client+account and a success clears them, leaving authenticated
// throughput untouched. Without it, Basic auth is an unthrottled password
// oracle that bypasses the /rest/v2/auth/login limiter.

const PW_FAIL_WINDOW_MS = 15 * 60 * 1000;
const PW_FAIL_MAX = 5;
const buckets = new Map(); // `${ip}:${email}` → { count, resetAt }

export function throttleKey(request, username) {
  return `${request.ip}:${String(username || '').toLowerCase()}`;
}

export function isThrottled(key) {
  const bucket = buckets.get(key);
  if (!bucket) { return false; }
  if (Date.now() > bucket.resetAt) { buckets.delete(key); return false; }
  return bucket.count >= PW_FAIL_MAX;
}

export function recordFailure(key) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + PW_FAIL_WINDOW_MS });
    return;
  }
  bucket.count += 1;
}

export function clearFailures(key) {
  buckets.delete(key);
}
