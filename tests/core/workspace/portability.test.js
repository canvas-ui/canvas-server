'use strict';

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

import {
  exportWorkspace,
  listExports,
  deleteExport,
  exportFilePath,
  importWorkspace,
  importWorkspaceFromRemote,
  inspectArchive,
  validateWorkspaceDir,
  saveUploadedArchive,
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
    async userWorkspacesPath(userId, userEmail) { return path.join(root, userEmail, 'Workspaces'); },
    async registerWorkspacePath(userId, absolutePath) {
      this.registered.push({ userId, absolutePath });
      return { id: 'imported-id', rootPath: absolutePath };
    },
    stopped: [],
    async stopWorkspace(workspaceId, userId) {
      this.stopped.push({ workspaceId, userId });
      const entry = this.entries.find((candidate) => candidate.id === workspaceId);
      if (entry) { entry.status = 'inactive'; entry.isActive = false; }
      return true;
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

test('remote import pulls token-info → export → archive and registers locally', async () => {
  // build a real archive to serve as the "remote" export
  const item = await exportWorkspace(manager, { userId: USER, userEmail: EMAIL, workspaceId: 'ws-1' });
  const archiveBytes = fs.readFileSync(exportFilePath(manager, EMAIL, item.name));
  fs.rmSync(wsDir, { recursive: true });
  fs.rmSync(exportFilePath(manager, EMAIL, item.name));

  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/rest/v2/workspaces/token-info')) {
      return { ok: true, status: 200, json: async () => ({ payload: { workspaceId: 'remote-ws', workspaceName: 'my-ws' } }) };
    }
    if (url.endsWith('/rest/v2/workspaces/remote-ws/export')) {
      return { ok: true, status: 201, json: async () => ({ payload: { name: item.name } }) };
    }
    if (url.includes('/exports/') && (options.method || 'GET') === 'GET') {
      return { ok: true, status: 200, body: new Blob([archiveBytes]).stream() };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const entry = await importWorkspaceFromRemote(manager, {
    userId: USER, userEmail: EMAIL, url: 'https://src.example/', token: 'canvas-workspace-x', fetchImpl,
  });
  assert.equal(entry.id, 'imported-id');
  assert.ok(fs.existsSync(path.join(root, EMAIL, 'Workspaces', 'my-ws', 'workspace.json')));
  // downloaded archive is kept in the local Exports dir (visible/removable)
  assert.ok(fs.existsSync(exportFilePath(manager, EMAIL, item.name)));
  // remote archive cleanup was attempted
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/exports/')));
  // every remote call carried the share token in the right shape of routes
  assert.equal(calls[0].url, 'https://src.example/rest/v2/workspaces/token-info');
});

test('remote import surfaces remote failures with their status', async () => {
  const fetchImpl = async (url) => {
    if (url.endsWith('/token-info')) {
      return { ok: true, status: 200, json: async () => ({ payload: { workspaceId: 'remote-ws' } }) };
    }
    return { ok: false, status: 409, json: async () => ({ message: 'Workspace active' }) };
  };
  await assert.rejects(
    importWorkspaceFromRemote(manager, { userId: USER, userEmail: EMAIL, url: 'https://src.example', token: 't', fetchImpl }),
    (err) => err.code === 'REMOTE_ERROR' && err.statusCode === 409 && /Workspace active/.test(err.message)
  );
});

test('remote import validates its inputs', async () => {
  await assert.rejects(
    importWorkspaceFromRemote(manager, { userId: USER, userEmail: EMAIL, url: 'ftp://nope', token: 't' }),
    (err) => err.statusCode === 400
  );
  await assert.rejects(
    importWorkspaceFromRemote(manager, { userId: USER, userEmail: EMAIL, url: 'https://ok.example', token: '' }),
    (err) => err.statusCode === 400
  );
});

test('import rejects non-archive files and missing sources', async () => {
  const stray = path.join(root, 'not-an-archive.txt');
  fs.writeFileSync(stray, 'hi');
  await assert.rejects(importWorkspace(manager, { userId: USER, userEmail: EMAIL, source: stray }), (err) => err.statusCode === 400);
  await assert.rejects(importWorkspace(manager, { userId: USER, userEmail: EMAIL, source: path.join(root, 'nope.tar.gz') }), (err) => err.statusCode === 404);
  await assert.rejects(importWorkspace(manager, { userId: USER, userEmail: EMAIL, source: 'relative/path' }), (err) => err.statusCode === 400);
});


test('export with stop:true stops an active workspace, then archives it', async () => {
  manager.entries[0].status = 'active';
  manager.entries[0].isActive = true;

  const item = await exportWorkspace(manager, { userId: USER, userEmail: EMAIL, workspaceId: 'ws-1', stop: true });

  assert.deepEqual(manager.stopped, [{ workspaceId: 'ws-1', userId: USER }]);
  assert.equal(item.stoppedWorkspace, true);
  assert.ok(item.size > 0);
  // left stopped — restarting is the caller's call
  assert.equal(manager.entries[0].status, 'inactive');
});

test('export of an already-stopped workspace does not stop anything', async () => {
  const item = await exportWorkspace(manager, { userId: USER, userEmail: EMAIL, workspaceId: 'ws-1', stop: true });
  assert.deepEqual(manager.stopped, []);
  assert.equal(item.stoppedWorkspace, false);
});

test('import accepts a bzip2 archive as well as gzip', async () => {
  const archive = path.join(root, 'my-ws.tar.bz2');
  execFileSync('tar', ['-C', path.dirname(wsDir), '-cjf', archive, path.basename(wsDir)]);
  fs.rmSync(wsDir, { recursive: true, force: true });

  const entry = await importWorkspace(manager, { userId: USER, userEmail: EMAIL, source: archive });
  assert.equal(entry.id, 'imported-id');
  assert.ok(fs.existsSync(path.join(wsDir, 'workspace.json')));
});

test('inspectArchive rejects traversal entries anywhere in the archive', async () => {
  // a nested ../ escapes the extraction dir even with a clean top-level name
  const evil = path.join(root, 'evil');
  fs.mkdirSync(path.join(evil, 'ws'), { recursive: true });
  fs.writeFileSync(path.join(evil, 'ws', 'ok.txt'), 'x');
  const archive = path.join(root, 'evil.tar.gz');
  execFileSync('tar', ['-C', evil, '-czf', archive, 'ws', '--transform', 's|ok.txt|../../escaped.txt|'], { stdio: 'ignore' });

  await assert.rejects(inspectArchive(archive), (err) => err.code === 'BAD_ARCHIVE');
});

test('inspectArchive rejects a file that is not a tar archive', async () => {
  const notTar = path.join(root, 'nope.tar.gz');
  fs.writeFileSync(notTar, 'definitely not a tarball');
  await assert.rejects(inspectArchive(notTar), (err) => err.code === 'BAD_ARCHIVE');
});

test('import rejects an archive whose folder is not a workspace', async () => {
  const plain = path.join(root, 'plain', 'not-a-ws');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'readme.txt'), 'nothing to see');
  const archive = path.join(root, 'plain.tar.gz');
  execFileSync('tar', ['-C', path.dirname(plain), '-czf', archive, path.basename(plain)]);

  await assert.rejects(
    importWorkspace(manager, { userId: USER, userEmail: EMAIL, source: archive }),
    (err) => err.code === 'BAD_ARCHIVE' && /no workspace.json/i.test(err.message)
  );
  // and the failed extraction is not left behind
  assert.equal(fs.existsSync(path.join(root, EMAIL, 'Workspaces', 'not-a-ws')), false);
});

test('validateWorkspaceDir rejects a workspace.json missing required fields', async () => {
  const dir = path.join(root, 'bad-ws');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ name: 'no-id' }));
  await assert.rejects(validateWorkspaceDir(dir), (err) => /missing id/.test(err.message));
});

test('uploaded archives land in Exports under a sanitised, non-clobbering name', async () => {
  const first = await saveUploadedArchive(manager, EMAIL, '../../etc/eviL name.tar.gz', Readable.from(['payload']));
  assert.equal(first.name, 'eviL_name.tar.gz');
  assert.equal(path.dirname(exportFilePath(manager, EMAIL, first.name)), path.join(root, EMAIL, 'Exports'));

  const second = await saveUploadedArchive(manager, EMAIL, 'eviL name.tar.gz', Readable.from(['payload']));
  assert.equal(second.name, 'eviL_name-1.tar.gz');
});

test('uploads must look like an archive', async () => {
  await assert.rejects(
    saveUploadedArchive(manager, EMAIL, 'workspace.zip', Readable.from(['x'])),
    (err) => err.statusCode === 400
  );
});
