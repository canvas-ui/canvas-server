import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Example (disabled): when a YouTube link is indexed, download it with yt-dlp
// into home/Videos. Enable by renaming to `youtube-downloader.js` (strip the
// `example-` prefix, or toggle in the webui) — and enable
// `incoming-metadata-linker.js` too: the script writes a hidden
// `.<file>.metadata.json` sidecar listing the virtual paths the resulting
// file should be linked to, and that hook does the linking once the download
// lands in /.backends.

export default async function run({ classify, workspace, logger }) {
    const c = classify();
    if (!c.isTab() || !c.isYoutube()) { return; }

    const script = path.join(workspace.rootPath, 'git', 'scripts', 'ytdl.sh');
    if (!existsSync(script)) {
        logger.debug('youtube hook: git/scripts/ytdl.sh missing, skipping');
        return;
    }

    const targetDir = path.join(workspace.rootPath, 'home', 'Videos');
    const linkPath = c.paths[0] || '/';

    // Fire-and-forget: the download can take a while and the inserted file is
    // picked up by its own document.inserted event.
    const child = spawn('bash', [script, c.url, targetDir, linkPath], {
        stdio: 'ignore',
        detached: true,
    });
    child.on('error', (err) => logger.debug(`youtube hook: spawn failed: ${err.message}`));
    child.unref();

    logger.debug(`youtube hook: downloading ${c.url} -> ${targetDir} (link: ${linkPath})`);
}
