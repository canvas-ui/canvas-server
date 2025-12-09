/**
 * Canvas Logger - Pino-based logging facility
 */

import pino from 'pino';
import path from 'path';
import { env } from '../env.js';

const isDev = process.env.NODE_ENV !== 'production';

// Configure transport based on environment
const transport = isDev
    ? { target: 'pino-pretty', options: { colorize: true } }
    : { target: 'pino/file', options: { destination: path.join(env.server.home, 'log', 'canvas.log'), mkdir: true } };

export const logger = pino({
    level: process.env.LOG_LEVEL || env.server.logLevel || 'info',
    transport
});

export const createLogger = (name) => logger.child({ module: name });

// Backwards compatibility alias for existing code using debug-style imports
export const createDebug = createLogger;

export default logger;
