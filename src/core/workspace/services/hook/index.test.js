import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import EventEmitter from 'eventemitter2';
import HookService from './index.js';

function createWorkspace(id = 'workspace-1') {
    const workspace = new EventEmitter({ wildcard: true, delimiter: '.', newListener: false });
    workspace.id = id;
    workspace.rootPath = '/tmp/workspace';
    workspace.hooksPath = '/tmp/workspace/git/hooks';
    workspace.isActive = false;
    return workspace;
}

describe('HookService', () => {
    test('deduplicates identical workspace events briefly', async () => {
        const workspace = createWorkspace();
        const calls = [];
        const service = new HookService({
            workspaceManager: { getWorkspace: async () => workspace },
            contextManager: {},
        });
        service.registerHook({
            id: 'test-hook',
            events: ['document.inserted'],
            run: async (eventName, payload) => calls.push({ eventName, payload }),
        });

        service.trackWorkspace(workspace);
        workspace.emit('document.inserted', { id: 42, source: 'db' });
        workspace.emit('document.inserted', { id: 42, source: 'db' });
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(calls.length, 1);
    });

    test('does not dispatch hook-originated events back into hooks', async () => {
        const workspace = createWorkspace();
        const calls = [];
        const service = new HookService({
            workspaceManager: { getWorkspace: async () => workspace },
            contextManager: {},
        });
        service.registerHook({
            id: 'test-hook',
            events: ['document.inserted'],
            run: async (eventName, payload) => calls.push({ eventName, payload }),
        });

        service.trackWorkspace(workspace);
        workspace.emit('document.inserted', { id: 42, source: 'hook' });
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(calls.length, 0);
    });
});
