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

    enqueue(key, job) {
        if (this.#queued.has(key)) { return; }
        this.#queued.add(key);
        this.#queue.push({ key, job });
        this.#kick();
    }

    /** Resolves when the queue has fully drained (or immediately if idle). */
    async drained() {
        if (!this.#running && this.#queue.length === 0) { return; }
        await new Promise((resolve) => this.once('drained', resolve));
    }

    stop() { this.#stopped = true; }

    #kick() {
        if (this.#running || this.#stopped) { return; }
        this.#running = true;
        setImmediate(() => this.#drain());
    }

    async #drain() {
        let processed = 0;
        try {
            while (this.#queue.length > 0 && !this.#stopped) {
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
            if (this.#queue.length === 0) {
                debug(`drain done: processed ${processed} jobs`);
                this.emit('drained');
            } else { this.#kick(); }
        }
    }
}
