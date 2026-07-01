// Imports
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
        // Server-managed embedding service (shared singleton). Disabled → workspaces
        // run store-only: existing vectors stay searchable, no new embeddings, dense
        // search degrades to FTS.
        enabled: process.env.CANVAS_EMBEDD_ENABLED !== 'false',
        ollamaHost: process.env.OLLAMA_HOST || null,
        // One shared fastembed model store for all workspaces (not per-workspace).
        cacheDir: process.env.CANVAS_EMBEDD_CACHE_DIR || path.join(SERVER_HOME, 'embedd', 'models'),
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
