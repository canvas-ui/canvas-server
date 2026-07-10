import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { insertHomeFile } from '../lib/insert-file.js';

// Example (disabled), stage 1 of 2: pins/image links sent to /to-sort get
// their image downloaded into home/Pictures and inserted through the front
// door, linked back to /to-sort — where stage 2 (example-image-categorizer.js)
// picks the file up and has a vision agent sort it. The insert carries
// origin:'hook', so stage 2 MUST export `cascade = true` to see it.
// Enable by renaming to `pinterest-downloader.js`.

const HOSTS = ['pinterest.com', 'pinimg.com'];

export default async function hook(ctx) {
  const { classify, workspace, logger } = ctx;
  const c = classify();
  if (!c.isLink() || !c.inPath('/to-sort')) { return; }
  if (!HOSTS.some((h) => c.hostMatches(h)) && !c.isImageUrl()) { return; }

  const script = path.join(workspace.rootPath, 'git', 'scripts', 'fetch-url.sh');
  if (!existsSync(script)) {
    logger.debug('pinterest-downloader: git/scripts/fetch-url.sh missing, skipping');
    return;
  }

  const targetDir = path.join(workspace.rootPath, 'home', 'Pictures');
  const filePath = await new Promise((resolve) => {
    const child = spawn('bash', [script, c.url, targetDir], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (err) => { logger.debug(`pinterest-downloader: spawn failed: ${err.message}`); resolve(null); });
    child.on('close', () => resolve(out.trim().split('\n').pop() || null));
  });
  if (!filePath || !existsSync(filePath)) {
    logger.debug(`pinterest-downloader: nothing downloaded for ${c.url}`);
    return;
  }

  // Link the downloaded file back to /to-sort so the categorizer sees it.
  await insertHomeFile(ctx, filePath, { linkPath: '/to-sort', source: c.url });
  logger.debug(`pinterest-downloader: ${c.url} -> ${filePath}`);
}
