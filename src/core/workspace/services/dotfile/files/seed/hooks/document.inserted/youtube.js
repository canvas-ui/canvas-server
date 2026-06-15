import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Example: when a YouTube link is indexed, download it with yt-dlp into
// home/Videos. The script writes a hidden `.<file>.metadata.json` sidecar
// listing the virtual paths the resulting file should be linked to; once the
// download lands in .incoming, incoming-metadata-linker.js does the linking.
const YOUTUBE_RE = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/i;

export default async function run({ payload, workspace, logger }) {
    const doc = payload?.document;
    if (!doc || doc.schema !== 'data/abstraction/tab') { return; }

    const url = doc.data?.url;
    if (!url || !YOUTUBE_RE.test(url)) { return; }

    const script = path.join(workspace.rootPath, 'git', 'scripts', 'ytdl.sh');
    if (!existsSync(script)) {
        logger.debug('youtube hook: git/scripts/ytdl.sh missing, skipping');
        return;
    }

    const targetDir = path.join(workspace.rootPath, 'home', 'Videos');
    const linkPath = payload?.context?.path || '/';

    // Fire-and-forget: the download can take a while and the inserted file is
    // picked up by its own document.inserted event.
    const child = spawn('bash', [script, url, targetDir, linkPath], {
        stdio: 'ignore',
        detached: true,
    });
    child.on('error', (err) => logger.debug(`youtube hook: spawn failed: ${err.message}`));
    child.unref();

    logger.debug(`youtube hook: downloading ${url} -> ${targetDir} (link: ${linkPath})`);
}
