import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { insertHomeFile } from '../lib/insert-file.js';

// Example (disabled): when a link to an image file is indexed, download it
// into home/Pictures and register the file through the front door — the hook
// inserts the File document itself (checksummed, linked to the same context
// path the link landed in, origin:'hook'). No metadata sidecars. Enable by
// renaming to `image-url-downloader.js`.

export default async function hook(ctx) {
  const { classify, workspace, logger } = ctx;
  const c = classify();
  if (!c.isLink() || !c.isImageUrl()) { return; }

  const script = path.join(workspace.rootPath, 'git', 'scripts', 'fetch-url.sh');
  if (!existsSync(script)) {
    logger.debug('image-url-downloader: git/scripts/fetch-url.sh missing, skipping');
    return;
  }

  const targetDir = path.join(workspace.rootPath, 'home', 'Pictures');
  const linkPath = c.paths[0] || '/';

  // The script prints the downloaded file's absolute path on stdout.
  const filePath = await new Promise((resolve) => {
    const child = spawn('bash', [script, c.url, targetDir], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (err) => { logger.debug(`image-url-downloader: spawn failed: ${err.message}`); resolve(null); });
    child.on('close', () => resolve(out.trim().split('\n').pop() || null));
  });
  if (!filePath || !existsSync(filePath)) {
    logger.debug(`image-url-downloader: nothing downloaded for ${c.url}`);
    return;
  }

  await insertHomeFile(ctx, filePath, { linkPath, source: c.url });
  logger.debug(`image-url-downloader: ${c.url} -> ${filePath} (linked: ${linkPath})`);
}
