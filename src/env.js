// Imports
import fs from 'fs';
import path from 'path';
import { defaultSocketPath } from './services/inferd/socket-path.js';
import { fileURLToPath } from 'url';
import argv from 'node:process';
import os from 'os';
import _crypto from 'crypto';
import dotenv from 'dotenv';

// Runtime
const SERVER_MODE = argv.argv.slice(2).includes('--user') ? 'user' : 'standalone';

// Root paths
const SERVER_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// <repo>/.env, if present. Plain dotenv semantics: variables already in the
// environment (the shell, the npm script's cross-env, install-local.sh, the
// container) win, and empty values are skipped — the template leaves optional
// keys blank, and "" would otherwise pin e.g. CANVAS_USER_WORKSPACES to an
// empty path. Runs before anything below reads process.env, and every module
// reading it at import time imports this first.
loadDotEnv(path.join(SERVER_ROOT, '.env'));

// The .env speaks in host paths (CANVAS_HOST_*), the keys docker compose binds
// and install-local.sh maps; the same mapping here makes `npm start` run on the
// same data as either of them. The server's own variables still win — the
// container sets both, so this never applies inside it.
const HOST_SERVER_HOME = resolveHostPath(process.env.CANVAS_HOST_SERVER_HOME);
const HOST_USER_HOME = resolveHostPath(process.env.CANVAS_HOST_USER_HOME);
const SERVER_HOME = process.env.CANVAS_SERVER_HOME || HOST_SERVER_HOME || getServerHome();
const USER_HOME = process.env.CANVAS_USER_HOME || hostUserHome() || getUserHome();
const INFERD_CONFIG_PATH = process.env.CANVAS_INFERD_CONFIG || path.join(SERVER_HOME, 'config', 'inferd.json');

// Read once at import. `process.env.npm_package_*` is only populated when the
// process is started through an npm script — the container entrypoint
// (`node ./src/init.js`) and the systemd unit in the README are not, so the
// routes that reported the version were serving `undefined` on exactly the
// deployments that matter. Reading the manifest works however it was started.
const PACKAGE = readPackageManifest();

/**
 * Environment variables
 */

export const env = {
    // Build identity. Beyond the obvious "which version is this" use, the AGPL
    // requires that users interacting with the server over a network can get at
    // its source (§13) — so the identity has to include where the source lives
    // and which revision is running, and has to be reachable without auth.
    app: {
        name: PACKAGE.name || 'canvas-server',
        productName: PACKAGE.productName || 'Canvas Server',
        version: PACKAGE.version || '0.0.0',
        license: PACKAGE.license || 'AGPL-3.0-or-later',
        // Where a recipient gets the corresponding source. Overridable because a
        // fork MUST point at its own repository — publishing this server's URL
        // while running modified code is not compliance.
        sourceUrl: process.env.CANVAS_SOURCE_URL || 'https://github.com/canvas-ui/canvas-server',
        // Revision actually running. `.git/` is excluded from the image
        // (.dockerignore), so containers pass it in as a build arg instead.
        commit: process.env.CANVAS_SOURCE_COMMIT || readGitCommit(),
    },
    server: {
        mode: process.env.CANVAS_SERVER_MODE || SERVER_MODE,
        root: SERVER_ROOT,
        home: SERVER_HOME,
        logLevel: process.env.LOG_LEVEL || 'info',
        host: process.env.CANVAS_SERVER_HOST || 'canvas.local',
        api: {
            // "disable" flags exist so Electron can run an embedded instance in minimal mode
            enabled: process.env.CANVAS_DISABLE_API !== 'true',
            protocol: process.env.CANVAS_API_PROTOCOL || 'http',
            port: process.env.CANVAS_API_PORT || 8001,
            host: process.env.CANVAS_API_HOST || '0.0.0.0'
        },
        web: {
            enabled: process.env.CANVAS_DISABLE_WEB !== 'true',
            protocol: process.env.CANVAS_WEB_PROTOCOL || 'http',
            port: process.env.CANVAS_WEB_PORT || 8001,
            host: process.env.CANVAS_WEB_HOST || '0.0.0.0'
        },
    },
    user: {
        home: USER_HOME,
        // Server-wide defaults for the three per-user module roots. Empty →
        // <userHome>/{Workspaces,Roles,Agents}. Values may be absolute,
        // `~`-prefixed, or use {USER_HOME} / {HOME} — so a personal instance
        // can run with CANVAS_USER_WORKSPACES=~/Workspaces and keep its
        // workspaces where the user actually looks for them. A user's own
        // override (the `paths` map in their record) still wins over these.
        paths: {
            workspaces: process.env.CANVAS_USER_WORKSPACES || null,
            roles: process.env.CANVAS_USER_ROLES || null,
            agents: process.env.CANVAS_USER_AGENTS || null,
        },
    },
    workspace: {
        // Folder structure new workspaces are created with, unless the caller
        // picks one (the picker in the web UI does).
        //
        //   full — runtime dirs are visible children of the root, the drive is home/
        //   home — the root IS the drive, everything else hides in .workspace/
        //
        // `home` is what turns an existing folder — a Dropbox/OneDrive dir, a
        // roaming profile — into a workspace without scattering db/ and cache/
        // through it, so the container ships with it (see docker-compose.yml).
        defaultLayout: process.env.CANVAS_WORKSPACE_LAYOUT === 'home' ? 'home' : 'full',

        // Pulling a workspace from another canvas-server makes THIS server issue
        // requests to a user-supplied URL, so by default only public https hosts
        // are allowed (see utils/ssrf-guard.js). That rules out exactly the case
        // self-hosters actually have: another canvas-server on the LAN, on plain
        // http, at a private address or a .local name. Setting this to 'true'
        // permits http and private/loopback targets for remote workspace import
        // only — do NOT set it on a multi-tenant public instance, where it lets
        // any authenticated user probe your internal network.
        allowInsecureRemoteImport: process.env.CANVAS_ALLOW_INSECURE_REMOTE_IMPORT === 'true',
        // Shared pull-through cache for bytes read through remote workspace
        // references (content/thumbnails, keyed per remote, deduped by content).
        remoteCacheRoot: process.env.CANVAS_REMOTE_WORKSPACE_CACHE || null,
    },
    inferd: {
        // Server-managed embedding service (shared model runtimes, one queue per
        // workspace). Disabled → workspaces run store-only: existing vectors stay
        // searchable, no new embeddings, dense search degrades to FTS.
        enabled: process.env.CANVAS_INFERD_ENABLED !== 'false',
        // Base URLs for the two built-in OpenAI-compatible presets (`ollama`,
        // `vllm`). Both default to their daemon's loopback port inside inferd;
        // set these when the daemon runs on another box.
        ollamaHost: process.env.OLLAMA_HOST || null,
        vllmBaseUrl: process.env.VLLM_BASE_URL || null,
        // One shared fastembed model store for all workspaces (not per-workspace).
        cacheDir: process.env.CANVAS_INFERD_CACHE_DIR || path.join(SERVER_HOME, 'inferd', 'models'),
        // Max embedding batches in flight across ALL workspace queues. 1 keeps the
        // old single-serial-queue behaviour (right when inference is CPU-local);
        // raise it once the providers point at a GPU host that can take the load.
        concurrency: Math.max(1, Number(process.env.CANVAS_INFERD_CONCURRENCY) || 1),
        // Optional providers + routing rules file. Absent → built-in providers and
        // DEFAULT_RULES, i.e. CPU-local ONNX + CLIP. This is the file that points
        // inferd at a remote/GPU inference host without a code change; see
        // canvas-inferd/src/config.js for the shape.
        configPath: INFERD_CONFIG_PATH,
        // Optional host allowlist for user-supplied provider URLs. Empty = only
        // the always-blocked ranges (link-local / cloud metadata) apply, which
        // is the right default: loopback and private ranges are where local
        // Ollama and in-office GPU boxes live. Set it to lock users down to
        // named hosts. Entries may be exact (`gpu.local`) or `*.suffix`.
        allowHosts: (process.env.CANVAS_INFERD_ALLOW_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
        // inferd is a separate PROCESS reached over this socket — the server
        // links no inference code at all. The default is resolved by a rule
        // canvas-inferd implements identically (see socket-path.js in both), so
        // an unconfigured pair still finds each other; set CANVAS_INFERD_SOCKET
        // to point at a daemon somewhere else (a container sidecar, another box
        // via a forwarded socket).
        socketPath: defaultSocketPath(),
        // Dev convenience: let the server start the daemon itself so `npm run
        // dev` is still one command. Off by default — in production the daemon
        // has its own lifecycle and the server just connects.
        spawn: process.env.CANVAS_INFERD_SPAWN === 'true',
        command: process.env.CANVAS_INFERD_COMMAND || 'canvas-inferd',
        spawnArgs: INFERD_CONFIG_PATH ? ['--config', INFERD_CONFIG_PATH] : [],
        ...readJsonConfig(INFERD_CONFIG_PATH, 'inferd'),
    },
    messaging: {
        // User notification/chat channels (Slack, WhatsApp Cloud API). The
        // console adapter is always available as a dev fallback; real adapters
        // activate only when their tokens are configured.
        enabled: process.env.CANVAS_MESSAGING_ENABLED !== 'false',
        slack: {
            botToken: process.env.SLACK_BOT_TOKEN || null,
            // App-level token (xapp-*) enables inbound chat via Socket Mode.
            appToken: process.env.SLACK_APP_TOKEN || null,
        },
        whatsapp: {
            accessToken: process.env.WHATSAPP_TOKEN || null,
            phoneNumberId: process.env.WHATSAPP_PHONE_ID || null,
            // Shared secret for Cloud API webhook subscription verification.
            verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || null,
            // Meta App Secret — used to verify the X-Hub-Signature-256 HMAC on
            // inbound webhook deliveries so forged POSTs are rejected. When
            // unset, inbound webhooks are refused (fail closed) unless
            // WHATSAPP_ALLOW_UNSIGNED_WEBHOOKS=true is explicitly set.
            appSecret: process.env.WHATSAPP_APP_SECRET || null,
            allowUnsignedWebhooks: process.env.WHATSAPP_ALLOW_UNSIGNED_WEBHOOKS === 'true',
        },
    },
    voice: {
        // Speech-to-text / text-to-speech via OpenAI-compatible local servers
        // (speaches/faster-whisper for STT, kokoro-fastapi/openedai-speech for
        // TTS). Each side activates only when its base URL is configured.
        stt: {
            baseUrl: process.env.CANVAS_VOICE_STT_URL || null,
            apiKey: process.env.CANVAS_VOICE_STT_API_KEY || null,
            model: process.env.CANVAS_VOICE_STT_MODEL || 'whisper-1',
            language: process.env.CANVAS_VOICE_STT_LANGUAGE || null,
        },
        tts: {
            baseUrl: process.env.CANVAS_VOICE_TTS_URL || null,
            apiKey: process.env.CANVAS_VOICE_TTS_API_KEY || null,
            model: process.env.CANVAS_VOICE_TTS_MODEL || 'kokoro',
            voice: process.env.CANVAS_VOICE_TTS_VOICE || 'af_heart',
            format: process.env.CANVAS_VOICE_TTS_FORMAT || 'mp3',
        },
    },
    auth: {
        // TODO: Use SERVER_HOME/config/auth.json for jwtSecret and tokenExpiry
        jwtSecret: process.env.CANVAS_JWT_SECRET || 'canvas-jwt-secret-change-in-production', //generateJwtSecret(),
        tokenExpiry: process.env.CANVAS_JWT_TOKEN_EXPIRY || '7d'
    },
    admin: {
        email: process.env.CANVAS_ADMIN_EMAIL || 'admin@canvas.local',
        // Username for the bootstrap admin. Empty → derived from the email's
        // local part (admin@canvas.local → "admin").
        name: process.env.CANVAS_ADMIN_NAME || null,
        password: process.env.CANVAS_ADMIN_PASSWORD || null, // null will trigger auto-generation
        forceReset: process.env.CANVAS_ADMIN_RESET === 'true' || false
    }
}

/**
 * Private Utils
 */

/**
 * Read an optional JSON config file. A missing file is the normal case (defaults
 * apply) and returns {}. A file that exists but cannot be parsed is a real
 * mistake, so it is reported loudly rather than silently ignored — but it still
 * falls back to defaults instead of taking the whole server down at import time.
 */
/**
 * Read the server's own package.json. A failure here is not fatal — the server
 * runs fine without knowing its version — but it does mean the source reference
 * falls back to defaults, so it is worth a warning.
 */
function readPackageManifest() {
    try {
        return JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'));
    } catch (error) {
        console.warn(`env: could not read package.json: ${error.message}`);
        return {};
    }
}

/**
 * Best-effort revision of the running tree, read straight from .git rather than
 * by shelling out to git (which may not be installed on a deployment host).
 * Returns null when the source was deployed without its git metadata — set
 * CANVAS_SOURCE_COMMIT at build time for those.
 */
function readGitCommit() {
    try {
        const gitDir = path.join(SERVER_ROOT, '.git');
        if (!fs.existsSync(gitDir)) { return null; }

        // A submodule/worktree checkout has .git as a file pointing elsewhere.
        const resolvedGitDir = fs.statSync(gitDir).isDirectory()
            ? gitDir
            : path.resolve(SERVER_ROOT, fs.readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim());

        const head = fs.readFileSync(path.join(resolvedGitDir, 'HEAD'), 'utf8').trim();
        if (!head.startsWith('ref:')) { return head; } // detached HEAD

        const ref = head.slice(4).trim();
        const refPath = path.join(resolvedGitDir, ref);
        if (fs.existsSync(refPath)) { return fs.readFileSync(refPath, 'utf8').trim(); }

        // Ref was packed away by `git gc`.
        const packed = fs.readFileSync(path.join(resolvedGitDir, 'packed-refs'), 'utf8');
        return packed.split('\n').find((line) => line.endsWith(` ${ref}`))?.split(' ')[0] || null;
    } catch {
        return null;
    }
}

function readJsonConfig(filePath, label) {
    try {
        if (!fs.existsSync(filePath)) { return {}; }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.warn(`env: ignoring unreadable ${label} config at ${filePath}: ${error.message}`);
        return {};
    }
}

function getServerHome() {
    if (SERVER_MODE === 'user') {
        const homeDir = os.homedir();
        if (process.platform === 'win32') {
            return path.join(homeDir, 'Canvas', 'server');
        } else {
            return path.join(homeDir, '.canvas', 'server');
        }
    } else {
        return path.join(SERVER_ROOT, 'server');
    }
}

/**
 * User homes are server runtime state, so they live under the server home —
 * which is what keeps all three deployment shapes right without branching here:
 *
 *   server / remote   <install>/server/users
 *   local portable    <install>/server/users   — travels with the folder
 *   local installed   ~/.canvas/server/users   (--user; ~/Canvas on Windows)
 *
 * The rest of ~/.canvas/ (or ~/Canvas/) belongs to the client apps and their
 * caches; the server must not colonize it. Deployments that genuinely need the
 * two split — a users tree on separate storage, or the container, where each
 * root is its own bind mount — set CANVAS_USER_HOME explicitly.
 */
function getUserHome() {
    return path.join(SERVER_HOME, 'users');
}

/** A CANVAS_HOST_* path: absolute, `~`-prefixed, or relative to the repo (the template's ./data/...). */
function resolveHostPath(value) {
    if (!value) { return null; }
    if (value === '~' || value.startsWith('~/')) { return path.join(os.homedir(), value.slice(1)); }
    return path.resolve(SERVER_ROOT, value);
}

/**
 * Where CANVAS_HOST_USER_HOME puts the users root, the same two shapes as
 * docker-compose.yml and install-local.sh:
 *
 *   CANVAS_USER_MOUNT set    the path IS the users root, one <email>/ per user
 *   personal (the default)   the path is the admin's own home, linked in as
 *                            <serverHome>/users/<admin email>
 *
 * The link is only created or repointed, never over a real directory — that
 * is someone's existing data; the server then keeps using it and says so.
 */
function hostUserHome() {
    if (!HOST_USER_HOME) { return null; }
    if (process.env.CANVAS_USER_MOUNT) { return HOST_USER_HOME; }

    const usersRoot = path.join(SERVER_HOME, 'users');
    const email = (process.env.CANVAS_ADMIN_EMAIL || 'admin@canvas.local').toLowerCase();
    const link = path.join(usersRoot, email);
    try {
        fs.mkdirSync(HOST_USER_HOME, { recursive: true });
        fs.mkdirSync(usersRoot, { recursive: true });
        let current = null;
        try { current = fs.lstatSync(link); } catch (err) { if (err.code !== 'ENOENT') { throw err; } }
        if (!current) {
            fs.symlinkSync(HOST_USER_HOME, link);
        } else if (current.isSymbolicLink()) {
            if (fs.readlinkSync(link) !== HOST_USER_HOME) {
                fs.unlinkSync(link);
                fs.symlinkSync(HOST_USER_HOME, link);
            }
        } else {
            console.warn(`[env] ${link} is a real directory; CANVAS_HOST_USER_HOME (${HOST_USER_HOME}) is NOT being used — move it aside or set CANVAS_USER_MOUNT`);
        }
    } catch (err) {
        console.warn(`[env] could not link ${link} → ${HOST_USER_HOME}: ${err.message}`);
    }
    return usersRoot;
}

function loadDotEnv(file) {
    let parsed;
    try {
        parsed = dotenv.parse(fs.readFileSync(file));
    } catch (err) {
        if (err.code !== 'ENOENT') { console.warn(`[env] could not read ${file}: ${err.message}`); }
        return;
    }
    for (const [key, value] of Object.entries(parsed)) {
        if (value !== '' && process.env[key] === undefined) { process.env[key] = value; }
    }
}
