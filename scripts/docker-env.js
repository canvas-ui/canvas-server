#!/usr/bin/env node
/**
 * `npm run docker:env` — write a .env for the container from .env.example,
 * pre-filled with this machine's uid/gid and home directory.
 *
 * Never overwrites an existing .env (pass --force to replace it); the file is
 * gitignored and holds the admin password, so clobbering it silently would be
 * the wrong default.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const examplePath = path.join(repoRoot, '.env.example');
const envPath = path.join(repoRoot, '.env');
const force = process.argv.includes('--force');

if (fs.existsSync(envPath) && !force) {
    console.log(`.env already exists — leaving it alone (use "npm run docker:env -- --force" to regenerate)`);
    process.exit(0);
}

const home = os.homedir();
// Only the machine-specific values are substituted; everything else stays as
// documented in .env.example so the file remains readable as a reference.
const substitutions = {
    CANVAS_UID: typeof process.getuid === 'function' ? String(process.getuid()) : '1000',
    CANVAS_GID: typeof process.getgid === 'function' ? String(process.getgid()) : '1000',
    CANVAS_HOST_SERVER_HOME: path.join(home, '.canvas', 'server'),
    CANVAS_HOST_USER_HOME: path.join(home, '.canvas', 'users'),
    CANVAS_HOST_WORKSPACES: path.join(home, 'Workspaces'),
    CANVAS_HOST_ROLES: path.join(home, 'Roles'),
    CANVAS_HOST_AGENTS: path.join(home, 'Agents'),
};

const contents = fs.readFileSync(examplePath, 'utf8')
    .split('\n')
    .map((line) => {
        const match = line.match(/^([A-Z0-9_]+)=/);
        if (!match || !(match[1] in substitutions)) { return line; }
        return `${match[1]}=${substitutions[match[1]]}`;
    })
    .join('\n');

fs.writeFileSync(envPath, contents, { mode: 0o600 });

console.log(`Wrote ${envPath}`);
for (const [key, value] of Object.entries(substitutions)) {
    console.log(`  ${key}=${value}`);
}
console.log('\nEdit it (admin email/password, host paths), then: npm run docker:up');
