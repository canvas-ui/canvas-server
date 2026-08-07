import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';

import Users from '../../../src/core/user/index.js';
import {
    resolveUserPaths,
    expandUserPath,
    normalizeUserPathOverrides,
    applyPathOverrides,
    USER_MODULES,
} from '../../../src/core/user/lib/paths.js';

const HOME = '/srv/canvas/users/u@test.local';

describe('user module roots', () => {
    test('default to <userHome>/{Workspaces,Roles,Agents}', () => {
        assert.deepEqual(resolveUserPaths({ homePath: HOME }), {
            workspaces: path.join(HOME, 'Workspaces'),
            roles: path.join(HOME, 'Roles'),
            agents: path.join(HOME, 'Agents'),
        });
    });

    test('server defaults relocate every user, per module', () => {
        // The personal-instance case: one env var moves workspaces to the user's
        // real home dir while roles/agents stay put.
        const paths = resolveUserPaths({
            homePath: HOME,
            defaults: { workspaces: '~/Workspaces' },
        });
        assert.equal(paths.workspaces, path.join(os.homedir(), 'Workspaces'));
        assert.equal(paths.roles, path.join(HOME, 'Roles'));
    });

    test('a user override beats the server default', () => {
        const paths = resolveUserPaths({
            homePath: HOME,
            overrides: { workspaces: '/mnt/nas/ws' },
            defaults: { workspaces: '~/Workspaces', agents: '{USER_HOME}/custom-agents' },
        });
        assert.equal(paths.workspaces, '/mnt/nas/ws');
        assert.equal(paths.agents, path.join(HOME, 'custom-agents'));
    });

    test('values expand ~, {USER_HOME}, {HOME} and relative paths', () => {
        assert.equal(expandUserPath('~/Agents', HOME), path.join(os.homedir(), 'Agents'));
        assert.equal(expandUserPath('{USER_HOME}/Roles', HOME), path.join(HOME, 'Roles'));
        assert.equal(expandUserPath('{HOME}/Canvas', HOME), path.join(os.homedir(), 'Canvas'));
        assert.equal(expandUserPath('Stuff', HOME), path.join(HOME, 'Stuff'));
        assert.equal(expandUserPath('  ', HOME), null);
        assert.equal(expandUserPath(null, HOME), null);
    });

    test('an override patch only carries deliberate relocations', () => {
        assert.deepEqual(normalizeUserPathOverrides({ workspaces: '/a', nonsense: '/b' }, HOME), { workspaces: '/a' });
        assert.deepEqual(normalizeUserPathOverrides({ roles: null }, HOME), { roles: null });
        assert.throws(() => normalizeUserPathOverrides({ agents: 42 }, HOME), /expected a string/);

        // null clears — the module goes back to following the default
        const existing = { workspaces: '/a', roles: '/b' };
        assert.deepEqual(applyPathOverrides(existing, { roles: null }, HOME), { workspaces: '/a' });
        assert.deepEqual(applyPathOverrides(existing, {}, HOME), existing);
    });
});

// In-memory stand-in for the jim index the Users service writes through.
function indexStore(initial = {}) {
    const store = { ...initial };
    return {
        store,
        get size() { return Object.keys(store).length; },
        get: (id) => store[id],
        set: (id, value) => { store[id] = value; },
        has: (id) => id in store,
        delete: (id) => { delete store[id]; },
    };
}

describe('creating a user over an existing home directory', () => {
    // The container pre-creates <userHome>/<email>/{Workspaces,Roles,Agents} on
    // the host — docker would otherwise create those bind mountpoints as root —
    // so on a fresh install the admin's home always exists before the account
    // does. Treating that as a conflict leaves the server with no users at all.
    function makeUsers(t, { universeThrows = false } = {}) {
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'user-create-'));
        t.after(() => rmSync(tmp, { recursive: true, force: true }));
        const calls = { universe: 0, scan: 0 };
        const users = new Users({
            rootPath: path.join(tmp, 'users'),
            indexStore: indexStore(),
            workspaceManager: {
                async createUniverseWorkspace() {
                    calls.universe++;
                    if (universeThrows) { throw new Error('Directory is already a workspace: /x'); }
                    return { id: 'ws1', name: 'universe' };
                },
                async scanUserWorkspaces() { calls.scan++; return { discovered: [], adopted: [] }; },
            },
            contextManager: { async createContext() { return { id: 'default' }; } },
        });
        return { users, tmp, calls };
    }

    test('an already-created home is used, not rejected', async (t) => {
        const { users, tmp } = makeUsers(t);
        await users.initialize();

        const home = path.join(tmp, 'users', 'admin@canvas.local');
        mkdirSync(path.join(home, 'Workspaces'), { recursive: true });

        const user = await users.create({ name: 'admin', email: 'admin@canvas.local', userType: 'admin' });
        assert.equal(user.homePath, home);
        assert.equal(users.indexStore.get(user.id).email, 'admin@canvas.local');
        assert.equal(existsSync(path.join(home, 'Roles')), true, 'the missing module dirs are filled in');
    });

    test('an existing universe workspace is adopted instead of failing the account', async (t) => {
        const { users, calls } = makeUsers(t, { universeThrows: true });
        await users.initialize();

        const user = await users.create({ name: 'tester', email: 'tester@canvas.local' });
        assert.equal(calls.universe, 1);
        assert.equal(calls.scan >= 1, true, 'falls back to a discovery scan');
        assert.equal(users.indexStore.get(user.id).status, 'active');
    });
});

describe('Users service module roots', () => {
    async function makeUsers(t, { record = {}, pathDefaults = {} } = {}) {
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'user-paths-'));
        t.after(() => rmSync(tmp, { recursive: true, force: true }));
        const homePath = path.join(tmp, 'users', 'u@test.local');
        const users = new Users({
            rootPath: path.join(tmp, 'users'),
            pathDefaults,
            indexStore: indexStore({
                u1: { id: 'u1', name: 'tester', email: 'u@test.local', homePath, status: 'active', ...record },
            }),
        });
        await users.initialize();
        return { users, tmp, homePath };
    }

    test('getUserPaths resolves straight from the index (no instantiation)', async (t) => {
        const { users, homePath } = await makeUsers(t);
        assert.deepEqual(users.getUserPaths('u1'), {
            workspaces: path.join(homePath, 'Workspaces'),
            roles: path.join(homePath, 'Roles'),
            agents: path.join(homePath, 'Agents'),
        });
    });

    test('setUserPaths persists the override, creates the dir and can be cleared', async (t) => {
        const { users, tmp, homePath } = await makeUsers(t);
        const target = path.join(tmp, 'elsewhere', 'Workspaces');

        const paths = await users.setUserPaths('u1', { workspaces: target });
        assert.equal(paths.workspaces, target);
        assert.equal(existsSync(target), true, 'the new root is created');
        assert.equal(existsSync(paths.agents), true, 'the other modules are ensured too');
        // Only the relocated module is persisted.
        assert.deepEqual(users.indexStore.get('u1').paths, { workspaces: target });

        const cleared = await users.setUserPaths('u1', { workspaces: null });
        assert.equal(cleared.workspaces, path.join(homePath, 'Workspaces'));
        assert.deepEqual(users.indexStore.get('u1').paths, {});
    });

    test('a server default applies to a user with no override, and keeps applying', async (t) => {
        const tmp = mkdtempSync(path.join(os.tmpdir(), 'user-paths-'));
        t.after(() => rmSync(tmp, { recursive: true, force: true }));
        const homePath = path.join(tmp, 'users', 'u@test.local');
        const store = indexStore({ u1: { id: 'u1', name: 'tester', email: 'u@test.local' } });
        const usersRoot = path.join(tmp, 'users');

        const before = new Users({ rootPath: usersRoot, indexStore: store, pathDefaults: {} });
        await before.initialize();
        assert.equal(before.getUserPaths('u1').agents, path.join(homePath, 'Agents'));

        // Same record, new server default — nothing stored had to change, which
        // is the point of resolving on read.
        const after = new Users({ rootPath: usersRoot, indexStore: store, pathDefaults: { agents: '{USER_HOME}/../shared-agents' } });
        await after.initialize();
        assert.equal(after.getUserPaths('u1').agents, path.resolve(homePath, '..', 'shared-agents'));
    });

    test('a record written under a different users root resolves under the current one', async (t) => {
        // What a moved (or re-containerized) install looks like: the stored
        // homePath points at a directory that no longer exists and cannot be
        // created. The home is <usersRoot>/<email>, so it is derived, never read
        // back from the record.
        const { users, tmp } = await makeUsers(t, { record: { homePath: '/opt/canvas-server/users/u@test.local' } });

        assert.deepEqual(users.getUserPaths('u1'), {
            workspaces: path.join(tmp, 'users', 'u@test.local', 'Workspaces'),
            roles: path.join(tmp, 'users', 'u@test.local', 'Roles'),
            agents: path.join(tmp, 'users', 'u@test.local', 'Agents'),
        });

        const user = await users.get('u1');
        assert.equal(user.homePath, path.join(tmp, 'users', 'u@test.local'));
    });

    test('every module is covered by the resolver', async (t) => {
        const { users } = await makeUsers(t);
        assert.deepEqual(Object.keys(users.getUserPaths('u1')).sort(), [...USER_MODULES].sort());
    });
});
