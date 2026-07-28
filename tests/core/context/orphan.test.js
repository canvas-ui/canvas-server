import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import Jim from '../../../src/utils/jim/index.js';
import ContextManager from '../../../src/core/context/index.js';
import { workspaceNotFound } from '../../../src/core/workspace/lib/errors.js';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function makeEnv({ workspaces = [] } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'));
  const jim = new Jim({
    rootPath: path.join(tmp, 'db'),
    driver: 'conf',
    driverOptions: { accessPropertiesByDotNotation: false },
    logger: quietLogger,
  });

  // Stub workspace manager: every workspace lookup fails with NOT_FOUND —
  // exactly the state of a context whose workspace was deleted/moved away.
  const workspaceManager = {
    users: {
      indexStore: { store: { u1: { id: 'u1', email: 'u1@test.local' } } },
      async get(id) { return { id, email: 'u1@test.local' }; },
      async resolveId(x) { return x === 'u1' ? 'u1' : null; },
    },
    resolveWorkspaceId() { return null; },
    async getWorkspace() { return null; },
    async getWorkspaceOrThrow(workspaceId) { throw workspaceNotFound(`Workspace not found: ${workspaceId}`); },
    async listWorkspaces() { return workspaces; },
  };

  const manager = new ContextManager({ indexFactory: jim, workspaceManager });
  await manager.initialize();
  return { tmp, jim, manager };
}

function seedContext(jim, userId, contextId, extra = {}) {
  jim.getOrCreateIndex('contexts', { scope: `users/${userId}` }).set(contextId, {
    id: contextId,
    userId,
    url: '/',
    workspaceId: 'dddddddd-1111-2222-3333-444444444444',
    workspaceName: 'gone',
    acl: {},
    ...extra,
  });
}

test('getContext on a context whose workspace is gone marks it orphaned', async (t) => {
  const { tmp, jim, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  seedContext(jim, 'u1', 'default');

  await assert.rejects(() => manager.getContext('u1', 'default'), /orphaned/);

  const stored = jim.getOrCreateIndex('contexts', { scope: 'users/u1' }).get('default');
  assert.equal(stored.status, 'orphaned');
  assert.ok(stored.orphanedAt);
});

test('orphaned contexts are listed (with status) and never throw', async (t) => {
  const { tmp, jim, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  seedContext(jim, 'u1', 'default', { status: 'orphaned', orphanedAt: '2026-01-01T00:00:00.000Z' });

  const contexts = await manager.listUserContexts('u1');
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].status, 'orphaned');
  assert.equal(contexts[0].workspaceActive, false);
});

test('the default context is removable — including when orphaned', async (t) => {
  const { tmp, jim, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  seedContext(jim, 'u1', 'default', { status: 'orphaned' });

  const removed = await manager.removeContext('u1', 'default');
  assert.equal(removed, true);
  assert.equal(jim.getOrCreateIndex('contexts', { scope: 'users/u1' }).has('default'), false);
  assert.equal(await manager.listUserContexts('u1').then((c) => c.length), 0);
});

test('createContext with zero workspaces fails with a clear error', async (t) => {
  const { tmp, manager } = await makeEnv({ workspaces: [] });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  await assert.rejects(
    () => manager.createContext('u1', '/', { id: 'default' }),
    /has no workspaces/
  );
});
