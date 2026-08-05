import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Front-door file registration, shared by the downloader examples: after a
// script drops a file under home/, insert it as a File document RIGHT AWAY —
// checksummed, located, linked to its target path — instead of writing
// metadata sidecars and hoping the home indexer picks everything up. If the
// home watcher later ingests the same file, checksum dedup collapses the two
// into one document.

const MIME_BY_EXT = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.avif': 'image/avif',
    '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.opus': 'audio/opus', '.pdf': 'application/pdf',
};

function sha256(filePath) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(filePath)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')))
            .on('error', reject);
    });
}

/**
 * Insert a file that lives under {WORKSPACE_ROOT}/home as a File document.
 * @param {Object} ctx - hook context ({ insert, workspace, logger })
 * @param {string} filePath - absolute path, must be under home/
 * @param {Object} opts - { linkPath = '/', source? (origin URL, kept in metadata) }
 * @returns {Promise<number|null>} document id or null
 */
export async function insertHomeFile({ insert, workspace, logger }, filePath, { linkPath = '/', source } = {}) {
    const homeRoot = path.resolve(workspace.rootPath, 'home');
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(`${homeRoot}${path.sep}`)) {
        logger.debug(`insertHomeFile: refusing path outside home/: ${filePath}`);
        return null;
    }

    const stat = await fs.stat(resolved);
    const relPath = path.relative(homeRoot, resolved).split(path.sep).join('/');
    const checksum = await sha256(resolved);

    const doc = await insert({
        schema: 'data/schema/file',
        checksumArray: [`sha256/${checksum}`],
        locations: [{ url: `file://{WORKSPACE_ROOT}/home/${relPath}` }],
        metadata: {
            contentType: MIME_BY_EXT[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
            size: stat.size,
            filename: path.basename(resolved),
            ...(source ? { sourceUrl: source } : {}),
        },
        data: {},
    }, { context: linkPath });

    logger.debug(`insertHomeFile: ${relPath} -> doc ${doc?.id ?? doc} at ${linkPath}`);
    return doc?.id ?? doc ?? null;
}
