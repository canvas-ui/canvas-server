import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Example (disabled), stage 1 of 2: pins/image links sent to /to-sort get
// their image downloaded into home/Pictures and linked back to /to-sort,
// where stage 2 (example-image-categorizer.js) picks the file up and has a
// vision agent sort it. Enable by renaming to `pinterest-downloader.js`, and
// enable `incoming-metadata-linker.js` (it consumes the sidecar the download
// script writes).

const HOSTS = ['pinterest.com', 'pinimg.com'];

export default async function hook({ classify, workspace, logger }) {
  const c = classify();
  if (!c.isLink() || !c.inPath('/to-sort')) { return; }
  if (!HOSTS.some((h) => c.hostMatches(h)) && !c.isImageUrl()) { return; }

  const script = path.join(workspace.rootPath, 'git', 'scripts', 'fetch-url.sh');
  if (!existsSync(script)) {
    logger.debug('pinterest-downloader: git/scripts/fetch-url.sh missing, skipping');
    return;
  }

  const targetDir = path.join(workspace.rootPath, 'home', 'Pictures');
  // Link the downloaded file back to /to-sort so the categorizer sees it.
  const child = spawn('bash', [script, c.url, targetDir, '/to-sort'], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', (err) => logger.debug(`pinterest-downloader: spawn failed: ${err.message}`));
  child.unref();

  logger.debug(`pinterest-downloader: fetching ${c.url} -> ${targetDir}`);
}
