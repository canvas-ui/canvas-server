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
