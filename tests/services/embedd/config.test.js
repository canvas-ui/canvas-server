'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, toMatcher, builtinProviders } from '../../../src/services/embedd/src/config.js';
import { createProviders } from '../../../src/services/embedd/src/providers/index.js';
import Router, { DEFAULT_RULES } from '../../../src/services/embedd/src/router.js';
import Embedd from '../../../src/services/embedd/src/index.js';

// ── Matchers ─────────────────────────────────────────────────────────────────

test('toMatcher: exact string stays a string', () => {
    assert.equal(toMatcher('data/abstraction/note'), 'data/abstraction/note');
});

test('toMatcher: "image/*" compiles to a prefix regex', () => {
    const m = toMatcher('image/*');
    assert.ok(m instanceof RegExp);
    assert.ok(m.test('image/png'));
    assert.ok(!m.test('text/plain'));
    // The slash is anchored, so "imagemagick/x" must not sneak through.
    assert.ok(!m.test('imagemagick/x'));
});

test('toMatcher: "/regex/flags" compiles with its flags', () => {
    const m = toMatcher('/^text\\/(plain|markdown)$/i');
    assert.ok(m instanceof RegExp);
    assert.ok(m.test('TEXT/PLAIN'));
    assert.ok(!m.test('text/html'));
});

test('toMatcher: a RegExp passes through untouched', () => {
    const re = /^audio\//;
    assert.equal(toMatcher(re), re);
});

// ── Defaults ─────────────────────────────────────────────────────────────────

test('normalizeConfig: no config reproduces the built-in providers + DEFAULT_RULES', () => {
    const { providers, rules } = normalizeConfig();
    assert.deepEqual(Object.keys(providers).sort(), ['clip', 'ollama', 'onnx']);
    assert.equal(providers.onnx.type, 'onnx');
    assert.equal(rules.length, DEFAULT_RULES.length);
    // Routing is unchanged, which is the point: adding config must not move
    // a single existing document to a different space.
    const r = new Router({ rules });
    assert.equal(r.route({ modality: 'text', schema: 'data/abstraction/note' }).space, 'text');
    assert.equal(r.route({ modality: 'image', schema: 'data/abstraction/file', contentType: 'image/png' }).space, 'image');
});

test('builtinProviders: server settings feed the built-ins (clip falls back to the onnx cache)', () => {
    const p = builtinProviders({ onnxCacheDir: '/srv/models', ollamaHost: 'http://gpu:11434' });
    assert.equal(p.onnx.cacheDir, '/srv/models');
    assert.equal(p.clip.cacheDir, '/srv/models');
    assert.equal(p.ollama.host, 'http://gpu:11434');
});

// ── Declared providers ───────────────────────────────────────────────────────

test('normalizeConfig: declaring a provider adds it alongside the built-ins', () => {
    const { providers } = normalizeConfig({
        providers: { gpu: { type: 'openai', baseUrl: 'http://gpu.local:8000/v1' } },
    });
    assert.equal(providers.gpu.type, 'openai');
    assert.equal(providers.gpu.baseUrl, 'http://gpu.local:8000/v1');
    assert.ok(providers.onnx, 'built-ins survive');
});

test('normalizeConfig: re-declaring a built-in merges over its defaults', () => {
    const { providers } = normalizeConfig({
        onnxCacheDir: '/srv/models',
        providers: { ollama: { host: 'http://gpu.local:11434' } },
    });
    assert.equal(providers.ollama.type, 'ollama', 'type is inherited, not required again');
    assert.equal(providers.ollama.host, 'http://gpu.local:11434');
});

test('normalizeConfig: unknown provider type throws', () => {
    assert.throws(
        () => normalizeConfig({ providers: { x: { type: 'telepathy' } } }),
        /unknown type 'telepathy'/,
    );
});

test('normalizeConfig: a rule naming an undeclared provider throws (never silently unrouted)', () => {
    assert.throws(
        () => normalizeConfig({
            rules: [{ space: 'text', provider: 'gpu', model: 'm', dim: 384, match: {} }],
        }),
        /undeclared provider 'gpu'/,
    );
});

test('normalizeConfig: a rule without a usable dim throws (it sizes the Lance table)', () => {
    assert.throws(
        () => normalizeConfig({
            rules: [{ space: 'text', provider: 'onnx', model: 'm', match: {} }],
        }),
        /positive integer `dim`/,
    );
});

test('normalizeConfig: JSON matchers are compiled on the way in', () => {
    const { rules, spaces } = normalizeConfig({
        providers: { gpu: { type: 'openai', baseUrl: 'http://gpu.local:7997' } },
        spaces: { image: { provider: 'gpu', model: 'siglip', dim: 768, chunk: false } },
        rules: [{ space: 'image', match: { contentType: 'image/*' } }],
    });
    const r = new Router({ rules, spaces });
    assert.equal(r.route({ modality: 'image', schema: 'data/abstraction/file', contentType: 'image/jpeg' }).provider, 'gpu');
});

test('normalizeConfig: the pre-split shape (provider/model on the rule) still loads', () => {
    // The first cut shipped provider+model+dim inline on each rule, and that is
    // what the example config shows. Keep reading it: the first rule to describe
    // a space defines that space's backend, and the rule keeps its routing half.
    const { rules, spaces } = normalizeConfig({
        providers: { gpu: { type: 'openai', baseUrl: 'http://gpu.local:7997' } },
        rules: [{ space: 'image', provider: 'gpu', model: 'siglip', dim: 768, chunk: false, match: { contentType: 'image/*' } }],
    });
    assert.deepEqual(spaces.image, { provider: 'gpu', model: 'siglip', dim: 768, chunk: false });
    assert.deepEqual(rules, [{ space: 'image', match: { contentType: /^image\// } }]);
    const r = new Router({ rules, spaces });
    assert.equal(r.route({ modality: 'image', schema: 'data/abstraction/file', contentType: 'image/png' }).provider, 'gpu');
});

test('normalizeConfig: a space override leaves the other spaces on their defaults', () => {
    // Partial config is the norm once users override one modality.
    const { spaces } = normalizeConfig({
        providers: { gpu: { type: 'openai', baseUrl: 'http://gpu.local:8000/v1' } },
        spaces: { text: { provider: 'gpu', model: 'bge-m3', dim: 1024, chunk: true } },
    });
    assert.equal(spaces.text.provider, 'gpu');
    assert.equal(spaces.image.provider, 'clip', 'untouched space keeps its default backend');
});

test('normalizeConfig: a rule routing to a space with no backend throws', () => {
    assert.throws(
        () => normalizeConfig({ rules: [{ space: 'audio', match: { contentType: 'audio/*' } }] }),
        /space 'audio', which has no configured backend/,
    );
});

// ── Provider factory ─────────────────────────────────────────────────────────

test('createProviders: builds one instance per declared id, id-tagged', () => {
    const { providers } = normalizeConfig({
        providers: { gpu: { type: 'openai', baseUrl: 'http://gpu.local:8000/v1' } },
    });
    const map = createProviders(providers);
    assert.deepEqual([...map.keys()].sort(), ['clip', 'gpu', 'ollama', 'onnx']);
    assert.equal(map.get('gpu').id, 'gpu');
    assert.equal(map.get('onnx').id, 'onnx');
});

test('createProviders: an openai provider without a baseUrl fails at build time, not mid-ingest', () => {
    assert.throws(() => createProviders({ gpu: { type: 'openai' } }), /baseUrl required/);
});

// ── Space configs (model lifecycle) ──────────────────────────────────────────

test('spaceConfigs: baseline models keep the original Lance tables', async () => {
    const e = new Embedd();
    const sc = await e.spaceConfigsFor(null);
    // An explicit `table` pins the space to its pre-config table, so existing
    // vectors stay attached. This is the guarantee that making the model
    // configurable orphans nothing. Text still runs its baseline model; image's
    // DEFAULT moved off the baseline (SigLIP → CLIP ViT-B/32), so it gets a
    // model-keyed table and vec_image stays untouched for pre-config workspaces.
    assert.equal(sc.text.table, 'vec_text');
    assert.equal(sc.image.table, undefined, 'non-baseline default → model-keyed table, vec_image preserved');
    assert.equal(sc.image.model, 'Xenova/clip-vit-base-patch32');
    assert.equal(sc.image.dim, 512);
    assert.equal(sc.image.annIndex, false, 'cross-modal kNN stays an exact scan');
    await e.stop();
});

test('spaceConfigs: ledger keys are always (space, model) with the model as the leaf', async () => {
    const e = new Embedd();
    const sc = await e.spaceConfigsFor(null);
    // Uniform even for baseline spaces. A namespace must never also be a key:
    // listBitmaps() range-scans strictly below `prefix + '/'`, so a bare
    // `.../vectors/text` above `.../vectors/text/<slug>` would be unlistable
    // under its own namespace — the defect the legacy `internal/lance/vectors`
    // key had (it was text's bitmap AND image's parent path).
    assert.equal(sc.text.bitmapKey, 'internal/embed/vectors/text/bge-small-en-v1.5');
    assert.equal(sc.text.seenKey, 'internal/embed/seen/text/bge-small-en-v1.5');
    assert.equal(sc.image.bitmapKey, 'internal/embed/vectors/image/xenova-clip-vit-base-patch32');
    assert.equal(sc.image.seenKey, 'internal/embed/seen/image/xenova-clip-vit-base-patch32');
    // Both ledgers share one root, so `internal/embed` lists every embedding
    // bitmap and `internal/embed/vectors/text` lists every text model.
    for (const cfg of Object.values(sc)) {
        assert.ok(cfg.bitmapKey.startsWith('internal/embed/vectors/'));
        assert.ok(cfg.seenKey.startsWith('internal/embed/seen/'));
        assert.equal(cfg.bitmapKey.split('/').length, 5, 'space + model slug, no bare namespace key');
    }
    await e.stop();
});

test('spaceConfigs: a non-baseline model gets its own table AND its own ledger', async () => {
    const e = new Embedd({
        providers: { gpu: { type: 'openai', baseUrl: 'http://gpu.local:8000/v1' } },
        rules: [{
            space: 'text', provider: 'gpu', model: 'Qwen/Qwen3-Embedding-0.6B', dim: 1024,
            chunk: true, match: { schema: 'data/abstraction/note' },
        }],
    });
    const sc = await e.spaceConfigsFor(null);
    assert.equal(sc.text.model, 'Qwen/Qwen3-Embedding-0.6B');
    assert.equal(sc.text.dim, 1024);
    assert.equal(sc.text.table, undefined, 'synapsd derives vec_text__<slug>__<dim>');
    // Model-scoped presence + seen keys are what make a revert free: switch back
    // and the old model's vectors are still there AND still marked embedded.
    assert.equal(sc.text.bitmapKey, 'internal/embed/vectors/text/qwen-qwen3-embedding-0.6b');
    assert.equal(sc.text.seenKey, 'internal/embed/seen/text/qwen-qwen3-embedding-0.6b');
    await e.stop();
});

test('spaceConfigs: same space, same model, different dim is still a new space', async () => {
    // Matryoshka truncation changes the vectors, so it must not reuse the table.
    const e = new Embedd({
        rules: [{
            space: 'text', provider: 'onnx', model: 'bge-small-en-v1.5', dim: 256,
            chunk: true, match: { schema: 'data/abstraction/note' },
        }],
    });
    const sc = await e.spaceConfigsFor(null);
    assert.equal(sc.text.table, undefined);
    assert.equal(sc.text.dim, 256);
    await e.stop();
});

test('spaceConfigs: a new modality slots in with no code change', async () => {
    // The naming convention has to hold for spaces that do not exist yet —
    // audio, spatial, whatever comes next.
    const e = new Embedd({
        providers: { gpu: { type: 'openai', baseUrl: 'http://gpu.local:8000/v1' } },
        rules: [
            { space: 'text', provider: 'onnx', model: 'bge-small-en-v1.5', dim: 384, chunk: true, match: { schema: 'data/abstraction/note' } },
            { space: 'audio', provider: 'gpu', model: 'laion/clap-htsat-unfused', dim: 512, chunk: false, match: { contentType: 'audio/*' } },
        ],
    });
    const sc = await e.spaceConfigsFor(null);
    assert.equal(sc.audio.bitmapKey, 'internal/embed/vectors/audio/laion-clap-htsat-unfused');
    assert.equal(sc.audio.seenKey, 'internal/embed/seen/audio/laion-clap-htsat-unfused');
    assert.equal(sc.audio.table, undefined, 'no baseline → model-keyed table');
    await e.stop();
});
