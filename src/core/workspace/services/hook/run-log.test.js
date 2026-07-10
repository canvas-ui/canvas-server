import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import HookRunLog, { buildReplayEnvelope } from './run-log.js';

describe('HookRunLog', () => {
    let rootPath;

    beforeEach(() => {
        rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'run-log-'));
    });

    afterEach(() => {
        fs.rmSync(rootPath, { recursive: true, force: true });
    });

    test('append + query round-trips records newest first', async () => {
        const log = new HookRunLog(rootPath);
        log.append({ event: 'document.inserted', handlerType: 'rule', handler: 'a', status: 'ok', durationMs: 5, docIds: [1] });
        log.append({ event: 'document.inserted', handlerType: 'hook', handler: 'b.js', status: 'error', error: 'boom', durationMs: 9, docIds: [2] });

        const runs = await log.query();
        assert.equal(runs.length, 2);
        assert.equal(runs[0].handler, 'b.js'); // newest first
        assert.equal(runs[1].handler, 'a');
        assert.ok(runs[0].runId && runs[0].ts);
        assert.equal(runs[0].trigger, 'event');
    });

    test('filters: failed / handler / event / runId', async () => {
        const log = new HookRunLog(rootPath);
        log.append({ event: 'document.inserted', handlerType: 'rule', handler: 'boss-mail', status: 'ok' });
        const failedId = log.append({ event: 'document.updated', handlerType: 'hook', handler: 'x.js', status: 'error', error: 'nope' });

        assert.equal((await log.query({ failed: true })).length, 1);
        assert.equal((await log.query({ handler: 'boss' }))[0].handler, 'boss-mail');
        assert.equal((await log.query({ event: 'document.updated' })).length, 1);
        assert.equal((await log.get(failedId)).error, 'nope');
        assert.equal(await log.get('missing'), null);
    });

    test('rotation keeps one previous generation and query spans both', async () => {
        const log = new HookRunLog(rootPath, { maxBytes: 400 });
        for (let i = 0; i < 10; i++) {
            log.append({ event: 'e', handlerType: 'rule', handler: `h${i}`, status: 'ok' });
        }
        assert.ok(fs.existsSync(path.join(rootPath, 'var/hooks/runs.jsonl.1')));

        const all = await log.query({ limit: 100 });
        assert.ok(all.length >= 4); // live + rotated generation (oldest gen dropped)
        assert.equal(all[0].handler, 'h9'); // newest still first
    });

    test('long error/output tails are clipped to 1 KiB', async () => {
        const log = new HookRunLog(rootPath);
        log.append({ event: 'e', handlerType: 'hook', handler: 'h', status: 'error', error: 'x'.repeat(5000), outputTail: 'y'.repeat(5000) });
        const [run] = await log.query();
        assert.ok(run.error.length <= 1025);
        assert.ok(run.outputTail.length <= 1025);
    });

    test('buildReplayEnvelope strips the document body to an id/schema stub', () => {
        const envelope = buildReplayEnvelope('document.inserted', {
            id: 7,
            eventId: 'e7',
            document: { id: 7, schema: 'data/abstraction/email', data: { body: 'x'.repeat(10000) } },
            context: { paths: ['/inbox'] },
        });
        assert.equal(envelope.event, 'document.inserted');
        assert.deepEqual(envelope.payload.document, { id: 7, schema: 'data/abstraction/email' });
        assert.equal(envelope.payload.eventId, 'e7');
        assert.deepEqual(envelope.payload.context, { paths: ['/inbox'] });
    });
});
