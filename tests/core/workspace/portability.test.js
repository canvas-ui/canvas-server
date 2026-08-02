'use strict';

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  exportWorkspace,
  listExports,
  deleteExport,
  exportFilePath,
  importWorkspace,
} from '../../../src/core/workspace/lib/portability.js';

const EMAIL = 'tester@canvas.local';
const USER = 'user-1';

let root;
let wsDir;
let manager;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'portability-'));
  wsDir = path.join(root, EMAIL, 'Workspaces', 'my-ws');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'workspace.json'), JSON.stringify({ id: 'ws-1', name: 'my-ws', owner: USER }));
  fs.mkdirSync(path.join(wsDir, 'db'));
  fs.writeFileSync(path.join(wsDir, 'db', 'data.bin'), 'x'.repeat(4096));

  manager = {
    rootPath: root,
    entries: [{ id: 'ws-1', name: 'my-ws', owner: USER, status: 'inactive', isActive: false, rootPath: wsDir }],
    registered: [],
    async listWorkspaces() { return this.entries; },
    async registerWorkspacePath(userId, absolutePath) {
      this.registered.push({ userId, absolutePath });
      return { id: 'imported-id', rootPath: absolutePath };
    },
  };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('export archives the workspace folder into Exports and lists it with size', async () => {
  const item = await exportWorkspace(manager, { userId: USER, userEmail: EMAIL, workspaceId: 'ws-1' });
  assert.match(item.name, /^my-ws-.*\.tar\.gz$/);
  assert.ok(item.size > 0);

  const listed = await listExports(manager, EMAIL);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, item.name);
  assert.equal(listed[0].size, item.size);
});

test('export refuses an active workspace with 409', async () => {
  manager.entries[0].status = 'active';
  await assert.rejects(
    exportWorkspace(manager, { userId: USER, userEmail: EMAIL, workspaceId: 'ws-1' }),
    (err) => err.code === 'WORKSPACE_ACTIVE' && err.statusCode === 409
  );
});

test('export is owner-only', async () => {
  await assert.rejects(
    exportWorkspace(manager, { userId: 'someone-else', userEmail: EMAIL, workspaceId: 'ws-1' }),
    (err) => err.statusCode === 403
  );
});

test('export names are traversal-guarded', () => {
  assert.throws(() => exportFilePath(manager, EMAIL, '../../../etc/passwd'), /Invalid export name/);
  assert.throws(() => exportFilePath(manager, EMAIL, 'x/y.tar.gz'), /Invalid export name/);
  assert.throws(() => exportFilePath(manager, EMAIL, '.hidden.tar.gz'), /Invalid export name/);
});

test('deleteExport removes the archive and reports missing ones', async () => {
  const item = await exportWorkspace(manager, { userId: USER, userEmail: EMAIL, workspaceId: 'ws-1' });
  assert.equal(await deleteExport(manager, EMAIL, item.name), true);
  assert.equal(await deleteExport(manager, EMAIL, item.name), false);
  assert.deepEqual(await listExports(manager, EMAIL), []);
});

test('import from a local folder registers it in place', async () => {
  const entry = await importWorkspace(manager, { userId: USER, userEmail: EMAIL, source: wsDir });
  assert.equal(entry.id, 'imported-id');
  assert.deepEqual(manager.registered, [{ userId: USER, absolutePath: wsDir }]);
});

test('export → import round trip extracts into Workspaces and registers', async () => {
  const item = await exportWorkspace(manager, { userId: USER, userEmail: EMAIL, workspaceId: 'ws-1' });
  // simulate importing on a "different server": remove the original folder
  fs.rmSync(wsDir, { recursive: true });

  const archive = exportFilePath(manager, EMAIL, item.name);
  const entry = await importWorkspace(manager, { userId: USER, userEmail: EMAIL, source: archive });

  const target = path.join(root, EMAIL, 'Workspaces', 'my-ws');
  assert.equal(entry.rootPath, target);
  assert.ok(fs.existsSync(path.join(target, 'workspace.json')));
  assert.ok(fs.existsSync(path.join(target, 'db', 'data.bin')));
});

test('import refuses when the target folder already exists', async () => {
  const item = await exportWorkspace(manager, { userId: USER, userEmail: EMAIL, workspaceId: 'ws-1' });
  const archive = exportFilePath(manager, EMAIL, item.name);
  await assert.rejects(
    importWorkspace(manager, { userId: USER, userEmail: EMAIL, source: archive }),
    (err) => err.code === 'TARGET_EXISTS' && err.statusCode === 409
  );
});

test('import cleans up the extraction when registration fails', async () => {
  const item = await exportWorkspace(manager, { userId: USER, userEmail: EMAIL, workspaceId: 'ws-1' });
  fs.rmSync(wsDir, { recursive: true });
  manager.registerWorkspacePath = async () => { throw new Error('index says no'); };

  const archive = exportFilePath(manager, EMAIL, item.name);
  await assert.rejects(importWorkspace(manager, { userId: USER, userEmail: EMAIL, source: archive }), /index says no/);
  assert.ok(!fs.existsSync(path.join(root, EMAIL, 'Workspaces', 'my-ws')));
});

test('import rejects non-archive files and missing sources', async () => {
  const stray = path.join(root, 'not-an-archive.txt');
  fs.writeFileSync(stray, 'hi');
  await assert.rejects(importWorkspace(manager, { userId: USER, userEmail: EMAIL, source: stray }), (err) => err.statusCode === 400);
  await assert.rejects(importWorkspace(manager, { userId: USER, userEmail: EMAIL, source: path.join(root, 'nope.tar.gz') }), (err) => err.statusCode === 404);
  await assert.rejects(importWorkspace(manager, { userId: USER, userEmail: EMAIL, source: 'relative/path' }), (err) => err.statusCode === 400);
});
