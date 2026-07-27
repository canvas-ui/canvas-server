// Imports
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import argv from 'node:process';
import os from 'os';
import crypto from 'crypto';

// Runtime
const SERVER_MODE = argv.argv.slice(2).includes('--user') ? 'user' : 'standalone';

// Root paths
const SERVER_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_HOME = process.env.CANVAS_SERVER_HOME || getServerHome();
const USER_HOME = process.env.CANVAS_USER_HOME || getUserHome();
const EMBEDD_CONFIG_PATH = process.env.CANVAS_EMBEDD_CONFIG || path.join(SERVER_HOME, 'config', 'embedd.json');

/**
 * Environment variables
 */

export const env = {
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
            port: process.env.CANVAS_API_PORT || 8001, // Needs to be changed in ./src/ui/web/.env ..for now
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
        home: USER_HOME
    },
    embedd: {
        // Server-managed embedding service (shared model runtimes, one queue per
        // workspace). Disabled → workspaces run store-only: existing vectors stay
        // searchable, no new embeddings, dense search degrades to FTS.
        enabled: process.env.CANVAS_EMBEDD_ENABLED !== 'false',
        ollamaHost: process.env.OLLAMA_HOST || null,
        // One shared fastembed model store for all workspaces (not per-workspace).
        cacheDir: process.env.CANVAS_EMBEDD_CACHE_DIR || path.join(SERVER_HOME, 'embedd', 'models'),
        // Max embedding batches in flight across ALL workspace queues. 1 keeps the
        // old single-serial-queue behaviour (right when inference is CPU-local);
        // raise it once the providers point at a GPU host that can take the load.
        concurrency: Math.max(1, Number(process.env.CANVAS_EMBEDD_CONCURRENCY) || 1),
        // Optional providers + routing rules file. Absent → built-in providers and
        // DEFAULT_RULES, i.e. CPU-local ONNX + CLIP. This is the file that points
        // embedd at a remote/GPU inference host without a code change; see
        // src/services/embedd/src/config.js for the shape.
        configPath: EMBEDD_CONFIG_PATH,
        // Optional host allowlist for user-supplied provider URLs. Empty = only
        // the always-blocked ranges (link-local / cloud metadata) apply, which
        // is the right default: loopback and private ranges are where local
        // Ollama and in-office GPU boxes live. Set it to lock users down to
        // named hosts. Entries may be exact (`gpu.local`) or `*.suffix`.
        allowHosts: (process.env.CANVAS_EMBEDD_ALLOW_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
        ...readJsonConfig(EMBEDD_CONFIG_PATH, 'embedd'),
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

function getUserHome() {
    if (SERVER_MODE === 'user') {
        const homeDir = os.homedir();
        if (process.platform === 'win32') {
            return path.join(homeDir, 'Canvas');
        } else {
            return path.join(homeDir, '.canvas');
        }
    }

    return path.join(SERVER_HOME, 'users');
}
