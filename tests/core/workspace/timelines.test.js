import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

import Workspace from '../../../src/core/workspace/Workspace.js';
import {
    WORKSPACE_LAYOUTS,
    workspaceInternals,
    workspaceServices,
} from '../../../src/core/workspace/lib/constants.js';

/**
 * Parametrized timelines at the workspace layer:
 *
 *  - quantum (finest membership granularity) is set through the workspace,
 *    validated by the engine, persisted in the config store, and re-applied
 *    when the workspace reopens — synapsd itself persists nothing;
 *  - multi-position entries: the primary interval is sortable BSI state, the
 *    extra positions land in the tiled membership plane, and both answer the
 *    same query surface;
 *  - decomposeTimelineRange exposes the covering the plane stores/probes.
 */

describe('workspace parametrized timelines', () => {
    let root;
    let store;
    let ws;

    const makeWorkspace = () => new Workspace({
        rootPath: root,
        configStore: {
            store,
            get: (key, fallback) => (store[key] !== undefined ? store[key] : fallback),
            set: (key, value) => { store[key] = value; },
            delete: (key) => { delete store[key]; },
        },
        logger: { info() {}, warn() {}, debug() {}, error() {} },
    });

    before(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-timelines-'));
        store = {
            id: 'ws-tl-1',
            name: 'ws-tl',
            owner: 'user-1',
            layout: WORKSPACE_LAYOUTS.FULL,
            internals: { ...workspaceInternals(WORKSPACE_LAYOUTS.FULL) },
            services: workspaceServices(WORKSPACE_LAYOUTS.FULL),
        };
        ws = makeWorkspace();
        await ws.start();
    });

    after(async () => {
        await ws?.stop().catch(() => {});
        if (root) { await fs.remove(root); }
    });

    test('setTimelineQuantum validates via the engine, normalizes, and persists', () => {
        // Alias input; engine normalizes to the canonical scale name.
        const normalized = ws.setTimelineQuantum('geology', 'myr');
        assert.equal(normalized, 'Myr');
        assert.equal(ws.getTimelineQuantum('geology'), 'Myr');
        assert.equal(store.timelines.quantum.geology, 'Myr');

        // Sub-day quantums are out of contract — refused BEFORE persisting.
        assert.throws(() => ws.setTimelineQuantum('chat', 'second'), /quantum/i);
        assert.equal(store.timelines.quantum.chat, undefined);

        // Unconfigured timelines fall back to the engine default.
        assert.equal(ws.getTimelineQuantum('anything'), 'day');
    });

    test('multi-position entries: primary + membership positions answer the same queries', async () => {
        const doc = await ws.put({
            schema: 'data/schema/note',
            data: { title: 'Rome', content: 'Rome' },
            timelines: [
                { timeline: 'wikipedia', start: '-0509', end: '-0027', ref: 'republic' },
                { timeline: 'wikipedia', start: '1453', ref: 'fall' },
            ],
        });
        const id = doc.id ?? doc;

        const republic = await ws.queryTimeline('wikipedia', { start: '-0400', end: '-0300' });
        assert.deepEqual(republic, [id]);
        const fall = await ws.queryTimeline('wikipedia', { start: '1453', end: '1453' });
        assert.deepEqual(fall, [id]);
        const gap = await ws.queryTimeline('wikipedia', { start: '0800', end: '1200' });
        assert.deepEqual(gap, []);

        // The row keeps the entries verbatim — ref is opaque and returned as-is.
        const { data: [stored] } = await ws.getDocumentsByIdArray([id]);
        assert.deepEqual((stored.timelines || []).map((t) => t.ref), ['republic', 'fall']);
    });

    test('manual multi-position entries insert and remove symmetrically', async () => {
        const doc = await ws.put({
            schema: 'data/schema/note',
            data: { title: 'Manual', content: 'Manual' },
        });
        const id = doc.id ?? doc;

        await ws.insertTimelineEntry('manual', id, { start: '1900', end: '1910' });
        await ws.insertTimelineEntries('manual', id, [{ start: '1950', end: '1960' }]);

        assert.deepEqual(await ws.queryTimeline('manual', { start: '1905', end: '1905' }), [id]);
        assert.deepEqual(await ws.queryTimeline('manual', { start: '1955', end: '1955' }), [id]);

        await ws.removeTimelineEntry('manual', id, { intervals: [{ start: '1950', end: '1960' }] });
        assert.deepEqual(await ws.queryTimeline('manual', { start: '1905', end: '1905' }), []);
        assert.deepEqual(await ws.queryTimeline('manual', { start: '1955', end: '1955' }), []);
    });

    test('decomposeTimelineRange exposes the quantum covering', () => {
        const { quantum, cells } = ws.decomposeTimelineRange('geology', { start: '5 MYA', end: '3 MYA' });
        assert.equal(quantum, 'Myr');
        assert.deepEqual(cells.map((c) => `${c.scale}:${c.cell}`), ['Myr:-5', 'Myr:-4', 'Myr:-3']);

        // Default-quantum timeline: a whole year collapses to one year cell.
        const year = ws.decomposeTimelineRange('anything', { start: '2020', end: '2020' });
        assert.equal(year.quantum, 'day');
        assert.deepEqual(year.cells, [{ scale: 'year', cell: '50' }]);
    });

    test('quantum survives a workspace restart (config → Db constructor)', async () => {
        await ws.stop();
        ws = makeWorkspace();
        await ws.start();

        assert.equal(ws.getTimelineQuantum('geology'), 'Myr');
        // And the reopened index still answers the deep-time membership query.
        const hits = await ws.queryTimeline('wikipedia', { start: '1453', end: '1453' });
        assert.equal(hits.length, 1);
    });
});
