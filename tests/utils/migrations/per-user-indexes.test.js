import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';

import { runPerUserIndexMigration } from '../../../scripts/migrate-001-per-user-indexes.js';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeFixture() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'migration-test-'));
  const dbPath = path.join(tmp, 'db');
  const usersRootPath = path.join(tmp, 'users');
  mkdirSync(dbPath, { recursive: true });

  writeFileSync(path.join(dbPath, 'workspaces.json'), JSON.stringify({
    'u1/ws-aaa': {
      id: 'ws-aaa', name: 'universe', owner: 'u1', status: 'active', host: 'canvas.local',
      rootPath: path.join(usersRootPath, 'a@x.tld', 'workspaces', 'universe'),
    },
    'u1/ws-bbb': {
      id: 'ws-bbb', name: 'ext', owner: 'u1', status: 'available', host: 'canvas.local',
      rootPath: '/mnt/elsewhere/ext',
    },
    'u2/ws-ccc': {
      id: 'ws-ccc', name: 'other', owner: 'u2', status: 'inactive', host: 'canvas.local',
      rootPath: path.join(usersRootPath, 'b@x.tld', 'Workspaces', 'other'),
    },
  }));

  writeFileSync(path.join(dbPath, 'contexts.json'), JSON.stringify({
    'u1/default': { id: 'default', userId: 'u1', url: '/', workspaceId: 'ws-aaa' },
    'u2/work': { id: 'work', userId: 'u2', url: '/', workspaceId: 'ws-ccc' },
  }));

  return { tmp, dbPath, usersRootPath };
}

test('splits global indexes into per-user files with origin inference', async (t) => {
  const { tmp, dbPath, usersRootPath } = makeFixture();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const result = await runPerUserIndexMigration({ dbPath, usersRootPath, logger: quietLogger });
  assert.equal(result.ran, true);
  assert.equal(result.workspaces, 3);
  assert.equal(result.contexts, 2);

  const u1ws = JSON.parse(readFileSync(path.join(dbPath, 'users', 'u1', 'workspaces.json'), 'utf8'));
  assert.deepEqual(Object.keys(u1ws).sort(), ['ws-aaa', 'ws-bbb']);
  assert.equal(u1ws['ws-aaa'].origin, 'local');
  assert.equal(u1ws['ws-aaa'].status, 'inactive', 'active status reset');
  assert.equal(u1ws['ws-bbb'].origin, 'foreign-local');

  const u2ctx = JSON.parse(readFileSync(path.join(dbPath, 'users', 'u2', 'contexts.json'), 'utf8'));
  assert.deepEqual(Object.keys(u2ctx), ['work']);

  // originals renamed, marker written
  assert.equal(existsSync(path.join(dbPath, 'workspaces.json')), false);
  assert.equal(existsSync(path.join(dbPath, 'contexts.json')), false);
  const renamed = readdirSync(dbPath).filter((f) => f.includes('.migrated-'));
  assert.equal(renamed.length, 2);
  const marker = JSON.parse(readFileSync(path.join(dbPath, '.migrations.json'), 'utf8'));
  assert.ok(marker['001-per-user-indexes']);
});

test('second run is a no-op (marker present)', async (t) => {
  const { tmp, dbPath, usersRootPath } = makeFixture();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  await runPerUserIndexMigration({ dbPath, usersRootPath, logger: quietLogger });
  const again = await runPerUserIndexMigration({ dbPath, usersRootPath, logger: quietLogger });
  assert.equal(again.ran, false);
});

test('fresh install (no global files) is a no-op', async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'migration-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = path.join(tmp, 'db');
  mkdirSync(dbPath, { recursive: true });

  const result = await runPerUserIndexMigration({ dbPath, usersRootPath: path.join(tmp, 'users'), logger: quietLogger });
  assert.equal(result.ran, false);
  assert.equal(existsSync(path.join(dbPath, '.migrations.json')), false);
});
