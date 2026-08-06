import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';

import Jim from '../../../src/utils/jim/index.js';
import WorkspaceManager from '../../../src/core/workspace/index.js';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function makeEnv({ defaultLayout } = {}) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsman-test-'));
  const usersRoot = path.join(tmp, 'users');
  const user = {
    id: 'user0001',
    email: 'u@test.local',
    homePath: path.join(usersRoot, 'u@test.local'),
  };
  mkdirSync(path.join(user.homePath, 'Workspaces'), { recursive: true });

  const users = {
    indexStore: { store: { [user.id]: { ...user } } },
    async get(id) {
      if (id === user.id) return user;
      throw new Error(`User not found: ${id}`);
    },
    async list() { return [user]; },
    async resolveId(identifier) {
      return identifier === user.id || identifier === user.email ? user.id : null;
    },
  };

  const jim = new Jim({
    rootPath: path.join(tmp, 'db'),
    driver: 'conf',
    driverOptions: { accessPropertiesByDotNotation: false },
    logger: quietLogger,
  });

  const manager = new WorkspaceManager({
    defaultRootPath: usersRoot,
    defaultLayout,
    indexFactory: jim,
    users,
    logger: quietLogger,
  });
  await manager.initialize();

  return { tmp, usersRoot, user, users, jim, manager };
}

function userIndexPath(tmp, userId) {
  return path.join(tmp, 'db', 'users', userId, 'workspaces.json');
}

function seedWorkspaceDir(dir, config) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(config));
}

test('createWorkspace writes to the per-user index file keyed by workspaceId', async (t) => {
  const { tmp, user, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ws = await manager.createWorkspace('projectx', user.id, { userEmail: user.email });

  const indexFile = JSON.parse(readFileSync(userIndexPath(tmp, user.id), 'utf8'));
  assert.ok(indexFile[ws.id], 'entry keyed by workspaceId');
  assert.equal(indexFile[ws.id].origin, 'local');
  assert.equal(indexFile[ws.id].owner, user.id);

  // workspace.json (source of truth) never carries index-only fields
  const onDisk = JSON.parse(readFileSync(ws.configPath, 'utf8'));
  assert.equal('origin' in onDisk, false);
  assert.equal('lastScannedAt' in onDisk, false);

  const list = await manager.listWorkspaces(user.id);
  assert.deepEqual(list.map((w) => w.name), ['projectx']);
});

test('new workspaces land in the user\'s configured workspaces root', async (t) => {
  // A personal instance points the workspaces module at ~/Workspaces; both
  // creation and discovery must follow it, not <usersRoot>/<email>/Workspaces.
  const { tmp, user, users, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const relocated = path.join(tmp, 'home-of-user', 'Workspaces');
  users.getUserPaths = () => ({
    workspaces: relocated,
    roles: path.join(tmp, 'home-of-user', 'Roles'),
    agents: path.join(tmp, 'home-of-user', 'Agents'),
  });

  const ws = await manager.createWorkspace('relocated', user.id, { userEmail: user.email });
  assert.equal(ws.rootPath, path.join(relocated, 'relocated'));

  // …and a scan finds it there (it is not under the default root at all).
  const report = await manager.scanUserWorkspaces(user.id);
  assert.equal(report.missing.length, 0);
  const list = await manager.listWorkspaces(user.id);
  assert.deepEqual(list.map((w) => w.name), ['relocated']);
});

test('the server-wide default layout applies when the caller names none', async (t) => {
  // CANVAS_WORKSPACE_LAYOUT=home (what the container ships): a workspace
  // created through the API without a `layout` is a plain folder.
  const { tmp, user, manager } = await makeEnv({ defaultLayout: 'home' });
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ws = await manager.createWorkspace('roaming', user.id, { userEmail: user.email });
  assert.equal(ws.layout, 'home');
  assert.equal(existsSync(path.join(ws.rootPath, '.workspace', 'workspace.json')), true);
  assert.equal(existsSync(path.join(ws.rootPath, 'workspace.json')), false, 'nothing visible at the root');

  // An explicit choice still wins over the default.
  const full = await manager.createWorkspace('classic', user.id, { userEmail: user.email, layout: 'full' });
  assert.equal(full.layout, 'full');
  assert.equal(existsSync(path.join(full.rootPath, 'workspace.json')), true);
});

test('a workspace named universe is deletable like any other', async (t) => {
  const { tmp, user, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ws = await manager.createUniverseWorkspace(user.id, user.email, path.join(user.homePath, 'Workspaces', 'universe'));
  assert.equal(ws.name, 'universe');

  const removed = await manager.removeWorkspace(ws.id, user.id, true);
  assert.equal(removed, true);
  assert.equal(existsSync(ws.rootPath), false, 'destroyData removes the directory');
  assert.equal(await manager.hasWorkspace(ws.id, user.id), false);
});

test('scan discovers a transplanted foreign workspace dir and adopts it', async (t) => {
  const { tmp, user, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const dir = path.join(user.homePath, 'Workspaces', 'imported');
  seedWorkspaceDir(dir, {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    name: 'imported',
    owner: 'someolduser',
    rootPath: '/somewhere/else/imported',
    configPath: '/somewhere/else/imported/workspace.json',
    host: 'canvas.local',
  });

  const report = await manager.scanUserWorkspaces(user.id);
  assert.equal(report.adopted.length, 1);
  assert.equal(report.adopted[0].importedFrom, 'someolduser');

  // workspace.json rewritten: new owner + actual path
  const onDisk = JSON.parse(readFileSync(path.join(dir, 'workspace.json'), 'utf8'));
  assert.equal(onDisk.owner, user.id);
  assert.equal(onDisk.rootPath, dir);

  // index entry records provenance
  const entry = manager.getWorkspaceIndexEntry('aaaaaaaa-1111-2222-3333-444444444444', user.id);
  assert.equal(entry.importedFrom, 'someolduser');
  assert.equal(entry.origin, 'local');

  // rescanning an unchanged workspace reports nothing new
  const rescan = await manager.scanUserWorkspaces(user.id);
  assert.equal(rescan.discovered.length + rescan.adopted.length + rescan.updated.length, 0);
});

test('scan assigns a fresh id to a live duplicate and suffixes name collisions', async (t) => {
  const { tmp, user, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const original = await manager.createWorkspace('proj', user.id, { userEmail: user.email });

  // A copied dir: same id, same name, different directory
  const copyDir = path.join(user.homePath, 'Workspaces', 'proj-copy');
  const originalConfig = JSON.parse(readFileSync(original.configPath, 'utf8'));
  seedWorkspaceDir(copyDir, { ...originalConfig, rootPath: copyDir });

  const report = await manager.scanUserWorkspaces(user.id);
  assert.equal(report.discovered.length, 1);
  const newId = report.discovered[0].id;
  assert.notEqual(newId, original.id, 'duplicate got a fresh id');
  assert.equal(report.discovered[0].name, 'proj-2', 'name collision suffixed');

  // original untouched
  const entry = manager.getWorkspaceIndexEntry(original.id, user.id);
  assert.equal(entry.name, 'proj');
  assert.equal(entry.rootPath, original.rootPath);
});

test('scan marks entries with missing directories as not_found', async (t) => {
  const { tmp, user, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ws = await manager.createWorkspace('vanishing', user.id, { userEmail: user.email });
  rmSync(ws.rootPath, { recursive: true, force: true });

  const report = await manager.scanUserWorkspaces(user.id);
  assert.equal(report.missing.length, 1);
  assert.equal(manager.getWorkspaceIndexEntry(ws.id, user.id).status, 'not_found');
});

test('registerWorkspacePath registers a foreign-local dir outside the users root', async (t) => {
  const { tmp, user, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const foreignDir = path.join(tmp, 'elsewhere', 'sideproject');
  seedWorkspaceDir(foreignDir, {
    id: 'bbbbbbbb-1111-2222-3333-444444444444',
    name: 'sideproject',
    owner: user.id,
  });

  const entry = await manager.registerWorkspacePath(user.id, foreignDir);
  assert.equal(entry.origin, 'foreign-local');
  assert.equal(entry.rootPath, foreignDir);

  // double registration is rejected
  await assert.rejects(() => manager.registerWorkspacePath(user.id, foreignDir), /already registered/);
});

test('registerWorkspacePath without adopt rejects a foreign owner', async (t) => {
  const { tmp, user, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const foreignDir = path.join(tmp, 'elsewhere', 'notmine');
  seedWorkspaceDir(foreignDir, { id: 'cccccccc-1111-2222-3333-444444444444', name: 'notmine', owner: 'someoneelse' });

  await assert.rejects(() => manager.registerWorkspacePath(user.id, foreignDir, { adopt: false }), /owned by someoneelse/);
});

test('remote index entries resolve to a NOT_IMPLEMENTED error', async (t) => {
  const { tmp, user, jim, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Seed a remote entry directly into the user's index (shares the Conf
  // instance with the manager through the same jim factory)
  const userIndex = jim.getOrCreateIndex('workspaces', { scope: `users/${user.id}` });
  userIndex.set('remote-ws-1', {
    id: 'remote-ws-1',
    name: 'faraway',
    owner: user.id,
    host: 'other.server.tld',
    origin: 'remote',
    remote: { endpoint: null, authRef: null },
  });

  await assert.rejects(
    () => manager.getWorkspaceOrThrow('remote-ws-1', user.id),
    (err) => err.code === 'NOT_IMPLEMENTED' && err.statusCode === 501
  );
});
