'use strict';

import { EventEmitter } from 'events';
import debugInstance from 'debug';
const debug = debugInstance('canvas:embedd:queue');

/**
 * Sequential, deduped, resumable job queue.
 *
 * Ported from synapsd's EmbeddingQueue but decoupled from the DB: it holds
 * opaque `{ key, job }` entries and calls an injected async `handler(job)`. The
 * worker (ONNX) serializes inference anyway, so a single sequential drain keeps
 * main-thread read/store pressure bounded during bulk imports. A failed job is
 * dropped (not requeued) so a later backfill re-drives it via the presence
 * bitmap; failures are surfaced on the 'error' event.
 */
export default class Queue extends EventEmitter {

    #handler;
    #queue = [];
    #queued = new Set();
    #running = false;
    #stopped = false;
    #paused = false;
    #batchSize;

    /**
     * @param {(jobs: any[]) => Promise<void>} handler receives a BATCH of jobs
     *   (1..batchSize). The handler owns per-job error isolation; a throw drops
     *   the whole batch (surfaced on 'error' with the batch's keys).
     * @param {{batchSize?: number}} [opts]
     */
    constructor(handler, { batchSize = 1 } = {}) {
        super();
        this.#handler = handler;
        this.#batchSize = Math.max(1, batchSize);
    }

    get size() { return this.#queue.length; }
    get isDraining() { return this.#running; }
    get isPaused() { return this.#paused; }

    /**
     * Pause the drain after the in-flight batch finishes. Enqueues still
     * accumulate (dedup intact) so nothing is lost; resume() picks the backlog
     * up where it stopped.
     */
    pause() { this.#paused = true; }

    resume() {
        if (!this.#paused) { return; }
        this.#paused = false;
        this.#kick();
    }

    enqueue(key, job) {
        if (this.#queued.has(key)) { return; }
        this.#queued.add(key);
        this.#queue.push({ key, job });
        this.#kick();
    }

    /** Resolves when the queue has fully drained (or immediately if idle/stopped). */
    async drained() {
        if (this.#stopped) { return; }
        if (!this.#running && this.#queue.length === 0) { return; }
        await new Promise((resolve) => this.once('drained', resolve));
    }

    /**
     * Stop draining permanently. Anything still queued is abandoned (the durable
     * gap ledger re-drives it on the next reconcile), and 'drained' is emitted so
     * a caller awaiting drained() on a stopped/unregistered queue is released
     * instead of hanging forever.
     */
    stop() {
        this.#stopped = true;
        if (!this.#running) { this.emit('drained'); }
    }

    #kick() {
        if (this.#running || this.#stopped || this.#paused) { return; }
        this.#running = true;
        setImmediate(() => this.#drain());
    }

    async #drain() {
        let processed = 0;
        try {
            while (this.#queue.length > 0 && !this.#stopped && !this.#paused) {
                const batch = this.#queue.splice(0, this.#batchSize);
                for (const { key } of batch) { this.#queued.delete(key); }
                try {
                    await this.#handler(batch.map((b) => b.job));
                    processed += batch.length;
                } catch (e) {
                    const keys = batch.map((b) => b.key).join(',');
                    debug(`batch [${keys}] failed: ${e.message}`);
                    this.emit('error', { key: keys, jobs: batch.map((b) => b.job), error: e.message });
                }
            }
        } finally {
            this.#running = false;
            if (this.#queue.length === 0 || this.#stopped) {
                // Stopped with a backlog still counts as drained for waiters:
                // nothing more will run, and the durable gap ledger re-drives
                // the abandoned jobs on the next reconcile.
                debug(`drain done: processed ${processed} jobs${this.#stopped ? ' (stopped)' : ''}`);
                this.emit('drained');
            } else if (!this.#paused) { this.#kick(); }
            // paused with a backlog: stay quiet — resume() re-kicks.
        }
    }
}
