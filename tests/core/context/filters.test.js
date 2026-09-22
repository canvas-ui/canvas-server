import test from 'node:test';
import assert from 'node:assert/strict';
import Context from '../../../src/core/context/lib/Context.js';

function setup() {
  const calls = [];
  const tree = { id: 'tree', type: 'context', getLayerForPath: () => ({ type: 'canvas', querySpec: { features: { allOf: ['tag/canvas'] }, filters: ['geo:bbox:0,0,1,1'] } }) };
  const workspace = { id: 'ws', name: 'work', isActive: true, onAny() {}, emit() {},
    getDefaultContextTree: () => tree, getTree: () => tree, getContextTree: () => tree,
    async list(spec) { calls.push(['list', spec]); return []; },
    async search(spec) { calls.push(['search', spec]); return []; },
    async searchRefined(queries, spec, options) { calls.push(['refined', spec, queries, options]); return []; },
  };
  const context = new Context('work://photos', { id: 'focus', userId: 'owner', workspace, workspaceManager: {}, contextManager: {}, features: { allOf: ['tag/saved'] } });
  return { context, calls };
}

test('context toolbox preview passes all filters, sorting and image IDs without reapplying saved canvas filters', async () => {
  const { context, calls } = setup();
  const features = { allOf: ['tag/current'], anyOf: ['data/schema/file'], noneOf: ['tag/excluded'] };
  const filters = ['geo:near:48,17,100m', 't:crud:created:today'];
  await context.list('owner', { features, filters, options: { ids: [4, 9], sortBy: 'content', order: 'asc' }, applyContextSpec: false });
  const spec = calls[0][1];
  assert.deepEqual(spec.features, features);
  assert.deepEqual(spec.filters, filters);
  assert.deepEqual(spec.ids, [4, 9]);
  assert.equal(spec.sortBy, 'content');
  assert.equal(spec.order, 'asc');
  assert.deepEqual(spec.context, { tree: 'tree', path: '/photos' });
  assert.equal(spec.applyCanvasQuerySpec, false);
});

test('stacked search keeps the context scope and caller filters on every refinement', async () => {
  const { context, calls } = setup();
  await context.search('owner', { query: ['cats', 'night'], filters: ['geo:missing'], options: { ids: [9], limit: 10 }, applyContextSpec: false });
  assert.equal(calls[0][0], 'refined');
  assert.deepEqual(calls[0][2], ['cats', 'night']);
  assert.deepEqual(calls[0][1].context, { tree: 'tree', path: '/photos' });
  assert.deepEqual(calls[0][1].filters, ['geo:missing']);
  assert.deepEqual(calls[0][1].ids, [9]);
});

test('normal bound clients still inherit saved context and canvas filters', async () => {
  const { context, calls } = setup();
  await context.list('owner', {});
  assert.deepEqual(calls[0][1].features.allOf, ['tag/saved', 'tag/canvas']);
  assert.deepEqual(calls[0][1].filters, ['geo:bbox:0,0,1,1']);
  await assert.rejects(context.search('stranger', { query: ['cats', 'night'] }), /Access denied/);
});
