'use strict';

/**
 * Parse an HTTP `Range: bytes=…` header against a known total size.
 *
 * Returns `{ start, end }` with an INCLUSIVE `end` (matches HTTP and
 * fs.createReadStream), the string `'unsatisfiable'` (caller should reply 416
 * with `Content-Range: bytes *\/total`), or `null` when there is no usable
 * single-range request (no header, unknown size, multi-range, malformed).
 *
 * @param {string|undefined} rangeHeader
 * @param {number} total  Total byte length of the resource.
 */
export function parseByteRange(rangeHeader, total) {
  if (!rangeHeader || !Number.isFinite(total)) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;
  let start, end;
  if (!hasStart) {
    const n = parseInt(m[2], 10); // suffix: last N bytes
    if (!n) return 'unsatisfiable';
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = hasEnd ? parseInt(m[2], 10) : total - 1;
    if (end >= total) end = total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= total) {
    return 'unsatisfiable';
  }
  return { start, end };
}
