'use strict';

/**
 * Counting semaphore — the global inference gate.
 *
 * Queues are per-workspace (so a 3-doc workspace shows its own 3, not the
 * server's 800), but embedding cost is a SERVER-wide resource: the model
 * runtimes are shared singletons and inference is CPU/GPU-bound. Without a
 * shared gate, N workspaces draining in parallel would multiply exactly the
 * saturation the per-workspace split was never meant to introduce.
 *
 * Default limit 1 reproduces the old single-serial-queue behaviour byte for
 * byte; raise it once inference is remote (a GPU host happily takes several
 * concurrent batches, and the server is no longer the one doing the work).
 */
export default class Semaphore {

    #limit;
    #active = 0;
    #waiters = [];

    constructor(limit = 1) {
        this.#limit = Math.max(1, Number(limit) || 1);
    }

    get limit() { return this.#limit; }
    get active() { return this.#active; }
    get waiting() { return this.#waiters.length; }

    async acquire() {
        if (this.#active < this.#limit) { this.#active++; return; }
        await new Promise((resolve) => this.#waiters.push(resolve));
        this.#active++;
    }

    release() {
        this.#active = Math.max(0, this.#active - 1);
        const next = this.#waiters.shift();
        if (next) { next(); }
    }

    /** Run `fn` holding a permit. Releases on both success and failure. */
    async run(fn) {
        await this.acquire();
        try { return await fn(); }
        finally { this.release(); }
    }
}
