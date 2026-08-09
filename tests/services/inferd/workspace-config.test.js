'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Inferd from '../../../src/services/inferd/src/index.js';

const GPU = { gpu: { type: 'openai', baseUrl: 'http://gpu.local:8000/v1' } };

const noop = { resolveInput: async () => null, storeVectors: async () => {} };

// ── Layer precedence ─────────────────────────────────────────────────────────

test('workspace config wins over the user and server layers', async () => {
    const e = new Inferd({
        providers: GPU,
        spaces: { text: { provider: 'gpu', model: 'server-model', dim: 512 } },
        resolveUserConfig: async () => ({ spaces: { text: { model: 'user-model', dim: 640 } } }),
    });
    const ctx = await e.resolve({
        userId: 'alice',
        workspaceConfig: { spaces: { text: { model: 'workspace-model', dim: 1024 } } },
        cacheKey: 'w:ws1',
    });
    assert.equal(ctx.router.spaceRule('text').model, 'workspace-model');
    assert.equal(ctx.router.spaceRule('text').dim, 1024);
    // Still inherits the provider from the server layer it never restated.
    assert.equal(ctx.router.spaceRule('text').provider, 'gpu');
    await e.stop();
});

test('a workspace with no config of its own inherits the user layer', async () => {
    const e = new Inferd({
        resolveUserConfig: async () => ({ spaces: { text: { model: 'user-model', dim: 640 } } }),
    });
    const ctx = await e.resolve({ userId: 'alice', workspaceConfig: {}, cacheKey: 'w:ws1' });
    assert.equal(ctx.router.spaceRule('text').model, 'user-model');
    await e.stop();
});

test('a workspace can override one modality and inherit the other', async () => {
    const e = new Inferd({ providers: GPU });
    const ctx = await e.resolve({
        workspaceConfig: { spaces: { image: { provider: 'gpu', model: 'siglip-remote', dim: 768 } } },
        cacheKey: 'w:ws1',
    });
    assert.equal(ctx.router.spaceRule('image').model, 'siglip-remote');
    assert.equal(ctx.router.spaceRule('text').model, 'bge-small-en-v1.5', 'text untouched');
    await e.stop();
});

test('two workspaces of the same user can run different models', async () => {
    // This is the portability point: config belongs to the workspace, not the
    // account, so one can be migrated to a new model while the other is not.
    const e = new Inferd({ providers: GPU });
    e.registerWorkspace('ws-a', noop, { userId: 'alice', config: { spaces: { text: { provider: 'gpu', model: 'new', dim: 1024 } } } });
    e.registerWorkspace('ws-b', noop, { userId: 'alice' });

    const a = await e.contextForWorkspace('ws-a');
    const b = await e.contextForWorkspace('ws-b');
    assert.equal(a.router.spaceRule('text').model, 'new');
    assert.equal(b.router.spaceRule('text').model, 'bge-small-en-v1.5');
    await e.stop();
});

test('a workspace on a new model gets its own tables and ledgers', async () => {
    const e = new Inferd({ providers: GPU });
    const migrated = await e.spaceConfigsForWorkspace('ws-a', {
        config: { spaces: { text: { provider: 'gpu', model: 'Qwen/Qwen3-Embedding-0.6B', dim: 1024 } } },
    });
    const untouched = await e.spaceConfigsForWorkspace('ws-b', {});

    assert.equal(migrated.text.table, undefined, 'model-keyed table');
    assert.equal(migrated.text.bitmapKey, 'internal/embed/vectors/text/qwen-qwen3-embedding-0.6b');
    // The old model's table and ledger are untouched, which is what makes the
    // revert in step 3 of the swap flow free.
    assert.equal(untouched.text.table, 'vec_text');
    assert.equal(untouched.text.bitmapKey, 'internal/embed/vectors/text/bge-small-en-v1.5');
    await e.stop();
});

test('a broken workspace config falls back instead of breaking the workspace', async () => {
    const e = new Inferd();
    const ctx = await e.resolve({
        workspaceConfig: { spaces: { text: { provider: 'ghost', model: 'm', dim: 1 } } },
        cacheKey: 'w:ws1',
    });
    assert.equal(ctx.router.spaceRule('text').provider, 'onnx');
    assert.match(ctx.invalid, /undeclared provider 'ghost'/);
    await e.stop();
});

test('invalidateWorkspace adopts a new config without touching other workspaces', async () => {
    const e = new Inferd({ providers: GPU });
    e.registerWorkspace('ws-a', noop, { userId: 'alice' });
    e.registerWorkspace('ws-b', noop, { userId: 'alice' });
    assert.equal((await e.contextForWorkspace('ws-a')).router.spaceRule('text').model, 'bge-small-en-v1.5');

    e.invalidateWorkspace('ws-a', { spaces: { text: { provider: 'gpu', model: 'switched', dim: 1024 } } });
    assert.equal((await e.contextForWorkspace('ws-a')).router.spaceRule('text').model, 'switched');
    assert.equal((await e.contextForWorkspace('ws-b')).router.spaceRule('text').model, 'bge-small-en-v1.5');
    await e.stop();
});

test('invalidateUser also drops the resolved configs of that user workspaces', async () => {
    let model = 'first';
    const e = new Inferd({ resolveUserConfig: async () => ({ spaces: { text: { model, dim: 384 } } }) });
    e.registerWorkspace('ws-a', noop, { userId: 'alice' });
    assert.equal((await e.contextForWorkspace('ws-a')).router.spaceRule('text').model, 'first');

    model = 'second';
    e.invalidateUser('alice');
    assert.equal((await e.contextForWorkspace('ws-a')).router.spaceRule('text').model, 'second',
        'a workspace inheriting the user layer must see the change');
    await e.stop();
});

// ── Scoped reconcile ─────────────────────────────────────────────────────────

function scopedWorkspace(gap, scoped) {
    return {
        resolveInput: async () => null,
        storeVectors: async () => {},
        getUnembedded: async () => gap,
        documentIdsUnderScope: async (scope) => (scope in scoped ? scoped[scope] : null),
    };
}

test('reconcile: a scope restricts the drain to documents under that path', async () => {
    const e = new Inferd();
    e.registerWorkspace('ws1', scopedWorkspace([1, 2, 3, 4, 5], { 'ctx://work': [2, 4] }));
    const res = await e.reconcile('ws1', { space: 'text', scope: 'ctx://work' });
    assert.equal(res.enqueued, 2, 'only the in-scope half of the gap');
    assert.equal(res.scope, 'ctx://work');
    assert.equal(res.scopedDocs, 2);
    await e.drained();
    await e.stop();
});

test('reconcile: no scope drains the whole gap, as before', async () => {
    const e = new Inferd();
    e.registerWorkspace('ws1', scopedWorkspace([1, 2, 3, 4, 5], {}));
    const res = await e.reconcile('ws1', { space: 'text' });
    assert.equal(res.enqueued, 5);
    assert.equal(res.scope, undefined);
    await e.drained();
    await e.stop();
});

test('reconcile: an unknown scope is an error, not a silent no-op', async () => {
    const e = new Inferd();
    e.registerWorkspace('ws1', scopedWorkspace([1, 2], { 'ctx://work': [1] }));
    const res = await e.reconcile('ws1', { scope: 'ctx://nope' });
    assert.match(res.error, /unknown scope 'ctx:\/\/nope'/);
    await e.stop();
});

test('reconcile: an empty scope enqueues nothing and says so', async () => {
    const e = new Inferd();
    e.registerWorkspace('ws1', scopedWorkspace([1, 2, 3], { 'dir://empty': [] }));
    const res = await e.reconcile('ws1', { scope: 'dir://empty' });
    assert.equal(res.enqueued, 0);
    assert.equal(res.scopedDocs, 0);
    await e.stop();
});

test('reconcile: a workspace that cannot resolve scopes reports that', async () => {
    const e = new Inferd();
    e.registerWorkspace('ws1', { resolveInput: async () => null, storeVectors: async () => {}, getUnembedded: async () => [1] });
    const res = await e.reconcile('ws1', { scope: 'ctx://work' });
    assert.match(res.error, /cannot resolve a scope path/);
    await e.stop();
});
