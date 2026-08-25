'use strict';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WORKSPACE_DIRECTORIES } from '../../lib/constants.js';

/**
 * Per-workspace hook/rule run log.
 *
 * Every handler execution (JS hook file or declarative rule) appends one JSON
 * line to `{WORKSPACE_ROOT}/var/hooks/runs.jsonl` — the observability surface
 * behind `GET /workspaces/:id/hooks/runs`, the UI Runs tab and
 * `canvas ws <name> hooks runs`. Records are also the replay source: they keep
 * the triggering envelope with the document body stripped to `{ id, schema }`
 * (replay reloads the live document by id).
 *
 * Record shape (one line):
 *   { runId, ts, trigger: 'event'|'backfill'|'replay',
 *     event, eventId, origin, depth, batch,
 *     handlerType: 'hook'|'rule', handler,      // file path rel. hooks/ | rule id
 *     docIds: number[], durationMs,
 *     status: 'ok'|'error'|'skipped', error?, skipReason?,
 *     actions?: [{ action, status, error? }],   // rule runs
 *     outputTail?,                              // first 1 KiB of output text
 *     trace?: [{ t, level, msg }],              // execution log (createRunTrace)
 *     replayEnvelope? }
 *
 * Rotation: when runs.jsonl exceeds maxBytes (5 MiB) it is renamed to
 * runs.jsonl.1 (previous generation overwritten) — bounded at ~2×maxBytes per
 * workspace, no compaction ceremony. Append failures are swallowed (a broken
 * run log must never break dispatch).
 */

const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
const TAIL_CAP = 1024;
// Per-run trace: enough to read an agent exchange back, small enough that a
// chatty rule cannot blow the 5 MiB log through in an afternoon.
const TRACE_MAX_LINES = 300;
const TRACE_LINE_CAP = 2048;

/**
 * A logger that both forwards to the real one and records what it was told,
 * so a run record can carry its own execution trace ("what did the agent get
 * asked, what came back, where did the file land"). `lines` is what gets
 * stored; each entry is { t: ms since the trace started, level, msg }.
 * @param {Object} base - the underlying logger (debug/info/warn/error)
 * @returns {{ logger: Object, lines: Array<{t:number, level:string, msg:string}> }}
 */
export function createRunTrace(base) {
    const started = Date.now();
    const lines = [];
    let dropped = 0;
    const record = (level, args) => {
        const msg = args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
        if (lines.length >= TRACE_MAX_LINES) { dropped++; return; }
        lines.push({ t: Date.now() - started, level, msg: msg.length > TRACE_LINE_CAP ? `${msg.slice(0, TRACE_LINE_CAP)}…` : msg });
    };
    const logger = {};
    for (const level of ['debug', 'info', 'warn', 'error']) {
        logger[level] = (...args) => {
            record(level, args);
            try { base?.[level]?.(...args); } catch { /* never let logging break a run */ }
        };
    }
    logger.trace = (...args) => logger.debug(...args);
    logger.child = () => logger;
    Object.defineProperty(lines, 'dropped', { get: () => dropped, enumerable: false });
    return { logger, lines };
}

const clipTail = (text) => {
    if (text == null) { return undefined; }
    const value = String(text);
    return value.length > TAIL_CAP ? `${value.slice(0, TAIL_CAP)}…` : value;
};

// Envelope stored for replay: same payload minus the (potentially large)
// document body; the id + schema stub keeps records grep-able.
export function buildReplayEnvelope(eventName, payload = {}) {
    const { document, ...rest } = payload && typeof payload === 'object' ? payload : {};
    return {
        event: eventName,
        payload: {
            ...rest,
            ...(document ? { document: { id: document.id ?? rest.id ?? null, schema: document.schema ?? null } } : {}),
        },
    };
}

class HookRunLog {
    #file;
    #dir;
    #maxBytes;
    #size = null; // cached byte size of the live file

    constructor(workspaceRootPath, { maxBytes = MAX_BYTES_DEFAULT } = {}) {
        this.#dir = path.join(workspaceRootPath, WORKSPACE_DIRECTORIES.varHooks);
        this.#file = path.join(this.#dir, 'runs.jsonl');
        this.#maxBytes = maxBytes;
    }

    get filePath() { return this.#file; }

    /**
     * Append one run record. Never throws.
     * @param {Object} record - partial record; runId/ts are filled in
     * @returns {string|null} the runId, or null when the write failed
     */
    append(record) {
        try {
            const full = {
                runId: record.runId || crypto.randomUUID(),
                ts: record.ts || new Date().toISOString(),
                trigger: record.trigger || 'event',
                ...record,
            };
            if (full.outputTail !== undefined) { full.outputTail = clipTail(full.outputTail); }
            if (Array.isArray(full.trace)) {
                const dropped = full.trace.dropped || 0;
                full.trace = full.trace.slice(0, TRACE_MAX_LINES).map((l) => ({ t: l.t, level: l.level, msg: String(l.msg) }));
                if (dropped) { full.trace.push({ t: full.trace[full.trace.length - 1]?.t ?? 0, level: 'warn', msg: `… ${dropped} more line(s) not recorded` }); }
            }
            if (full.error !== undefined && full.error !== null) { full.error = clipTail(full.error); }

            fs.mkdirSync(this.#dir, { recursive: true });
            const line = `${JSON.stringify(full)}\n`;
            this.#rotateIfNeeded(line.length);
            fs.appendFileSync(this.#file, line, 'utf8');
            this.#size = (this.#size ?? 0) + line.length;
            return full.runId;
        } catch {
            this.#size = null; // re-stat next time
            return null;
        }
    }

    #rotateIfNeeded(incomingBytes) {
        if (this.#size === null) {
            try { this.#size = fs.statSync(this.#file).size; }
            catch { this.#size = 0; }
        }
        if (this.#size + incomingBytes <= this.#maxBytes) { return; }
        try { fs.renameSync(this.#file, `${this.#file}.1`); } catch { /* live file may be absent */ }
        this.#size = 0;
    }

    /**
     * Read run records, newest first. Scans the live file plus the rotated
     * generation when the limit is not yet satisfied.
     * @param {Object} opts
     * @param {number} opts.limit - max records (default 50, cap 500)
     * @param {string} opts.handler - filter: handler equals or contains
     * @param {boolean} opts.failed - filter: only status 'error'
     * @param {string} opts.event - filter: event name
     * @param {string} opts.runId - filter: exact run id
     * @returns {Promise<Object[]>}
     */
    async query({ limit = 50, handler, failed, event, runId } = {}) {
        const max = Math.min(Math.max(1, Number(limit) || 50), 500);
        const out = [];

        for (const file of [this.#file, `${this.#file}.1`]) {
            if (out.length >= max) { break; }
            let content;
            try { content = await fs.promises.readFile(file, 'utf8'); }
            catch { continue; }

            const lines = content.split('\n');
            // newest last on disk → walk backwards
            for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
                const line = lines[i].trim();
                if (!line) { continue; }
                let record;
                try { record = JSON.parse(line); } catch { continue; }
                if (runId && record.runId !== runId) { continue; }
                if (failed && record.status !== 'error') { continue; }
                if (event && record.event !== event) { continue; }
                if (handler && !(record.handler === handler || String(record.handler || '').includes(handler))) { continue; }
                out.push(record);
            }
        }
        return out;
    }

    /** Find one record by runId (used by replay). */
    async get(runId) {
        const [record] = await this.query({ runId, limit: 1 });
        return record || null;
    }
}

export default HookRunLog;
