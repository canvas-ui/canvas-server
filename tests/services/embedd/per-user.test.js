'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Embedd from '../../../src/services/embedd/src/index.js';
import ProviderPool from '../../../src/services/embedd/src/providers/pool.js';
import { mergeConfigLayers, redactConfig } from '../../../src/services/embedd/src/config.js';

const GPU = { gpu: { type: 'openai', baseUrl: 'http://gpu.local:8000/v1' } };

// ── Layer merging ────────────────────────────────────────────────────────────

test('mergeConfigLayers: later layers win, spaces merge key-wise', () => {
    const merged = mergeConfigLayers(
        { spaces: { text: { provider: 'onnx', model: 'bge-small-en-v1.5', dim: 384, chunk: true } } },
        { spaces: { text: { model: 'bge-m3', dim: 1024 } } },
    );
    // The user changed model+dim and inherited the provider underneath — the
    // whole point of layering rather than replacing.
    assert.deepEqual(merged.spaces.text, { provider: 'onnx', model: 'bge-m3', dim: 1024, chunk: true });
});

test('mergeConfigLayers: an untouched space passes through', () => {
    const merged = mergeConfigLayers(
        { spaces: { text: { provider: 'onnx', model: 'a', dim: 1 }, image: { provider: 'clip', model: 'b', dim: 2 } } },
        { spaces: { text: { model: 'c' } } },
    );
    assert.equal(merged.spaces.image.model, 'b');
    assert.equal(merged.spaces.text.model, 'c');
});

test('mergeConfigLayers: rules replace wholesale rather than concatenating', () => {
    // Interleaving two ordered match lists produces routing nobody wrote.
    const merged = mergeConfigLayers(
        { rules: [{ space: 'text', match: {} }] },
        { rules: [{ space: 'image', match: {} }] },
    );
    assert.deepEqual(merged.rules, [{ space: 'image', match: {} }]);
});

test('mergeConfigLayers: null/absent layers are skipped', () => {
    const merged = mergeConfigLayers(null, { spaces: { text: { model: 'x' } } }, undefined);
    assert.equal(merged.spaces.text.model, 'x');
});

test('redactConfig: API keys never leave the server', () => {
    const r = redactConfig({ providers: { gpu: { type: 'openai', baseUrl: 'http://x', apiKey: 'sk-secret', headers: { 'x-tenant': 'acme' } } } });
    assert.equal(r.providers.gpu.apiKey, undefined);
    assert.equal(r.providers.gpu.apiKeySet, true, 'the UI still needs to know one is set');
    assert.equal(r.providers.gpu.headers, undefined);
    assert.deepEqual(r.providers.gpu.headerNames, ['x-tenant'], 'names are safe, values are not');
    assert.equal(r.providers.gpu.baseUrl, 'http://x');
});

// ── Per-user resolution ──────────────────────────────────────────────────────

test('embedd: a user with no config gets the server defaults', async () => {
    const e = new Embedd({
        providers: GPU,
        spaces: { text: { provider: 'gpu', model: 'server-model', dim: 512, chunk: true } },
        resolveUserConfig: async () => null,
    });
    const router = await e.routerFor('alice');
    assert.equal(router.spaceRule('text').model, 'server-model');
    await e.stop();
});

test('embedd: a user override wins over the server default, per space', async () => {
    const e = new Embedd({
        providers: GPU,
        spaces: { text: { provider: 'gpu', model: 'server-model', dim: 512, chunk: true } },
        resolveUserConfig: async (u) => (u === 'alice'
            ? { spaces: { text: { model: 'alice-model', dim: 1024 } } }
            : null),
    });
    const alice = await e.routerFor('alice');
    const bob = await e.routerFor('bob');
    assert.equal(alice.spaceRule('text').model, 'alice-model');
    assert.equal(alice.spaceRule('text').dim, 1024);
    assert.equal(alice.spaceRule('text').provider, 'gpu', 'provider inherited from the server layer');
    assert.equal(bob.spaceRule('text').model, 'server-model', 'other users are unaffected');
    // The image space nobody touched still resolves.
    assert.equal(alice.spaceRule('image').provider, 'clip');
    await e.stop();
});

test('embedd: a user can declare their own provider', async () => {
    const e = new Embedd({
        resolveUserConfig: async () => ({
            providers: { mine: { type: 'openai', baseUrl: 'http://my-box:8000/v1' } },
            spaces: { text: { provider: 'mine', model: 'bge-m3', dim: 1024, chunk: true } },
        }),
    });
    const router = await e.routerFor('alice');
    assert.equal(router.spaceRule('text').provider, 'mine');
    await e.stop();
});

test('embedd: a broken user config falls back to server defaults instead of throwing', async () => {
    // This is data a user typed into a form. It must never take the server down
    // or leave their workspace unable to embed at all.
    const e = new Embedd({
        resolveUserConfig: async () => ({ spaces: { text: { provider: 'does-not-exist', model: 'm', dim: 1 } } }),
    });
    const router = await e.routerFor('alice');
    assert.equal(router.spaceRule('text').provider, 'onnx', 'fell back to the default backend');
    const ctx = await e.contextFor('alice');
    assert.match(ctx.invalid, /undeclared provider 'does-not-exist'/, 'and says why');
    await e.stop();
});

test('embedd: a broken SERVER config throws at construction', async () => {
    // The operator layer is the opposite case — fail loudly at boot.
    assert.throws(
        () => new Embedd({ spaces: { text: { provider: 'nope', model: 'm', dim: 1 } } }),
        /undeclared provider 'nope'/,
    );
});

test('embedd: a config resolver that throws degrades to defaults', async () => {
    const e = new Embedd({ resolveUserConfig: async () => { throw new Error('disk on fire'); } });
    const router = await e.routerFor('alice');
    assert.equal(router.spaceRule('text').model, 'bge-small-en-v1.5');
    await e.stop();
});

test('embedd: invalidateUser re-reads config on the next use', async () => {
    let model = 'first';
    const e = new Embedd({ resolveUserConfig: async () => ({ spaces: { text: { model, dim: 384 } } }) });

    assert.equal((await e.routerFor('alice')).spaceRule('text').model, 'first');
    model = 'second';
    assert.equal((await e.routerFor('alice')).spaceRule('text').model, 'first', 'cached until invalidated');
    e.invalidateUser('alice');
    assert.equal((await e.routerFor('alice')).spaceRule('text').model, 'second');
    await e.stop();
});

test('embedd: spaceConfigsFor is per user, so two users get different Lance tables', async () => {
    const e = new Embedd({
        providers: GPU,
        resolveUserConfig: async (u) => (u === 'alice'
            ? { spaces: { text: { provider: 'gpu', model: 'Qwen/Qwen3-Embedding-0.6B', dim: 1024 } } }
            : null),
    });
    const alice = await e.spaceConfigsFor('alice');
    const bob = await e.spaceConfigsFor('bob');
    assert.equal(alice.text.table, undefined, 'non-baseline → model-keyed table');
    assert.equal(alice.text.bitmapKey, 'internal/embed/vectors/text/qwen-qwen3-embedding-0.6b');
    assert.equal(bob.text.table, 'vec_text', 'baseline → the original table');
    assert.equal(bob.text.bitmapKey, 'internal/embed/vectors/text/bge-small-en-v1.5');
    await e.stop();
});

test('embedd: a workspace embeds with its OWNER config', async () => {
    const routed = [];
    const e = new Embedd({
        providers: GPU,
        resolveUserConfig: async (u) => (u === 'alice'
            ? { spaces: { text: { provider: 'gpu', model: 'alice-model', dim: 1024 } } }
            : null),
    });
    e.registerWorkspace('ws-a', {
        // Report which model the pipeline picked, then bail before any provider call.
        resolveInput: async () => { routed.push((await e.routerFor('alice')).spaceRule('text').model); return null; },
        storeVectors: async () => {},
    }, { userId: 'alice' });

    assert.deepEqual(e.workspacesOf('alice'), ['ws-a']);
    e.enqueue('ws-a', 1);
    await e.drained();
    assert.deepEqual(routed, ['alice-model']);
    await e.stop();
});

// ── Provider pooling ─────────────────────────────────────────────────────────

test('pool: identical backend configs share one instance', () => {
    const pool = new ProviderPool();
    const a = pool.get('gpu', { type: 'openai', baseUrl: 'http://gpu:8000/v1' });
    const b = pool.get('their-gpu', { type: 'openai', baseUrl: 'http://gpu:8000/v1' });
    assert.equal(a, b, 'two users on the same endpoint must not open two clients');
    assert.equal(pool.size, 1);
});

test('pool: key order does not affect identity', () => {
    const pool = new ProviderPool();
    pool.get('a', { type: 'openai', baseUrl: 'http://x/v1', apiKey: 'k' });
    pool.get('b', { apiKey: 'k', baseUrl: 'http://x/v1', type: 'openai' });
    assert.equal(pool.size, 1);
});

test('pool: differing options get separate instances', () => {
    const pool = new ProviderPool();
    pool.get('a', { type: 'openai', baseUrl: 'http://gpu-1:8000/v1' });
    pool.get('b', { type: 'openai', baseUrl: 'http://gpu-2:8000/v1' });
    assert.equal(pool.size, 2);
});

test('embedd: users on the same backend share the model runtime', async () => {
    // Per-user config must not become per-user model processes.
    const e = new Embedd({
        providers: GPU,
        resolveUserConfig: async () => ({ spaces: { text: { provider: 'gpu', model: 'shared', dim: 8 } } }),
    });
    const alice = await e.contextFor('alice');
    const bob = await e.contextFor('bob');
    assert.equal(alice.providers.get('gpu'), bob.providers.get('gpu'));
    assert.equal(alice.providers.get('onnx'), bob.providers.get('onnx'), 'the local ONNX runtime stays shared too');
    await e.stop();
});
