'use strict';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Per-workspace pending-action (approval) store.
 *
 * Automation that needs human sign-off proposes its side effect instead of
 * executing it: the proposal lands here, the review UI / CLI lists it, a
 * decision (approve / decline, optionally amended) resolves it. Approval
 * executes the stored actions through the ordinary rule-action pipeline with
 * the original provenance chain, so cascade guards and the run log behave as
 * if the handler had executed directly.
 *
 * Storage: `{WORKSPACE_ROOT}/var/hooks/pending.jsonl` (+ `.1` rotation) —
 * same append-only JSONL discipline as run-log.js. Records are immutable;
 * a status transition appends a superseding FULL record with the same
 * `actionId`, and reads resolve last-write-wins per actionId. This keeps the
 * file crash-safe and makes rotation harmless (every record is
 * self-contained).
 *
 * Record shape (one line):
 *   { actionId, ts, status: 'pending'|'approved'|'declined'|'failed'|'expired',
 *     handlerType: 'rule'|'hook', handler,        // rule id | hook file rel. hooks/
 *     event, envelope,                            // replay envelope (doc → {id, schema})
 *     provenance: { origin, causedBy, depth },    // of the TRIGGERING event
 *     title, summary,
 *     actions: [ { action, ... } ],               // rule-action objects, executed on approve
 *     editable: ['actions.0.draft.body', ...],    // JSON paths the reviewer may amend
 *     expiresAt?,                                 // ISO ts; pending past this = expired
 *     decidedAt?, decidedBy?, amended?,           // set by the deciding append
 *     result? }                                   // per-action outcomes after execution
 */

const MAX_BYTES_DEFAULT = 5 * 1024 * 1024;
const STATUSES = Object.freeze(['pending', 'approved', 'declined', 'failed', 'expired']);

// A pending record whose expiresAt has passed reads as expired (no eager
// sweep needed — expiry is a read-time view, persisted lazily on decision).
function effectiveStatus(record, now = Date.now()) {
    if (record.status === 'pending' && record.expiresAt && Date.parse(record.expiresAt) < now) {
        return 'expired';
    }
    return record.status;
}

class PendingActionStore {
    #file;
    #dir;
    #maxBytes;
    #size = null;

    // Takes the ALREADY-RESOLVED dir (workspace.varHooksPath), not the
    // workspace root: joining the `full` layout's constant onto the root put
    // this log in the user's own drive for a `home`-layout workspace, where
    // the root IS that drive and the internals belong under `.workspace/`.
    constructor(varHooksPath, { maxBytes = MAX_BYTES_DEFAULT } = {}) {
        this.#dir = varHooksPath;
        this.#file = path.join(this.#dir, 'pending.jsonl');
        this.#maxBytes = maxBytes;
    }

    get filePath() { return this.#file; }

    static get statuses() { return STATUSES; }

    /**
     * Append a new proposal. Never throws.
     * @param {Object} record - partial record; actionId/ts/status filled in
     * @returns {Object|null} the full record, or null when the write failed
     */
    propose(record) {
        const full = {
            actionId: record.actionId || `pa_${crypto.randomUUID()}`,
            ts: record.ts || new Date().toISOString(),
            status: 'pending',
            ...record,
        };
        return this.#append(full) ? full : null;
    }

    /**
     * Append a superseding record for a status transition. The caller passes
     * the CURRENT record (from get()) plus the fields that change.
     * @returns {Object|null} the superseding record, or null on write failure
     */
    supersede(record, changes) {
        const full = { ...record, ...changes, ts: new Date().toISOString() };
        return this.#append(full) ? full : null;
    }

    #append(full) {
        try {
            fs.mkdirSync(this.#dir, { recursive: true });
            const line = `${JSON.stringify(full)}\n`;
            this.#rotateIfNeeded(line.length);
            fs.appendFileSync(this.#file, line, 'utf8');
            this.#size = (this.#size ?? 0) + line.length;
            return true;
        } catch {
            this.#size = null;
            return false;
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
     * Read pending-action records, newest proposal first, last-write-wins per
     * actionId (a decided action reports its decided state, not the original
     * pending record).
     * @param {Object} opts
     * @param {string} opts.status - filter by effective status
     * @param {string} opts.handler - filter: handler equals or contains
     * @param {number} opts.limit - max records (default 100, cap 500)
     * @returns {Promise<Object[]>}
     */
    async query({ status, handler, limit = 100 } = {}) {
        const max = Math.min(Math.max(1, Number(limit) || 100), 500);
        const byId = new Map(); // actionId -> newest record (walk is newest-first)

        for (const file of [this.#file, `${this.#file}.1`]) {
            let content;
            try { content = await fs.promises.readFile(file, 'utf8'); }
            catch { continue; }

            const lines = content.split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line) { continue; }
                let record;
                try { record = JSON.parse(line); } catch { continue; }
                if (!record.actionId || byId.has(record.actionId)) { continue; }
                byId.set(record.actionId, record);
            }
        }

        const now = Date.now();
        const out = [];
        for (const record of byId.values()) {
            const view = { ...record, status: effectiveStatus(record, now) };
            if (status && view.status !== status) { continue; }
            if (handler && !(view.handler === handler || String(view.handler || '').includes(handler))) { continue; }
            out.push(view);
            if (out.length >= max) { break; }
        }
        return out;
    }

    /** Current state of one action (last-write-wins), or null. */
    async get(actionId) {
        if (!actionId) { return null; }
        for (const file of [this.#file, `${this.#file}.1`]) {
            let content;
            try { content = await fs.promises.readFile(file, 'utf8'); }
            catch { continue; }
            const lines = content.split('\n');
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (!line || !line.includes(actionId)) { continue; }
                try {
                    const record = JSON.parse(line);
                    if (record.actionId === actionId) {
                        return { ...record, status: effectiveStatus(record) };
                    }
                } catch { continue; }
            }
        }
        return null;
    }

    /** Count of actionable (pending, unexpired) proposals — the UI badge. */
    async pendingCount() {
        const pending = await this.query({ status: 'pending', limit: 500 });
        return pending.length;
    }
}

/**
 * Apply reviewer amendments to a record's actions, restricted to the
 * `editable` JSON-path allowlist. Paths are dot-notation into the record
 * (e.g. 'actions.0.draft.body'). Throws on any path outside the allowlist.
 * @param {Object} record
 * @param {Object} amend - { '<json-path>': value }
 * @returns {Object} new record with amended actions (original untouched)
 */
export function applyAmendments(record, amend) {
    if (!amend || typeof amend !== 'object' || !Object.keys(amend).length) { return record; }
    const allowed = new Set(Array.isArray(record.editable) ? record.editable : []);
    const next = structuredClone({ actions: record.actions });

    for (const [keyPath, value] of Object.entries(amend)) {
        if (!allowed.has(keyPath)) {
            throw new Error(`Field "${keyPath}" is not amendable for this action`);
        }
        const keys = keyPath.split('.');
        let target = next;
        for (let i = 0; i < keys.length - 1; i++) {
            target = target?.[keys[i]];
            if (target == null || typeof target !== 'object') {
                throw new Error(`Amend path "${keyPath}" does not resolve`);
            }
        }
        target[keys[keys.length - 1]] = value;
    }
    return { ...record, actions: next.actions, amended: true };
}

export default PendingActionStore;
