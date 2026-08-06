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
import { execFileSync } from 'child_process';
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
    CANVAS_HOST_WORKSPACES: path.join(home, 'Workspaces'),
    CANVAS_HOST_ROLES: path.join(home, 'Roles'),
    CANVAS_HOST_AGENTS: path.join(home, 'Agents'),
    // The image cannot read .git (excluded from the build context), so the
    // revision behind the AGPL §13 source offer has to be captured here and
    // passed in as a build arg. Empty when this is not a git checkout — the
    // server just reports no commit then.
    CANVAS_SOURCE_COMMIT: readGitHead(),
};

function readGitHead() {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
}

const contents = fs.readFileSync(examplePath, 'utf8')
    .split('\n')
    .map((line) => {
        const match = line.match(/^([A-Z0-9_]+)=/);
        if (!match || !(match[1] in substitutions)) { return line; }
        return `${match[1]}=${substitutions[match[1]]}`;
    })
    .join('\n');

fs.writeFileSync(envPath, contents, { mode: 0o600 });

// Both ends of every bind mount have to exist before the first `up`: docker
// creates a missing one as root, and the container runs as this uid. The
// mountpoints live inside the admin user's home — modules are per-user
// (<serverHome>/users/<email>/{Workspaces,Roles,Agents}), the host folders are
// only attached there.
const adminEmail = contents.match(/^CANVAS_ADMIN_EMAIL=(.*)$/m)?.[1]?.trim() || 'admin@canvas.local';
const adminHome = path.join(substitutions.CANVAS_HOST_SERVER_HOME, 'users', adminEmail);
for (const dir of [
    path.join(substitutions.CANVAS_HOST_SERVER_HOME, 'users'),
    path.join(adminHome, 'Workspaces'), path.join(adminHome, 'Roles'), path.join(adminHome, 'Agents'),
    substitutions.CANVAS_HOST_WORKSPACES, substitutions.CANVAS_HOST_ROLES, substitutions.CANVAS_HOST_AGENTS,
]) {
    fs.mkdirSync(dir, { recursive: true });
}

console.log(`Wrote ${envPath}`);
for (const [key, value] of Object.entries(substitutions)) {
    console.log(`  ${key}=${value}`);
}
console.log(`  mounted into ${adminHome}/{Workspaces,Roles,Agents}`);
console.log('\nEdit it (admin email/password, host paths), then: npm run docker:up');
