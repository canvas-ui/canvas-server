import test from 'node:test';
import assert from 'node:assert/strict';
import Context from '../../../src/core/context/lib/Context.js';

function setup(options = {}) {
  const calls = [];
  const tree = (id, type) => ({ id, type,
    async insertPath(path) { calls.push(['insert', id, path]); return []; },
    async lockPath(path) { calls.push(['lock', id, path]); },
    async unlockPath(path) { calls.push(['unlock', id, path]); },
  });
  const contextTree = tree('ctx', 'context');
  const directory = tree('dir', 'directory');
  const trees = { ctx: contextTree, context: contextTree, dir: directory, directory };
  const workspace = {
    id: 'ws', name: 'work', onAny() {}, emit() {},
    getTree: name => trees[name],
    getDefaultContextTree: () => contextTree,
    getContextTree: name => trees[name],
    getDirectoryTree: name => trees[name],
  };
  const context = new Context('work://old', { id: 'focus', userId: 'user', workspace, workspaceManager: {},
    contextManager: { async saveContext(_user, ctx) { calls.push(['save', ctx.treeId, ctx.url]); } }, ...options });
  return { context, calls, directory };
}

test('switching trees prepares destination, releases old lock, locks and persists selected tree', async () => {
  const { context, calls } = setup();
  await context.setUrl('work://old', { treeName: 'directory' });
  assert.equal(context.treeId, 'dir');
  assert.deepEqual(calls, [
    ['insert', 'dir', '/old'], ['unlock', 'ctx', '/old'], ['lock', 'dir', '/old'], ['save', 'dir', 'work://old'],
  ]);
  await context.setUrl('work://next', { treeName: 'context' });
  assert.equal(context.treeId, 'ctx');
  assert.equal(context.path, '/next');
});

test('failed destination preparation preserves the previous URL, tree and lock', async () => {
  const { context, calls, directory } = setup();
  directory.insertPath = async () => { throw new Error('Cannot create path'); };
  await assert.rejects(context.setUrl('work://next', { treeName: 'directory' }), /Cannot create/);
  assert.equal(context.treeId, 'ctx');
  assert.equal(context.url, 'work://old');
  assert.deepEqual(calls, []);
});

test('locked, invalid, cross-workspace and out-of-base destinations are rejected', async () => {
  for (const [options, url, treeName, pattern] of [
    [{ locked: true }, 'work://next', 'directory', /locked/],
    [{}, 'work://next', 'missing', /Unsupported/],
    [{}, 'elsewhere://next', 'directory', /current workspace/],
    [{ baseUrl: 'work://old' }, 'work://next', 'directory', /outside/],
  ]) {
    const { context, calls } = setup(options);
    await assert.rejects(context.setUrl(url, { treeName }), pattern);
    assert.equal(context.treeId, 'ctx');
    assert.deepEqual(calls, []);
  }
});

test('plain URL edits keep the existing tree binding', async () => {
  const { context } = setup({ treeId: 'dir' });
  await context.setUrl('work://next');
  assert.equal(context.treeId, 'dir');
});
