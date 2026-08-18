'use strict';

import crypto from 'node:crypto';

/**
 * Job registry for long-running workspace imports.
 *
 * Pulling a workspace from another canvas-server means: export it there,
 * download a possibly multi-GB archive, extract it, validate it and register
 * it. That routinely runs for minutes, which is longer than an HTTP request
 * survives — Node's own `requestTimeout` defaults to 5 minutes and a reverse
 * proxy in front usually cuts it far sooner (nginx's `proxy_read_timeout` is
 * 60s). The connection dies mid-import and the browser reports a generic
 * network/CORS failure, which is what this replaces: the request returns a job
 * id immediately and the client polls for phase and progress.
 *
 * Jobs are in-memory and therefore do not survive a server restart. That is a
 * deliberate limit, not an oversight — the import itself is not resumable
 * either, so a restart loses the work regardless. Finished jobs are pruned
 * after RETENTION_MS so a client that polls late still sees the outcome.
 */

const RETENTION_MS = 30 * 60 * 1000; // keep finished jobs readable for 30 min

/** Ordered phases, so a client can render progress without knowing the flow. */
export const IMPORT_PHASES = ['resolving', 'exporting', 'downloading', 'extracting', 'loading'];

export class ImportJobs {
  #jobs = new Map(); // id → job

  /**
   * Start `run` in the background and return the job immediately.
   * `run` receives a reporter: { phase(name), progress(received, total) }.
   */
  start(userId, run) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const job = {
      id,
      userId,
      status: 'running',
      phase: 'resolving',
      received: 0,
      total: null,
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#jobs.set(id, job);

    const touch = () => { job.updatedAt = new Date().toISOString(); };
    const reporter = {
      phase: (name) => { job.phase = name; touch(); },
      progress: (received, total) => { job.received = received; job.total = total ?? null; touch(); },
    };

    // Detached on purpose: the HTTP request that created the job is already
    // being answered. Nothing may reject into that request's context.
    Promise.resolve()
      .then(() => run(reporter))
      .then((result) => {
        job.status = 'done';
        job.phase = 'done';
        job.result = result;
      })
      .catch((err) => {
        job.status = 'failed';
        job.error = { message: err?.message || 'Import failed', code: err?.code || null };
      })
      .finally(() => {
        touch();
        this.#schedulePrune(id);
      });

    return this.#publicView(job);
  }

  /** A job, but only for the user who started it. */
  get(userId, id) {
    const job = this.#jobs.get(id);
    if (!job || job.userId !== userId) return null;
    return this.#publicView(job);
  }

  list(userId) {
    return Array.from(this.#jobs.values())
      .filter((job) => job.userId === userId)
      .map((job) => this.#publicView(job))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  #schedulePrune(id) {
    const timer = setTimeout(() => this.#jobs.delete(id), RETENTION_MS);
    // never hold the process open just to forget a finished job
    if (typeof timer.unref === 'function') timer.unref();
  }

  #publicView(job) {
    return {
      id: job.id,
      status: job.status,
      phase: job.phase,
      received: job.received,
      total: job.total,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }
}

export const importJobs = new ImportJobs();
