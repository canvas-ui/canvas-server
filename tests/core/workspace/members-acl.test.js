import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';

import Jim from '../../../src/utils/jim/index.js';
import WorkspaceManager from '../../../src/core/workspace/index.js';
import { resolveAclAccess, groupMatches, normalizePermissions, permissionForMethod } from '../../../src/core/workspace/lib/access.js';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

// Three accounts on one instance: the team admin (owner), a teammate in the
// LDAP group, and an outsider. Groups come from the user record exactly as
// the LDAP strategy stores them (memberOf DNs).
async function makeEnv() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'wsmembers-test-'));
  const usersRoot = path.join(tmp, 'users');
  const mk = (id, email, groups = []) => ({ id, email, name: id, groups, homePath: path.join(usersRoot, email) });
  const owner = mk('owner01', 'admin@corp.tld');
  const mate = mk('mate01', 'mate@corp.tld', ['CN=team-a,OU=groups,DC=corp,DC=tld', 'cn=everyone,ou=groups,dc=corp,dc=tld']);
  const outsider = mk('out01', 'out@corp.tld', ['cn=team-b,ou=groups,dc=corp,dc=tld']);
  const all = { [owner.id]: owner, [mate.id]: mate, [outsider.id]: outsider };
  for (const u of Object.values(all)) mkdirSync(path.join(u.homePath, 'Workspaces'), { recursive: true });

  const users = {
    indexStore: { store: all, get: (id) => all[id] || null },
    async get(id) { if (all[id]) return all[id]; throw new Error(`User not found: ${id}`); },
    async getByEmail(email) {
      const u = Object.values(all).find((x) => x.email === email.toLowerCase());
      if (!u) throw new Error('not found');
      return u;
    },
    async list() { return Object.values(all); },
    async resolveId(identifier) { return all[identifier]?.id || Object.values(all).find((u) => u.email === identifier)?.id || null; },
  };

  const jim = new Jim({ rootPath: path.join(tmp, 'db'), driver: 'conf', driverOptions: { accessPropertiesByDotNotation: false }, logger: quietLogger });
  const manager = new WorkspaceManager({ defaultRootPath: usersRoot, indexFactory: jim, users, logger: quietLogger });
  await manager.initialize();
  return { tmp, owner, mate, outsider, users, manager };
}

test('access.js: group matching by DN or CN, permission normalization, method mapping', () => {
  assert.ok(groupMatches('team-a', 'CN=team-a,OU=groups,DC=corp,DC=tld'));
  assert.ok(groupMatches('cn=team-a,ou=groups,dc=corp,dc=tld', 'CN=Team-A,OU=Groups,DC=corp,DC=tld'));
  assert.ok(!groupMatches('team-b', 'cn=team-a,ou=groups,dc=corp,dc=tld'));
  assert.deepEqual(normalizePermissions(['admin']), ['read', 'write', 'admin']);
  assert.deepEqual(normalizePermissions(['write']), ['read', 'write']);
  assert.deepEqual(normalizePermissions(['bogus']), []);
  assert.equal(permissionForMethod('GET'), 'read');
  assert.equal(permissionForMethod('PROPFIND'), 'read');
  assert.equal(permissionForMethod('POST'), 'write');

  const acl = { users: { 'Mate@corp.tld': { permissions: ['read'] } }, groups: { 'team-a': { permissions: ['write'] } } };
  // e-mail grant wins over group grant; both case-insensitive
  assert.equal(resolveAclAccess(acl, { email: 'mate@CORP.tld', groups: ['cn=team-a,ou=g'] }).via, 'user');
  assert.deepEqual(resolveAclAccess(acl, { email: 'x@corp.tld', groups: ['cn=team-a,ou=g'] }).permissions, ['read', 'write']);
  assert.equal(resolveAclAccess(acl, { email: 'x@corp.tld', groups: ['cn=team-b,ou=g'] }), null);
  assert.equal(resolveAclAccess(null, { email: 'x@corp.tld' }), null);
});

test('e-mail share: appears in the sharee list, opens by id and by name, clamps to the granted permission', async (t) => {
  const { tmp, owner, mate, outsider, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ws = await manager.createWorkspace('project-x', owner.id, { userEmail: owner.email });

  // Not shared yet: invisible and inaccessible to the others
  assert.equal((await manager.listWorkspaces(mate.id)).length, 0);
  assert.equal(await manager.getWorkspace(ws.id, mate.id), null);
  assert.equal(manager.resolveWorkspaceId(mate.id, 'project-x'), null);

  const grant = await manager.grantWorkspaceMember(ws.id, owner.id, 'user', 'MATE@corp.tld', { permissions: ['read'], description: 'reviewer' });
  assert.equal(grant.principal, 'mate@corp.tld');
  assert.deepEqual(grant.permissions, ['read']);
  assert.equal(grant.grantedBy, owner.id);

  // workspace.json is the source of truth and the index mirror is in sync
  const onDisk = JSON.parse(readFileSync(ws.configPath, 'utf8'));
  assert.ok(onDisk.acl.users['mate@corp.tld']);
  const listed = await manager.listWorkspaces(mate.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].type, 'shared');
  assert.equal(listed[0].isShared, true);
  assert.equal(listed[0].ownerEmail, owner.email);
  assert.equal(listed[0].sharedVia.type, 'user');
  assert.deepEqual(listed[0].sharedVia.permissions, ['read']);

  // Access resolution + name addressing for the sharee
  const access = await manager.resolveWorkspaceAccess(ws.id, mate.id);
  assert.equal(access.isOwner, false);
  assert.equal(access.owner, owner.id);
  assert.equal(access.via, 'user');
  assert.equal(manager.resolveWorkspaceId(mate.id, 'project-x'), ws.id);
  assert.ok(await manager.hasWorkspace(ws.id, mate.id));
  assert.ok(await manager.getWorkspace(ws.id, mate.id));
  assert.ok(await manager.getWorkspace(ws.id, mate.id, { permission: 'read' }));
  await assert.rejects(manager.getWorkspaceOrThrow(ws.id, mate.id, { permission: 'write' }), /lacks "write"/);

  // Outsider still sees nothing
  assert.equal(await manager.resolveWorkspaceAccess(ws.id, outsider.id), null);
  assert.equal(await manager.getWorkspace(ws.id, outsider.id), null);

  // Members management is owner-only
  await assert.rejects(manager.grantWorkspaceMember(ws.id, mate.id, 'user', 'out@corp.tld'), /owner/);
  await assert.rejects(manager.listWorkspaceMembers(ws.id, mate.id), /owner/);
  assert.equal((await manager.listWorkspaceMembers(ws.id, owner.id)).length, 1);

  // Upgrade, then revoke
  await manager.grantWorkspaceMember(ws.id, owner.id, 'user', 'mate@corp.tld', { permissions: ['write'] });
  assert.ok(await manager.getWorkspace(ws.id, mate.id, { permission: 'write' }));
  assert.equal(await manager.revokeWorkspaceMember(ws.id, owner.id, 'user', 'Mate@corp.tld'), true);
  assert.equal(await manager.revokeWorkspaceMember(ws.id, owner.id, 'user', 'mate@corp.tld'), false);
  assert.equal(await manager.getWorkspace(ws.id, mate.id), null);
  assert.equal((await manager.listWorkspaces(mate.id)).length, 0);
});

test('group share: LDAP memberOf DN matches a CN grant; the widest of several group grants wins', async (t) => {
  const { tmp, owner, mate, outsider, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ws = await manager.createWorkspace('team-space', owner.id, { userEmail: owner.email });
  await manager.grantWorkspaceMember(ws.id, owner.id, 'group', 'team-a', { permissions: ['read'] });

  let access = await manager.resolveWorkspaceAccess(ws.id, mate.id);
  assert.equal(access.via, 'group');
  assert.equal(access.principal, 'team-a');
  assert.deepEqual(access.permissions, ['read']);
  assert.equal(await manager.resolveWorkspaceAccess(ws.id, outsider.id), null);
  assert.equal(manager.resolveWorkspaceId(mate.id, 'team-space'), ws.id);

  // A second matching group with a wider grant takes precedence
  await manager.grantWorkspaceMember(ws.id, owner.id, 'group', 'cn=everyone,ou=groups,dc=corp,dc=tld', { permissions: ['write'] });
  access = await manager.resolveWorkspaceAccess(ws.id, mate.id);
  assert.deepEqual(access.permissions, ['read', 'write']);

  const shared = (await manager.listWorkspaces(mate.id)).find((w) => w.id === ws.id);
  assert.equal(shared.sharedVia.type, 'group');

  // Group revoke by CN when granted by CN
  assert.equal(await manager.revokeWorkspaceMember(ws.id, owner.id, 'group', 'TEAM-A'), true);
  assert.equal(await manager.revokeWorkspaceMember(ws.id, owner.id, 'group', 'everyone'), false, 'granted as a DN — revoke by the stored key');
  assert.equal(await manager.revokeWorkspaceMember(ws.id, owner.id, 'group', 'cn=everyone,ou=groups,dc=corp,dc=tld'), true);
  assert.equal(await manager.resolveWorkspaceAccess(ws.id, mate.id), null);
});

test('universe workspaces are never shareable; a grant to the owner is rejected', async (t) => {
  const { tmp, owner, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const universe = await manager.createUniverseWorkspace(owner.id, owner.email, path.join(owner.homePath, 'Workspaces', 'universe'));
  await assert.rejects(manager.grantWorkspaceMember(universe.id, owner.id, 'user', 'mate@corp.tld'), /universe/i);
  await assert.rejects(manager.grantWorkspaceMember(universe.id, owner.id, 'group', 'team-a'), /universe/i);

  const ws = await manager.createWorkspace('mine', owner.id, { userEmail: owner.email });
  await assert.rejects(manager.grantWorkspaceMember(ws.id, owner.id, 'user', owner.email), /already own/);
});

test('updateWorkspaceConfig keeps the on-disk ACL (member grants survive a label change)', async (t) => {
  const { tmp, owner, mate, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ws = await manager.createWorkspace('keep-acl', owner.id, { userEmail: owner.email });
  await manager.grantWorkspaceMember(ws.id, owner.id, 'user', mate.email, { permissions: ['read'] });
  assert.ok(await manager.updateWorkspaceConfig(owner.id, ws.id, owner.id, { label: 'Renamed' }));

  const onDisk = JSON.parse(readFileSync(ws.configPath, 'utf8'));
  assert.equal(onDisk.label, 'Renamed');
  assert.ok(onDisk.acl.users[mate.email], 'ACL preserved on disk');
  assert.ok(await manager.getWorkspace(ws.id, mate.id));
});

test('transferWorkspaceOwnership moves the entry, addressing and access; universe refuses', async (t) => {
  const { tmp, owner, mate, manager } = await makeEnv();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const ws = await manager.createWorkspace('handover', owner.id, { userEmail: owner.email });
  await manager.grantWorkspaceMember(ws.id, owner.id, 'group', 'team-a', { permissions: ['read'] });

  // A name clash on the target user is refused (before anything moves)
  const clash = await manager.createWorkspace('handover', mate.id, { userEmail: mate.email });
  await assert.rejects(manager.transferWorkspaceOwnership(ws.id, mate.id), /already has a workspace named/);
  assert.equal(JSON.parse(readFileSync(ws.configPath, 'utf8')).owner, owner.id, 'nothing moved');
  await manager.removeWorkspace(clash.id, mate.id, true);

  const entry = await manager.transferWorkspaceOwnership(ws.id, mate.id);
  assert.equal(entry.owner, mate.id);
  assert.equal(entry.reference, manager.constructWorkspaceReference(mate.id, 'handover'));

  assert.equal(manager.resolveWorkspaceId(mate.id, 'handover'), ws.id);
  assert.equal(manager.resolveWorkspaceId(owner.id, 'handover'), null, 'previous owner is not a member');
  assert.equal(await manager.getWorkspace(ws.id, owner.id), null);
  const mine = await manager.listWorkspaces(mate.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].owner, mate.id);
  assert.equal(mine[0].isShared, undefined);
  assert.equal(JSON.parse(readFileSync(ws.configPath, 'utf8')).owner, mate.id);
  assert.ok(JSON.parse(readFileSync(ws.configPath, 'utf8')).acl.groups['team-a'], 'grants travel with the workspace');

  // New owner can manage members
  assert.equal((await manager.listWorkspaceMembers(ws.id, mate.id)).length, 1);

  const universe = await manager.createUniverseWorkspace(owner.id, owner.email, path.join(owner.homePath, 'Workspaces', 'universe'));
  await assert.rejects(manager.transferWorkspaceOwnership(universe.id, mate.id), /universe/i);
});
