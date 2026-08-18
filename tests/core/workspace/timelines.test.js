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
 * Timelines at the workspace layer (adaptive floors, synapsd 3.7.0):
 *
 *  - membership tiling is ADAPTIVE — each entry/query tiles at its own
 *    notation-derived floor; no per-timeline granularity config exists, so
 *    nothing timeline-related is persisted in workspace.json anymore;
 *  - multi-position entries: the primary interval is sortable BSI state, the
 *    extra positions land in the tiled membership plane, and both answer the
 *    same query surface;
 *  - decomposeTimelineRange exposes the covering the plane stores/probes;
 *  - getTimelineScales reports the observed (materialized) tiers.
 */

describe('workspace timelines', () => {
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

    test('adaptive floors: the notation carries the precision, no config anywhere', () => {
        // Same timeline, three notations, three floors.
        assert.equal(ws.decomposeTimelineRange('geology', { start: '5 MYA', end: '3 MYA' }).floor, 'Myr');
        assert.equal(ws.decomposeTimelineRange('geology', { start: '1769' }).floor, 'year');
        assert.equal(ws.decomposeTimelineRange('geology', { start: '1769-08-15' }).floor, 'day');
        // Sub-day notation clamps to 'day' (no hour/minute tier yet).
        assert.equal(ws.decomposeTimelineRange('geology', { start: '2026-08-16T14:30:00Z' }).floor, 'day');
        // Nothing timeline-related persists in the workspace config store.
        assert.equal(store.timelines, undefined);
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

    test('decomposeTimelineRange exposes the covering at the range\'s floor', () => {
        const { floor, cells } = ws.decomposeTimelineRange('geology', { start: '5 MYA', end: '3 MYA' });
        assert.equal(floor, 'Myr');
        assert.deepEqual(cells.map((c) => `${c.scale}:${c.cell}`), ['Myr:-5', 'Myr:-4', 'Myr:-3']);

        // A whole year collapses to one year cell.
        const year = ws.decomposeTimelineRange('anything', { start: '2020', end: '2020' });
        assert.equal(year.floor, 'year');
        assert.deepEqual(year.cells, [{ scale: 'year', cell: '50' }]);
    });

    test('open non-primary entries land in the sidecar (several ongoing facts per doc)', async () => {
        const doc = await ws.put({
            schema: 'data/schema/note',
            data: { title: 'Ongoing', content: 'Ongoing' },
            timelines: [
                { timeline: 'facts', start: '1980', end: '1985' },          // primary, bounded
                { timeline: 'facts', start: '66 MYA', end: null },          // ongoing, deep time
                { timeline: 'facts', start: '2000', end: 'ongoing' },       // ongoing, modern
            ],
        });
        const id = doc.id ?? doc;

        assert.deepEqual(await ws.queryTimeline('facts', { start: '1982', end: '1982' }), [id]);
        assert.deepEqual(await ws.queryTimeline('facts', { start: '2030', end: '2030' }), [id]);
        assert.deepEqual(await ws.queryTimeline('facts', { start: '30 MYA', end: '30 MYA' }), [id]);
        assert.deepEqual(await ws.queryTimeline('facts', { start: '70 MYA', end: '70 MYA' }), []);
    });

    test('getTimelineScales reports observed tiers (informational, both planes)', async () => {
        const scales = await ws.getTimelineScales('wikipedia');
        // 'wikipedia' holds year-notation entries: primary BSI tier + year cells.
        assert.ok(scales.includes('year'), `expected year in ${scales}`);
    });

    test('the index needs no config at reopen (rows alone rebuild everything)', async () => {
        await ws.stop();
        ws = makeWorkspace();
        await ws.start();

        // The reopened index still answers the membership query.
        const hits = await ws.queryTimeline('wikipedia', { start: '1453', end: '1453' });
        assert.equal(hits.length, 1);
    });
});
