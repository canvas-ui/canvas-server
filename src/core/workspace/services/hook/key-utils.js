'use strict';

/**
 * Storage-key helpers shared by the store and download rule actions.
 */

// One path segment, safe for any filesystem backend: no separators, control
// characters or reserved punctuation; never `.`/`..`; bounded length.
export function sanitizeSegment(value, fallback = '') {
    const cleaned = String(value ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/^[\s.-]+|[\s.-]+$/g, '')
        .slice(0, 120)
        .trim();
    return cleaned || fallback;
}

/**
 * Join key parts into one backend-relative key. Each part may itself contain
 * slashes (`Projects/Canvas/UI`, `{{match.rel}}` expansions); empty parts,
 * `.` and `..` segments and repeated/leading slashes are dropped so a rule can
 * never escape the backend root or produce `Fotky///x`.
 */
export function joinKey(...parts) {
    const segments = [];
    for (const part of parts) {
        if (part == null || part === '') { continue; }
        for (const seg of String(part).split(/[\\/]+/)) {
            if (!seg || seg === '.' || seg === '..') { continue; }
            segments.push(seg);
        }
    }
    return segments.join('/');
}

// Extension for a mime type when the source key has none — uploads land in the
// blob store under a content-hash key, so `image/jpeg` is often all we have.
export const MIME_EXTENSIONS = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/heic': '.heic', 'image/heif': '.heif', 'image/avif': '.avif', 'image/tiff': '.tiff',
    'image/svg+xml': '.svg', 'image/bmp': '.bmp',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/flac': '.flac', 'audio/ogg': '.ogg', 'audio/wav': '.wav',
    'application/pdf': '.pdf', 'text/plain': '.txt', 'text/markdown': '.md', 'text/html': '.html',
    'application/json': '.json', 'application/zip': '.zip',
};

const EXTENSION_MIMES = Object.fromEntries(Object.entries(MIME_EXTENSIONS).map(([mime, ext]) => [ext, mime]));
EXTENSION_MIMES['.jpeg'] = 'image/jpeg';
EXTENSION_MIMES['.htm'] = 'text/html';
EXTENSION_MIMES['.m4v'] = 'video/mp4';

/** Best-effort mime type for a file name, `application/octet-stream` when unknown. */
export function mimeForFilename(filename) {
    const match = String(filename || '').toLowerCase().match(/\.[a-z0-9]+$/);
    return (match && EXTENSION_MIMES[match[0]]) || 'application/octet-stream';
}

// Blob-store keys are content-derived (`ab/cd/<hash>`, see stored's
// generateKey) — never a name a person chose, so never a filename to keep.
const CONTENT_HASH_KEY = /^(?:[0-9a-f]{2}\/){2}[0-9a-f]{32,}$/i;
const BARE_HASH = /^[0-9a-f]{32,}$/i;

export function isContentHashKey(key) {
    const str = String(key || '');
    return CONTENT_HASH_KEY.test(str) || BARE_HASH.test(str.split('/').pop() || '');
}

/**
 * The name a document's bytes should land under when transferred to a
 * path-keyed backend (a directory share, a drive) and the caller did not pick
 * one. Uploads live in the blob store under a hash key, so the original name
 * has to come from the record: the document's own filename, then the
 * filename recorded on the source (or any) location, then the source key when
 * it is a real name, then the title. An extension is derived from the mime
 * type when the name has none — a hash-keyed `image/jpeg` would otherwise
 * arrive as an extensionless file nothing opens.
 */
export function transferFilename(doc, { sourceKey = '', sourceUrl = '' } = {}) {
    const locations = (doc?.locations || []).filter(Boolean);
    const candidates = [
        doc?.metadata?.filename,
        doc?.data?.filename,
        locations.find((l) => l.url === sourceUrl)?.metadata?.filename,
        ...[...locations].sort((a, b) => String(a.url || '').localeCompare(String(b.url || ''))).map((l) => l?.metadata?.filename),
        !isContentHashKey(sourceKey) ? String(sourceKey).split('/').pop() : '',
        doc?.data?.title ?? doc?.metadata?.title ?? doc?.data?.name ?? doc?.data?.subject,
    ];
    let name = '';
    for (const candidate of candidates) {
        const cleaned = sanitizeSegment(candidate);
        if (cleaned) { name = cleaned; break; }
    }
    if (!name) { name = `${String(doc?.schema || 'doc').split('/').pop()}_${doc?.id ?? 'object'}`; }
    if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
        name += MIME_EXTENSIONS[String(doc?.metadata?.contentType || '').toLowerCase().split(';')[0]] || '';
    }
    return name;
}
