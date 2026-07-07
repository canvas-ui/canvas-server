import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Example (disabled): when a link to an image file is indexed, download it
// into home/Pictures. The script writes a hidden `.<file>.metadata.json`
// sidecar so incoming-metadata-linker.js links the downloaded file to the
// same context path the link landed in. Enable by renaming to
// `image-url-downloader.js`.

export default async function hook({ classify, workspace, logger }) {
  const c = classify();
  if (!c.isLink() || !c.isImageUrl()) { return; }

  const script = path.join(workspace.rootPath, 'git', 'scripts', 'fetch-url.sh');
  if (!existsSync(script)) {
    logger.debug('image-url-downloader: git/scripts/fetch-url.sh missing, skipping');
    return;
  }

  const targetDir = path.join(workspace.rootPath, 'home', 'Pictures');
  const linkPath = c.paths[0] || '/';

  const child = spawn('bash', [script, c.url, targetDir, linkPath], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', (err) => logger.debug(`image-url-downloader: spawn failed: ${err.message}`));
  child.unref();

  logger.debug(`image-url-downloader: fetching ${c.url} -> ${targetDir} (link: ${linkPath})`);
}
