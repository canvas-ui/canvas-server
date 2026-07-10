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
 *     replayEnvelope? }
 *
 * Rotation: when runs.jsonl exceeds maxBytes (5 MiB) it is renamed to
 * runs.jsonl.1 (previous generation overwritten) — bounded at ~2×maxBytes per
 * workspace, no compaction ceremony. Append failures are swallowed (a broken
 * run log must never break dispatch).
 */

const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
const TAIL_CAP = 1024;

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
