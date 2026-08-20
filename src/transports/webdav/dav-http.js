'use strict';

import { pipeline } from 'stream/promises';
import { createLogger } from '../../utils/log.js';

const logger = createLogger('webdav');

/**
 * HTTP rules shared by both DAV mounts (`/workspaces/:ws/dav` and
 * `/contexts/:ctx/dav`).
 *
 * They serve the same documents through two doors, and a client that meets
 * both has to be told the same story about them — so byte ranges, cache
 * identity and hang-ups are decided here once rather than per route.
 */

// ── Byte ranges ─────────────────────────────────────────────────────────────

/**
 * Parse a `Range` header against a known size.
 *
 * Returns null when there is no range to honour (absent header, a form we do
 * not serve), or `{ start, end }` inclusive, or `{ unsatisfiable: true }` for a
 * range that lies outside the file — which is a 416, not a silent full body.
 *
 * Only single ranges are honoured: multipart/byteranges buys nothing for the
 * clients that matter here (players seeking, editors reading a header), and
 * answering 200 with the whole body is a legal response to a multi-range
 * request.
 */
export function parseRange(header, size) {
  if (!header || size == null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start;
  let end;
  if (rawStart === '') {
    // Suffix form: the LAST n bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    end = Math.min(end, size - 1);
  }

  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end };
}

// ── Cache identity ──────────────────────────────────────────────────────────

/**
 * The cache identity of a virtual entry, as response headers.
 *
 * Empty for a collection (nothing to validate) and for an entry whose FS did
 * not supply one, so a caller can always spread it. The values come from the
 * document itself (see docEtag/docMtime) and must be identical everywhere the
 * same file is described — PROPFIND, HEAD and GET alike. A mount that answers
 * with a fresh stamp each time is telling the client the file changed under it,
 * and a caching client (davfs2, gvfs, Finder, the Windows redirector) reacts by
 * dropping the transfer it already has in flight.
 */
export function entryIdentity(entry) {
  if (!entry || entry.isDir) return {};
  return {
    // Overrides the mount-wide `no-store`: a body with a stable validator is
    // worth keeping, and revalidating it costs a 304 instead of the whole file.
    'Cache-Control': 'private, no-cache',
    ...(entry.etag ? { ETag: entry.etag } : {}),
    ...(entry.mtime ? { 'Last-Modified': new Date(entry.mtime).toUTCString() } : {}),
  };
}

// `If-None-Match: *` matches anything that exists; otherwise any tag in the
// list counts, weak comparison (a byte range is the only strong-comparison
// case, and a matching range is served, never 304'd).
export function matchesEtag(header, etagValue) {
  if (!header || !etagValue) return false;
  const raw = String(header).trim();
  if (raw === '*') return true;
  const strip = (tag) => tag.trim().replace(/^W\//, '');
  return raw.split(',').some((tag) => strip(tag) === strip(etagValue));
}

// ── Client hang-ups ─────────────────────────────────────────────────────────

/**
 * A client that has seen enough just hangs up: a viewer whose window closed, a
 * thumbnailer that got the header it wanted, a file manager moving on. The
 * socket dies under a response still being written and `pipeline` rejects with
 * ERR_STREAM_PREMATURE_CLOSE — which is the normal end of that GET, not a
 * server fault, and logging it as one buried the real failures.
 */
const CLIENT_ABORT_CODES = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'EPIPE', 'ECONNRESET']);

export const isClientAbort = (err) => CLIENT_ABORT_CODES.has(err?.code);

// Stream a body to the client, treating a hang-up as a completed request.
// `pipeline` has already destroyed the source by the time it rejects, so there
// is nothing left to release — only the noise to swallow.
export async function streamTo(res, stream) {
  try {
    await pipeline(stream, res);
  } catch (err) {
    if (!isClientAbort(err)) throw err;
    logger.debug({ code: err.code }, 'Client closed the connection mid-response');
  }
}
