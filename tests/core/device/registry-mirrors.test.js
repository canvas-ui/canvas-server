import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import DeviceRegistry from '../../../src/core/device/Registry.js';

describe('device registry mirrors', () => {
    let home;
    let registry;

    before(async () => {
        home = await fs.mkdtemp(path.join(os.tmpdir(), 'devreg-'));
        registry = new DeviceRegistry({
            userHomePath: home,
            usersIndex: { get: () => ({ email: 'me@example.test' }) },
            logger: { warn() {}, info() {}, debug() {}, error() {} },
        });
        await registry.upsertDevice('u1', { deviceId: 'laptop', name: 'Laptop', platform: 'linux' });
    });

    after(async () => { await fs.rm(home, { recursive: true, force: true }); });

    test('mirror status is recorded per device and workspace', async () => {
        const first = await registry.updateMirrorStatus('u1', 'laptop', 'ws-1', { client: 'fuse', cursor: 10, pending: 3 });
        assert.equal(first.backend, 'workspace:home');
        assert.equal(first.cursor, 10);
        assert.ok(first.firstSeen);
        const second = await registry.updateMirrorStatus('u1', 'laptop', 'ws-1', { cursor: 12, pending: 0 });
        assert.equal(second.firstSeen, first.firstSeen);
        assert.equal(second.cursor, 12);
        assert.equal(second.client, 'fuse', 'earlier fields survive a partial patch');

        await registry.updateMirrorStatus('u1', 'laptop', 'ws-2', { cursor: 1 });
        const ws1 = await registry.listMirrorsForWorkspace('u1', 'ws-1');
        assert.equal(ws1.length, 1);
        assert.equal(ws1[0].deviceId, 'laptop');
        assert.equal(ws1[0].name, 'Laptop');
        assert.equal(ws1[0].mirror.cursor, 12);
        assert.equal((await registry.listMirrorsForWorkspace('u1', 'ws-3')).length, 0);

        await assert.rejects(() => registry.updateMirrorStatus('u1', 'ghost', 'ws-1', {}), (e) => e.code === 'DEVICE_NOT_FOUND');
    });

    test('removeMirror and removeDevice', async () => {
        assert.equal(await registry.removeMirror('u1', 'laptop', 'ws-2'), true);
        assert.equal(await registry.removeMirror('u1', 'laptop', 'ws-2'), false);
        assert.equal((await registry.listMirrorsForWorkspace('u1', 'ws-1')).length, 1);
        assert.equal(await registry.removeDevice('u1', 'laptop'), true);
        assert.equal(await registry.getDevice('u1', 'laptop'), null);
        assert.equal(await registry.removeDevice('u1', 'laptop'), false);
    });
});
