#!/usr/bin/env node

/**
 * Throwaway "we'll be right back" page served while update-git.sh rebuilds the app.
 *
 * Runs on the same port as canvas-server, so it must be stopped before the real
 * service starts. Uses node builtins only: update-git.sh wipes node_modules
 * while this is running.
 *
 * Usage: node maintenance-server.js [--port 8001] [--root /opt/canvas-server]
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = parseInt(argValue('--port', process.env.CANVAS_API_PORT || '8001'), 10);
const HOST = argValue('--host', process.env.CANVAS_API_HOST || '0.0.0.0');
const ROOT = argValue('--root', process.env.CANVAS_ROOT || process.cwd());
const STARTED_AT = Date.now();

// Read per-request, not once at boot: the git pull swaps package.json underneath
// us mid-update, so the page starts showing the incoming version by itself.
function currentVersion() {
    try {
        const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        return pkg.version || 'unknown';
    } catch {
        return 'unknown';
    }
}

const QUIPS = [
    'Reticulating splines...',
    'Teaching the bitmaps to count again...',
    'Convincing npm that yes, we really do need all 1400 packages...',
    'Re-indexing the universe. It is quite large.',
    'Feeding the hamsters. They negotiated a better contract.',
    'Turning it off and on again, professionally.',
    'Compiling. Perfect time for a coffee.',
    'Asking the vectors to please stay in their own dimension.',
];

function page() {
    const version = currentVersion();
    const elapsed = Math.floor((Date.now() - STARTED_AT) / 1000);
    const quips = JSON.stringify(QUIPS);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Canvas is updating...</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #f6f8fa; color: #1f2328; text-align: center; padding: 2rem;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .card { max-width: 34rem; }
  .spinner {
    width: 2.5rem; height: 2.5rem; margin: 0 auto 2rem;
    border: 3px solid #d8dee4; border-top-color: #0969da; border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 1.6rem; margin: 0 0 .75rem; font-weight: 600; }
  p { margin: 0 0 1.25rem; color: #59636e; line-height: 1.6; }
  #quip { color: #0969da; font-family: ui-monospace, SFMono-Regular, monospace; font-size: .9rem; min-height: 1.4em; }
  .meta { margin-top: 2.5rem; font-size: .8rem; color: #818b98; }
  code { background: #eaeef2; padding: .15rem .4rem; border-radius: 4px; color: #1f2328; }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
</head>
<body>
  <div class="card">
    <div class="spinner"></div>
    <h1>Canvas is being updated</h1>
    <p>We're pulling in version <code>${version}</code> and rebuilding.<br>Please stand by - this page refreshes itself.</p>
    <p id="quip"></p>
    <div class="meta">Update started ${elapsed}s ago</div>
  </div>
<script>
  const quips = ${quips};
  const el = document.getElementById('quip');
  let i = Math.floor(Math.random() * quips.length);
  const tick = () => { el.textContent = quips[i++ % quips.length]; };
  tick();
  setInterval(tick, 4000);
</script>
</body>
</html>`;
}

const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'updating', version: currentVersion() }));
        return;
    }

    // 503 across the board so proxies, the REST API clients and the browser all
    // agree that this is a temporary outage rather than a real response.
    res.writeHead(503, {
        'Content-Type': 'text/html; charset=utf-8',
        'Retry-After': '30',
        'Cache-Control': 'no-store',
    });
    res.end(page());
});

server.listen(PORT, HOST, () => {
    console.log(`Maintenance page listening on http://${HOST}:${PORT}`);
});

server.on('error', (err) => {
    console.error(`Maintenance page failed to bind ${HOST}:${PORT}: ${err.message}`);
    process.exit(1);
});

const shutdown = () => {
    server.close(() => process.exit(0));
    // Browsers sitting on the refresh loop hold keep-alive sockets open, and
    // server.close() alone waits for them, so drop them and free the port for
    // the real server immediately.
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
