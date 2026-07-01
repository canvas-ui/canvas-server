/**
 * Canvas Logger - shared server logging
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { Writable } from 'stream';
import pino from 'pino';
import pretty from 'pino-pretty';
import { env } from '../env.js';

const isDev = process.env.NODE_ENV !== 'production';
const VALID_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const MAX_TAIL_LINES = 500;
const MAX_TAIL_SCAN_LINES = 5000;
const LOG_LEVEL_VALUES = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
};
const logEvents = new EventEmitter();

logEvents.setMaxListeners(0);

/**
 * Config
 */

const DEFAULT_LOGGING_CONFIG = {
    level: 'info',
    file: 'log/canvas-server.log',
    fileLevel: 'trace',
    console: {
        enabled: true,
        level: null,
        pretty: null,
    },
    captureConsole: true,
};

function normalizeLevel(level, fallback = 'info') {
    const normalized = String(level || fallback).toLowerCase();
    return VALID_LEVELS.has(normalized) ? normalized : fallback;
}

function resolveLogPath(filePath) {
    if (!filePath) {
        return path.join(env.server.home, DEFAULT_LOGGING_CONFIG.file);
    }

    return path.isAbsolute(filePath) ? filePath : path.join(env.server.home, filePath);
}

function loadLoggingConfig() {
    const configPath = path.join(env.server.home, 'config', 'logging.json');

    if (!fsSync.existsSync(configPath)) {
        const configDir = path.dirname(configPath);
        if (!fsSync.existsSync(configDir)) {
            fsSync.mkdirSync(configDir, { recursive: true });
        }

        fsSync.writeFileSync(configPath, `${JSON.stringify(DEFAULT_LOGGING_CONFIG, null, 2)}\n`, 'utf8');
        return { ...DEFAULT_LOGGING_CONFIG };
    }

    try {
        const parsed = JSON.parse(fsSync.readFileSync(configPath, 'utf8'));
        return {
            ...DEFAULT_LOGGING_CONFIG,
            ...parsed,
            console: {
                ...DEFAULT_LOGGING_CONFIG.console,
                ...(parsed.console || {}),
            },
        };
    } catch {
        return { ...DEFAULT_LOGGING_CONFIG };
    }
}

const loggingConfig = loadLoggingConfig();
const LOG_FILE_PATH = resolveLogPath(loggingConfig.file);
const LOG_LEVEL = normalizeLevel(process.env.LOG_LEVEL || loggingConfig.level || env.server.logLevel);
const FILE_LOG_LEVEL = normalizeLevel(loggingConfig.fileLevel, 'trace');
const CONSOLE_ENABLED = loggingConfig.console?.enabled !== false;
const CONSOLE_LOG_LEVEL = normalizeLevel(loggingConfig.console?.level || LOG_LEVEL);
const CONSOLE_PRETTY = loggingConfig.console?.pretty ?? isDev;

/**
 * Level helpers
 */

function getLevelValue(level) {
    if (typeof level === 'number') {
        return level;
    }

    return LOG_LEVEL_VALUES[String(level || '').toLowerCase()] ?? null;
}

function getLevelLabel(level) {
    const value = getLevelValue(level);
    if (value === null) {
        return 'unknown';
    }

    return Object.entries(LOG_LEVEL_VALUES).find(([, candidate]) => candidate === value)?.[0] || 'unknown';
}

function normalizeLineBreaks(value) {
    return String(value || '').replace(/\r\n/g, '\n');
}

function formatLogEntry(entry) {
    if (!entry) {
        return '';
    }

    if (entry.raw && !entry.data) {
        return entry.raw;
    }

    const parts = [];
    const timestamp = entry.time ? new Date(entry.time).toISOString() : null;

    if (timestamp) {
        parts.push(`[${timestamp}]`);
    }

    if (entry.levelLabel && entry.levelLabel !== 'unknown') {
        parts.push(entry.levelLabel.toUpperCase());
    }

    if (entry.module) {
        parts.push(`[${entry.module}]`);
    }

    if (entry.msg) {
        parts.push(entry.msg);
    }

    const extra = entry.data
        ? Object.fromEntries(Object.entries(entry.data).filter(([key]) => ![
            'time',
            'level',
            'module',
            'msg',
            'pid',
            'hostname',
            'service',
        ].includes(key)))
        : null;

    if (extra && Object.keys(extra).length > 0) {
        parts.push(JSON.stringify(extra));
    }

    return parts.join(' ').trim();
}

export function normalizeLogEntry(rawLine) {
    const raw = normalizeLineBreaks(rawLine).trim();
    if (!raw) {
        return null;
    }

    try {
        const data = JSON.parse(raw);
        const entry = {
            time: data.time || null,
            level: getLevelValue(data.level),
            levelLabel: getLevelLabel(data.level),
            module: data.module || data.name || data.component || null,
            msg: data.msg || data.message || '',
            data,
            raw,
        };

        return {
            ...entry,
            line: formatLogEntry(entry),
        };
    } catch {
        return {
            time: null,
            level: null,
            levelLabel: 'unknown',
            module: null,
            msg: raw,
            data: null,
            raw,
            line: raw,
        };
    }
}

function normalizeTail(tail = 200) {
    const parsed = Number.parseInt(tail, 10);
    if (!Number.isFinite(parsed)) {
        return 200;
    }

    return Math.min(Math.max(parsed, 1), MAX_TAIL_LINES);
}

function matchesLogFilter(entry, filters = {}) {
    if (!entry) {
        return false;
    }

    const levelValue = getLevelValue(filters.level);
    if (levelValue !== null) {
        if (entry.level === null || entry.level < levelValue) {
            return false;
        }
    }

    const moduleFilter = String(filters.module || '').trim().toLowerCase();
    if (moduleFilter) {
        const haystack = `${entry.module || ''} ${entry.msg || ''} ${entry.line || ''}`.toLowerCase();
        if (!haystack.includes(moduleFilter)) {
            return false;
        }
    }

    return true;
}

/**
 * Streams
 */

class BroadcastStream extends Writable {
    #buffer = '';

    _write(chunk, encoding, callback) {
        try {
            this.#buffer += chunk.toString('utf8');
            const lines = this.#buffer.split('\n');
            this.#buffer = lines.pop() || '';

            for (const line of lines) {
                const entry = normalizeLogEntry(line);
                if (entry) {
                    logEvents.emit('entry', entry);
                }
            }

            callback();
        } catch (error) {
            callback(error);
        }
    }

    _final(callback) {
        if (this.#buffer.trim()) {
            const entry = normalizeLogEntry(this.#buffer);
            if (entry) {
                logEvents.emit('entry', entry);
            }
        }

        callback();
    }
}

function buildStreams() {
    const streams = [
        { level: FILE_LOG_LEVEL, stream: new BroadcastStream() },
        { level: FILE_LOG_LEVEL, stream: pino.destination({ dest: LOG_FILE_PATH, mkdir: true, sync: false }) },
    ];

    if (CONSOLE_ENABLED) {
        streams.push({
            level: CONSOLE_LOG_LEVEL,
            stream: CONSOLE_PRETTY
                ? pretty({
                    colorize: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname,service',
                    sync: false,
                })
                : pino.destination({ dest: 1, sync: false }),
        });
    }

    return streams;
}

export const logger = pino({
    name: 'canvas-server',
    base: {
        service: 'canvas-server',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    level: LOG_LEVEL,
    redact: {
        paths: [
            'authorization',
            'cookie',
            'password',
            'passwordHash',
            'token',
            'apiToken',
            'accessToken',
            'refreshToken',
            'resetToken',
            'verificationToken',
            'headers.authorization',
            'headers.cookie',
            'req.headers.authorization',
            'req.headers.cookie',
            'request.headers.authorization',
            'request.headers.cookie',
            'auth.pass',
            'smtpConfig.auth.pass',
        ],
        censor: '[REDACTED]',
    },
}, pino.multistream(buildStreams()));

/**
 * Console capture
 */

function serializeConsoleArg(value) {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }

    if (typeof value === 'object' && value !== null) {
        return value;
    }

    return String(value);
}

function writeConsoleLog(level, args) {
    const consoleLogger = logger.child({ module: 'console' });
    const writer = (consoleLogger[level] || consoleLogger.info).bind(consoleLogger);

    if (!args.length) {
        writer('');
        return;
    }

    if (typeof args[0] === 'string') {
        const rest = args.slice(1);
        if (!rest.length) {
            writer(args[0]);
            return;
        }

        const objects = rest.filter((item) => typeof item === 'object' && item !== null);
        if (objects.length === rest.length && objects.length === 1) {
            writer(objects[0], args[0]);
            return;
        }

        writer({ detail: rest.map(serializeConsoleArg) }, args[0]);
        return;
    }

    writer({ detail: args.map(serializeConsoleArg) }, 'console output');
}

function patchConsole() {
    if (loggingConfig.captureConsole === false) {
        return;
    }

    const methods = {
        log: 'info',
        info: 'info',
        debug: 'debug',
        warn: 'warn',
        error: 'error',
    };

    for (const [method, level] of Object.entries(methods)) {
        console[method] = (...args) => writeConsoleLog(level, args);
    }
}

patchConsole();

/**
 * Public API
 */

export function createLogger(name) {
    return name ? logger.child({ module: name }) : logger;
}

export function getLogFilePath() {
    return LOG_FILE_PATH;
}

export function getLogLevel() {
    return LOG_LEVEL;
}

export function getLoggingConfig() {
    return {
        level: LOG_LEVEL,
        file: LOG_FILE_PATH,
        fileLevel: FILE_LOG_LEVEL,
        console: {
            enabled: CONSOLE_ENABLED,
            level: CONSOLE_LOG_LEVEL,
            pretty: CONSOLE_PRETTY,
        },
        captureConsole: loggingConfig.captureConsole !== false,
    };
}

export function subscribeToLogs(listener, filters = {}) {
    const handler = (entry) => {
        if (matchesLogFilter(entry, filters)) {
            listener(entry);
        }
    };

    logEvents.on('entry', handler);

    return () => {
        logEvents.off('entry', handler);
    };
}

async function readTailLines(maxLines) {
    try {
        const file = await fs.open(LOG_FILE_PATH, 'r');

        try {
            const stats = await file.stat();
            if (!stats.size) {
                return [];
            }

            let position = stats.size;
            let chunkSize = 64 * 1024;
            let content = '';
            let newlineCount = 0;

            while (position > 0 && newlineCount <= maxLines) {
                const size = Math.min(chunkSize, position);
                position -= size;

                const buffer = Buffer.alloc(size);
                await file.read(buffer, 0, size, position);

                content = buffer.toString('utf8') + content;
                newlineCount = content.split('\n').length - 1;
                chunkSize = Math.min(chunkSize * 2, 512 * 1024);
            }

            return content
                .split(/\r?\n/)
                .map((line) => line.trimEnd())
                .filter(Boolean)
                .slice(-maxLines);
        } finally {
            await file.close();
        }
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }

        throw error;
    }
}

export async function readRecentLogs(filters = {}) {
    const tail = normalizeTail(filters.tail);
    const scanLines = Math.min(Math.max(tail * 10, tail), MAX_TAIL_SCAN_LINES);
    const lines = await readTailLines(scanLines);

    return lines
        .map(normalizeLogEntry)
        .filter((entry) => matchesLogFilter(entry, filters))
        .slice(-tail);
}

export const createDebug = createLogger;

export default logger;
