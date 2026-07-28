import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';

import Jim from '../../src/utils/jim/index.js';

function makeJim() {
  const rootPath = mkdtempSync(path.join(os.tmpdir(), 'jim-test-'));
  const jim = new Jim({
    rootPath,
    driver: 'conf',
    driverOptions: { accessPropertiesByDotNotation: false },
  });
  return { jim, rootPath };
}

test('scoped index files land under rootPath/<scope>/<name>.json', (t) => {
  const { jim, rootPath } = makeJim();
  t.after(() => rmSync(rootPath, { recursive: true, force: true }));

  const index = jim.createIndex('workspaces', { scope: 'users/abc123' });
  index.set('ws-1', { id: 'ws-1' });

  assert.ok(existsSync(path.join(rootPath, 'users', 'abc123', 'workspaces.json')));
  assert.deepEqual(index.get('ws-1'), { id: 'ws-1' });
});

test('scoped and unscoped indexes with the same name do not collide', (t) => {
  const { jim, rootPath } = makeJim();
  t.after(() => rmSync(rootPath, { recursive: true, force: true }));

  const global = jim.createIndex('workspaces');
  const scoped = jim.createIndex('workspaces', { scope: 'users/u1' });
  global.set('a', 1);
  scoped.set('b', 2);

  assert.equal(global.has('b'), false);
  assert.equal(scoped.has('a'), false);
});

test('getOrCreateIndex is idempotent and returns the same instance', (t) => {
  const { jim, rootPath } = makeJim();
  t.after(() => rmSync(rootPath, { recursive: true, force: true }));

  const first = jim.getOrCreateIndex('contexts', { scope: 'users/u1' });
  const second = jim.getOrCreateIndex('contexts', { scope: 'users/u1' });
  assert.equal(first, second);
});

test('hasIndexFile reflects on-disk presence', (t) => {
  const { jim, rootPath } = makeJim();
  t.after(() => rmSync(rootPath, { recursive: true, force: true }));

  assert.equal(jim.hasIndexFile('workspaces', { scope: 'users/u2' }), false);
  const index = jim.getOrCreateIndex('workspaces', { scope: 'users/u2' });
  index.set('x', true); // Conf writes lazily on first set
  assert.equal(jim.hasIndexFile('workspaces', { scope: 'users/u2' }), true);
});

test('legacy string driver argument still works', (t) => {
  const { jim, rootPath } = makeJim();
  t.after(() => rmSync(rootPath, { recursive: true, force: true }));

  const index = jim.createIndex('legacy', 'conf');
  index.set('k', 'v');
  assert.equal(index.get('k'), 'v');
});
