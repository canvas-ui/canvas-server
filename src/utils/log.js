/**
 * Canvas Logger - Pino-based logging facility
 */

import pino from 'pino';
import path from 'path';
import { env } from '../env.js';

const isDev = process.env.NODE_ENV !== 'production';
const logFile = path.join(env.server.home, 'log', 'canvas-server.log');

// Always log to file + console (pretty in dev, JSON in prod)
const transport = pino.transport({
    targets: [
        // File transport - always enabled
        { target: 'pino/file', options: { destination: logFile, mkdir: true }, level: 'debug' },
        // Console transport
        isDev
            ? { target: 'pino-pretty', options: { colorize: true }, level: 'debug' }
            : { target: 'pino/file', options: { destination: 1 }, level: 'info' } // fd 1 = stdout
    ]
});

export const logger = pino({
    level: process.env.LOG_LEVEL || env.server.logLevel || 'info',
}, transport);

export const createLogger = (name) => logger.child({ module: name });

// Backwards compatibility alias for existing code using debug-style imports
export const createDebug = createLogger;

export default logger;
