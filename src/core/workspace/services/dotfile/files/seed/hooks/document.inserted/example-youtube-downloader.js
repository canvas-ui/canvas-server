import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { insertHomeFile } from '../lib/insert-file.js';

// Example (disabled): when a YouTube link is indexed, download it with yt-dlp
// into home/Videos and register the file through the front door — the hook
// inserts the File document itself (checksummed + linked to the same path the
// tab landed in), stamped origin:'hook'. No metadata sidecars, no waiting for
// the home indexer. Enable by renaming to `youtube-downloader.js` (strip the
// `example-` prefix, or toggle in the webui).
//
// A follow-up hook reacting to the inserted video (e.g. a categorizer) must
// opt into automation-caused events with `export const cascade = true`.

export default async function run(ctx) {
    const { classify, workspace, logger } = ctx;
    const c = classify();
    if (!c.isTab() || !c.isYoutube()) { return; }

    const script = path.join(workspace.rootPath, 'git', 'scripts', 'ytdl.sh');
    if (!existsSync(script)) {
        logger.debug('youtube hook: git/scripts/ytdl.sh missing, skipping');
        return;
    }

    const targetDir = path.join(workspace.rootPath, 'home', 'Videos');
    const linkPath = c.paths[0] || '/';

    // The script prints the downloaded file's absolute path on stdout.
    // Awaiting here is fine — hooks run async and never block ingestion.
    const filePath = await new Promise((resolve) => {
        const child = spawn('bash', [script, c.url, targetDir], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('error', (err) => { logger.debug(`youtube hook: spawn failed: ${err.message}`); resolve(null); });
        child.on('close', () => resolve(out.trim().split('\n').pop() || null));
    });
    if (!filePath || !existsSync(filePath)) {
        logger.debug(`youtube hook: no file downloaded for ${c.url}`);
        return;
    }

    await insertHomeFile(ctx, filePath, { linkPath, source: c.url });
    logger.debug(`youtube hook: ${c.url} -> ${filePath} (linked: ${linkPath})`);
}
