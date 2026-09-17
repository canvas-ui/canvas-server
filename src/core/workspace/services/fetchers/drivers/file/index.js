'use strict';

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import BaseFetcher from '../../BaseFetcher.js';
import { filenameFromResponse, USER_AGENT } from '../../lib.js';

/**
 * file — the URL's bytes as-is. Direct links to images, videos, PDFs, archives;
 * arXiv abs/ pages are rewritten to the paper PDF. `kind: image` and
 * `kind: arxiv` in a rule both land here.
 */

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|heic|tiff?)(?:[?#].*)?$/i;
const FILE_EXT_RE = /\.(pdf|zip|mp4|mkv|webm|mov|mp3|m4a|flac|wav|ogg)(?:[?#].*)?$/i;
const FILE_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'application/pdf', 'application/zip', 'application/octet-stream'];

export function arxivPdfUrl(url) {
    const match = String(url || '').match(/arxiv\.org\/(?:abs|pdf)\/([\w.-]+?)(?:\.pdf)?(?:[?#].*)?$/i);
    return match ? `https://arxiv.org/pdf/${match[1]}.pdf` : null;
}

class FileFetcher extends BaseFetcher {
    static kind = 'file';
    static aliases = ['image', 'arxiv'];
    static layout = 'file';

    static matches(url) {
        return Boolean(arxivPdfUrl(url)) || IMAGE_EXT_RE.test(url) || FILE_EXT_RE.test(url);
    }

    static matchesContentType(contentType) {
        return Boolean(contentType) && FILE_MIME_PREFIXES.some((p) => contentType.startsWith(p));
    }

    static resolveUrl(url) {
        return arxivPdfUrl(url) || url;
    }

    static async fetch(url, { workDir, fallbackBase, maxBytes, signal }) {
        const res = await fetch(url, { redirect: 'follow', signal, headers: { 'user-agent': USER_AGENT } });
        if (!res.ok || !res.body) { throw new Error(`HTTP ${res.status} for ${url}`); }
        const filename = filenameFromResponse(res, url, fallbackBase);
        const target = path.join(workDir, filename);
        let size = 0;
        const cap = async function* (source) {
            for await (const chunk of source) {
                size += chunk.length;
                if (size > maxBytes) { throw new Error(`download exceeds ${maxBytes} bytes`); }
                yield chunk;
            }
        };
        await pipeline(Readable.fromWeb(res.body), cap, fs.createWriteStream(target));
        return target;
    }
}

export default FileFetcher;
