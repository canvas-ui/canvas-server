import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

import Jim from '../../../src/utils/jim/index.js';
import WorkspaceManager from '../../../src/core/workspace/index.js';
import RemoteWorkspace from '../../../src/core/workspace/lib/RemoteWorkspace.js';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, trace() {} };

// A port nothing listens on: probes fail with ECONNREFUSED immediately, so
// "offline" is exercised without waiting on a timeout.
const DEAD_REMOTE = 'http://127.0.0.1:65530';

async function makeEnv() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsman-remote-'));
  const usersRoot = path.join(tmp, 'users');
  const user = { id: 'user0001', email: 'u@test.local', homePath: path.join(usersRoot, 'u@test.local') };
  mkdirSync(path.join(user.homePath, 'Workspaces'), { recursive: true });
  const users = {
    indexStore: { store: { [user.id]: { ...user } } },
    async get(id) { if (id === user.id) return user; throw new Error(`User not found: ${id}`); },
    async list() { return [user]; },
    async resolveId(identifier) { return identifier === user.id || identifier === user.email ? user.id : null; },
  };
  const jim = new Jim({ rootPath: path.join(tmp, 'db'), driver: 'conf', driverOptions: { accessPropertiesByDotNotation: false }, logger: quietLogger });
  const manager = new WorkspaceManager({ defaultRootPath: usersRoot, indexFactory: jim, users, allowInsecureRemotes: true, logger: quietLogger });
  await manager.initialize();
  return { tmp, user, manager };
}

const REMOTE_WS_ID = '3e9d73a3-423a-4ca1-b389-641ee1cf29e5';

function addShared(manager, user, overrides = {}) {
  return manager.addRemoteWorkspace(user.id, {
    url: `${DEAD_REMOTE}/`,
    token: 'canvas-workspace-secret',
    workspaceId: REMOTE_WS_ID,
    workspaceName: 'shared',
    permissions: ['read', 'write'],
    ...overrides,
  });
}

test('remote reference lands in the main index as name@host, credentials stay separate', async () => {
  const { tmp, user, manager } = await makeEnv();
  try {
    const entry = await addShared(manager, user);
    assert.equal(entry.name, 'shared@127.0.0.1-65530');
    assert.equal(entry.id, REMOTE_WS_ID, 'keeps the remote id when nothing local owns it');
    assert.equal(entry.origin, 'remote');
    assert.equal(entry.remote.url, DEAD_REMOTE, 'trailing slash normalised away');
    assert.equal(entry.remote.token, undefined, 'token never on the returned entry');

    const index = JSON.parse(readFileSync(path.join(tmp, 'db', 'users', user.id, 'workspaces.json'), 'utf8'));
    assert.ok(index[REMOTE_WS_ID], 'entry persisted in the user workspace index');
    assert.equal(JSON.stringify(index).includes('canvas-workspace-secret'), false, 'token not in workspaces.json');

    const creds = JSON.parse(readFileSync(path.join(tmp, 'db', 'users', user.id, 'remote-workspaces.json'), 'utf8'));
    assert.equal(creds[REMOTE_WS_ID].token, 'canvas-workspace-secret');

    const listed = await manager.listRemoteWorkspaces(user.id);
    assert.equal(listed.length, 1);
    assert.equal(JSON.stringify(listed).includes('canvas-workspace-secret'), false);
  } finally { manager.disposeRemoteWorkspaces(); rmSync(tmp, { recursive: true, force: true }); }
});

test('name@host resolves through resolveWorkspaceId and peekRemoteWorkspaceEntry', async () => {
  const { tmp, user, manager } = await makeEnv();
  try {
    const entry = await addShared(manager, user);
    assert.equal(manager.resolveWorkspaceId(user.id, 'shared@127.0.0.1-65530'), entry.id);
    assert.equal(manager.resolveWorkspaceId(user.id, 'shared', '127.0.0.1-65530'), entry.id);
    assert.equal(manager.resolveWorkspaceId(user.id, 'shared'), null, 'bare name does not alias the remote');
    assert.equal(manager.peekRemoteWorkspaceEntry('shared@127.0.0.1-65530')?.id, entry.id);
    assert.equal(manager.peekRemoteWorkspaceEntry(entry.id)?.id, entry.id);
    assert.equal(manager.peekRemoteWorkspaceEntry('nope@127.0.0.1-65530'), null);
  } finally { manager.disposeRemoteWorkspaces(); rmSync(tmp, { recursive: true, force: true }); }
});

test('resolving a remote entry yields a RemoteWorkspace facade; listing mirrors reachability', async () => {
  const { tmp, user, manager } = await makeEnv();
  try {
    const entry = await addShared(manager, user);
    const ws = await manager.getWorkspace(entry.id, user.id);
    assert.ok(ws instanceof RemoteWorkspace);
    assert.equal(ws.isRemote, true);
    assert.equal(ws.name, 'shared@127.0.0.1-65530');
    assert.equal(ws.token, 'canvas-workspace-secret');
    assert.equal(ws.remoteUrl('/documents'), `${DEAD_REMOTE}/rest/v2/workspaces/${REMOTE_WS_ID}/documents`);
    assert.equal(JSON.stringify(ws.toJSON()).includes('canvas-workspace-secret'), false);

    assert.equal(await ws.probe({ force: true }), 'offline');
    assert.match(ws.statusMessage, /ECONNREFUSED|connect/i);

    const list = await manager.listWorkspaces(user.id);
    const item = list.find((w) => w.id === entry.id);
    assert.equal(item.status, 'offline');
    assert.equal(item.origin, 'remote');
    assert.equal(item.remote.url, DEAD_REMOTE);
    assert.equal(item.ownerEmail, user.email);
    assert.equal(JSON.stringify(list).includes('canvas-workspace-secret'), false);
  } finally { manager.disposeRemoteWorkspaces(); rmSync(tmp, { recursive: true, force: true }); }
});

test('re-adding the same remote refreshes credentials in place; a foreign id collision gets a fresh id', async () => {
  const { tmp, user, manager } = await makeEnv();
  try {
    const first = await addShared(manager, user);
    await manager.getWorkspace(first.id, user.id); // cache a facade with the old token
    const second = await addShared(manager, user, { token: 'canvas-workspace-rotated', permissions: ['read'] });
    assert.equal(second.id, first.id);
    assert.deepEqual(second.remote.permissions, ['read']);
    assert.equal((await manager.listRemoteWorkspaces(user.id)).length, 1);
    const ws = await manager.getWorkspace(first.id, user.id);
    assert.equal(ws.token, 'canvas-workspace-rotated', 'cached facade dropped so the new token is used');

    // A local workspace already holding the remote's id → the reference must not steal it.
    const local = await manager.createWorkspace('mine', user.id);
    const other = await manager.addRemoteWorkspace(user.id, {
      url: 'http://127.0.0.1:65531', token: 't', workspaceId: local.id, workspaceName: 'mine', permissions: ['read'],
    });
    assert.notEqual(other.id, local.id);
    assert.equal(other.remote.workspaceId, local.id);
    assert.equal(other.name, 'mine@127.0.0.1-65531');
  } finally { manager.disposeRemoteWorkspaces(); rmSync(tmp, { recursive: true, force: true }); }
});

test('PATCH-style config updates stay local; removing the reference drops credentials and never stops the remote', async () => {
  const { tmp, user, manager } = await makeEnv();
  try {
    const entry = await addShared(manager, user);
    assert.equal(await manager.updateWorkspaceConfig(user.id, entry.id, user.id, { label: 'Work (remote)', color: '#112233', order: 3 }), true);
    const ws = await manager.getWorkspace(entry.id, user.id);
    assert.equal(ws.label, 'Work (remote)');
    assert.equal(ws.toJSON().color, '#112233');
    assert.equal(ws.toJSON().order, 3);

    let stopped = false;
    ws.stop = async () => { stopped = true; };
    assert.equal(await manager.removeWorkspace(entry.id, user.id), true);
    assert.equal(stopped, false);
    assert.equal(await manager.getWorkspace(entry.id, user.id), null);
    assert.equal(manager.peekRemoteWorkspaceEntry('shared@127.0.0.1-65530'), null);
    const creds = JSON.parse(readFileSync(path.join(tmp, 'db', 'users', user.id, 'remote-workspaces.json'), 'utf8'));
    assert.equal(creds[entry.id], undefined);
  } finally { manager.disposeRemoteWorkspaces(); rmSync(tmp, { recursive: true, force: true }); }
});
