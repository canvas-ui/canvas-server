'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Inferd from '../../../src/services/inferd/src/index.js';
import Semaphore from '../../../src/services/inferd/src/semaphore.js';

// A workspace adapter whose docs are all "gone" (resolveInput → null): the queue
// runs the full drain path without ever reaching a provider, so these tests
// exercise scheduling with no model anywhere near them.
function tracker(id, seen) {
    return {
        resolveInput: async (docId) => { seen.push(`${id}:${docId}`); return null; },
        storeVectors: async () => {},
    };
}

test('inferd: each workspace owns its queue — backlogs never mix', async () => {
    const e = new Inferd();
    const seen = [];
    e.registerWorkspace('a', tracker('a', seen));
    e.registerWorkspace('b', tracker('b', seen));
    e.pause();   // hold everything so the counts can be inspected mid-flight

    e.enqueue('a', 1);
    e.enqueue('a', 2);
    e.enqueue('b', 9);

    // The old shared queue reported 3 pending to BOTH workspaces — the exact
    // "my 3-doc workspace shows 800 pending" complaint this split fixes.
    assert.equal(e.workspaceStatus('a').pending, 2);
    assert.equal(e.workspaceStatus('b').pending, 1);

    const status = await e.status();
    assert.equal(status.queue.pending, 3, 'the server-wide rollup still totals them');
    assert.deepEqual(Object.keys(status.queues).sort(), ['a', 'b']);
    assert.equal(status.queues.a.pending, 2);

    e.resume();
    await e.drained();
    assert.deepEqual(seen.sort(), ['a:1', 'a:2', 'b:9']);
    await e.stop();
});

test('inferd: pausing one workspace leaves the others draining', async () => {
    const e = new Inferd();
    const seen = [];
    e.registerWorkspace('a', tracker('a', seen));
    e.registerWorkspace('b', tracker('b', seen));

    e.pause('a');
    e.enqueue('a', 1);
    e.enqueue('b', 2);

    await e.drained('b');
    assert.deepEqual(seen, ['b:2'], 'b drained while a stayed held');
    assert.equal(e.workspaceStatus('a').pending, 1);
    assert.equal(e.workspaceStatus('a').paused, true);
    assert.equal(e.workspaceStatus('b').paused, false);

    e.resume('a');
    await e.drained('a');
    assert.deepEqual(seen.sort(), ['a:1', 'b:2']);
    await e.stop();
});

test('inferd: onQueueDrained fires only for the workspace that drained', async () => {
    // The shared queue used to wake EVERY registered workspace on any drain, so
    // one note saved in workspace A triggered a compact/ANN-rebuild pass in B.
    const e = new Inferd();
    const drained = [];
    const adapter = (id) => ({
        resolveInput: async () => null,
        storeVectors: async () => {},
        onQueueDrained: () => { drained.push(id); },
    });
    e.registerWorkspace('a', adapter('a'));
    e.registerWorkspace('b', adapter('b'));

    e.enqueue('a', 1);
    await e.drained('a');
    assert.deepEqual(drained, ['a']);
    await e.stop();
});

test('inferd: a workspace registered while globally paused does not start draining', async () => {
    const e = new Inferd();
    const seen = [];
    e.pause();
    e.registerWorkspace('late', tracker('late', seen));
    e.enqueue('late', 1);
    assert.equal(e.workspaceStatus('late').paused, true);
    assert.deepEqual(seen, []);

    e.resume();
    await e.drained();
    assert.deepEqual(seen, ['late:1']);
    await e.stop();
});

test('inferd: unregistering a workspace drops its queue and releases waiters', async () => {
    const e = new Inferd();
    const seen = [];
    e.registerWorkspace('a', tracker('a', seen));
    e.pause('a');
    e.enqueue('a', 1);

    e.unregisterWorkspace('a');
    assert.equal(e.workspaceStatus('a'), null);
    // Abandoned jobs are re-driven by the durable gap ledger on the next
    // reconcile, so a waiter must not hang on a queue that will never run.
    await e.drained();
    e.enqueue('a', 2);
    assert.deepEqual(seen, [], 'an unregistered workspace accepts nothing');
    await e.stop();
});

test('inferd: status reports the shared inference gate', async () => {
    const e = new Inferd({ concurrency: 3 });
    const status = await e.status();
    assert.equal(status.concurrency.limit, 3);
    assert.equal(status.concurrency.active, 0);
    await e.stop();
});

// ── The gate itself ──────────────────────────────────────────────────────────

test('semaphore: default limit 1 serializes, matching the old single queue', async () => {
    const gate = new Semaphore(1);
    const order = [];
    const task = (id) => gate.run(async () => {
        order.push(`${id}:start`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`${id}:end`);
    });
    await Promise.all([task('a'), task('b')]);
    assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end']);
});

test('semaphore: never exceeds its limit under load', async () => {
    const gate = new Semaphore(2);
    let inFlight = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 8 }, () => gate.run(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
    })));
    assert.equal(peak, 2);
    assert.equal(gate.active, 0, 'permits are returned');
});

test('semaphore: a throwing task still returns its permit', async () => {
    const gate = new Semaphore(1);
    await assert.rejects(() => gate.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(gate.active, 0);
    // The gate is not wedged — the next task runs.
    assert.equal(await gate.run(async () => 'ok'), 'ok');
});
