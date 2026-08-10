#!/usr/bin/env node
// Refresh every git-hosted component to the latest commit of its branch.
//
// Runs automatically as npm postinstall — so a plain `npm install` (or the
// `npm ci` inside update-git.sh) always leaves the box on the newest
// synapsd/stored/inferd/web, matching "an update means latest main,
// everywhere". `npm update` can NOT do this: it treats a lockfile-pinned git
// ref as satisfied and never re-resolves it (verified 2026-08-10).
//
// The dep list lives in package.json under "canvas".gitDeps — one place to
// maintain, shared with anything else that needs it.
//
// Guards:
//  - CANVAS_DEPS_REFRESH_GUARD: set for our own child `npm install` calls,
//    whose postinstall would otherwise recurse forever.
//  - CANVAS_SKIP_DEP_REFRESH=1: opt out entirely (offline hacking, CI that
//    wants the exact lockfile pins).
//  - Never fails the surrounding install: a refresh error (offline, GitHub
//    down) warns and leaves the lockfile-pinned version serving.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.CANVAS_DEPS_REFRESH_GUARD) process.exit(0);
if (process.env.CANVAS_SKIP_DEP_REFRESH === '1') {
  console.log('[refresh-git-deps] skipped (CANVAS_SKIP_DEP_REFRESH=1)');
  process.exit(0);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const gitDeps = pkg.canvas?.gitDeps ?? {};

const entries = Object.entries(gitDeps);
if (entries.length === 0) { process.exit(0); }

// ⚠️ ONE install for ALL deps — do not "tidy" this back into a loop.
// These installs are --no-save, so the lockfile keeps its old pins. A second
// `npm install` re-resolves the whole tree from that lockfile and REVERTS every
// dep refreshed before it: in a loop only the last entry survives, while the
// per-dep log lines still report the fresh versions they briefly had. That is a
// silent failure — you deploy believing you are on latest main and you are not
// (observed 2026-08-10: synapsd reported 3.2.1, node_modules held 3.1.1).
const specs = entries.map(([name, spec]) => `${name}@github:${spec}`);
let refreshed = true;
try {
  execSync(`npm install ${specs.join(' ')} --no-save --no-audit --no-fund`, {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, CANVAS_DEPS_REFRESH_GUARD: '1' },
  });
} catch {
  refreshed = false;
}

// Report what is ACTUALLY on disk after the install settles — never what a
// mid-flight step claimed.
for (const [name, spec] of entries) {
  let version = '?';
  try { version = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version; } catch {}
  console.log(`[refresh-git-deps] ${name} -> ${version} (github:${spec})`);
}
if (!refreshed) {
  console.warn('[refresh-git-deps] WARN: refresh failed — every dep kept at its lockfile-pinned version (offline?)');
}
process.exit(0);
