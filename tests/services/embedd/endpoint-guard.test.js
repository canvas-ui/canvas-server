'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEndpoint, checkConfigEndpoints, endpointFor } from '../../../src/services/embedd/src/endpoint-guard.js';
import Embedd from '../../../src/services/embedd/src/index.js';

// ── What must be refused ─────────────────────────────────────────────────────

test('guard: cloud metadata address is refused', async () => {
    const v = await checkEndpoint('http://169.254.169.254/latest/meta-data/');
    assert.equal(v.ok, false);
    assert.match(v.reason, /link-local|metadata/);
});

test('guard: the whole 169.254/16 range is refused, not just .169.254', async () => {
    assert.equal((await checkEndpoint('http://169.254.1.1:8000/v1')).ok, false);
});

test('guard: the GCP metadata hostname is refused without resolving it', async () => {
    const v = await checkEndpoint('http://metadata.google.internal/computeMetadata/v1/');
    assert.equal(v.ok, false);
    assert.match(v.reason, /metadata/);
});

test('guard: non-http schemes are refused', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x/', 'ftp://host/']) {
        const v = await checkEndpoint(url);
        assert.equal(v.ok, false, url);
        assert.match(v.reason, /unsupported scheme/);
    }
});

test('guard: garbage is refused rather than thrown', async () => {
    const v = await checkEndpoint('not a url at all');
    assert.equal(v.ok, false);
    assert.match(v.reason, /not a valid URL/);
});

// ── What must keep working ───────────────────────────────────────────────────

test('guard: loopback is ALLOWED — Ollama defaults to 127.0.0.1:11434', async () => {
    // Blocking loopback would be "safer" and would break the main use case.
    // The compensating control is that error bodies never reach a non-admin.
    assert.equal((await checkEndpoint('http://127.0.0.1:11434')).ok, true);
});

test('guard: private ranges are ALLOWED — that is where a GPU box lives', async () => {
    for (const url of ['http://10.0.0.5:8000/v1', 'http://192.168.1.50:7997', 'http://172.16.4.4:8000']) {
        assert.equal((await checkEndpoint(url)).ok, true, url);
    }
});

// ── Admin allowlist ──────────────────────────────────────────────────────────

test('guard: an allowlist restricts to named hosts', async () => {
    const policy = { allowHosts: ['gpu.local', '10.0.0.5'] };
    assert.equal((await checkEndpoint('http://10.0.0.5:8000/v1', policy)).ok, true);
    const v = await checkEndpoint('http://192.168.1.50:8000/v1', policy);
    assert.equal(v.ok, false);
    assert.match(v.reason, /not in the server's allowed embedding hosts/);
});

test('guard: allowlist supports *.suffix', async () => {
    const policy = { allowHosts: ['*.internal.example'] };
    // A suffix match clears the allowlist; these names do not exist, so the
    // verdict then turns on DNS. Assert on the REASON so the test does not
    // depend on a resolver — what matters is which check rejected it.
    const matched = await checkEndpoint('http://gpu-1.internal.example:8000/v1', policy);
    assert.doesNotMatch(matched.reason || '', /allowed embedding hosts/, 'suffix match passed the allowlist');

    const unmatched = await checkEndpoint('http://evil.example:8000/v1', policy);
    assert.equal(unmatched.ok, false);
    assert.match(unmatched.reason, /not in the server's allowed embedding hosts/);
});

test('guard: an unresolvable host is refused rather than assumed safe', async () => {
    const v = await checkEndpoint('http://this-host-does-not-exist.invalid:8000/v1');
    assert.equal(v.ok, false);
    assert.match(v.reason, /could not resolve host/);
});

test('guard: an allowlist does not override the blocked ranges', async () => {
    // Metadata stays refused even if an admin lists it, deliberately or not.
    const v = await checkEndpoint('http://169.254.169.254/', { allowHosts: ['169.254.169.254'] });
    assert.equal(v.ok, false);
});

// ── Whole-config checking ────────────────────────────────────────────────────

test('guard: checkConfigEndpoints reports every offending provider by id', async () => {
    const problems = await checkConfigEndpoints({
        providers: {
            good: { type: 'openai', baseUrl: 'http://10.0.0.5:8000/v1' },
            bad: { type: 'openai', baseUrl: 'http://169.254.169.254/' },
            alsoBad: { type: 'ollama', host: 'http://metadata.google.internal' },
            local: { type: 'onnx', cacheDir: '/srv/models' },
        },
    });
    assert.equal(problems.length, 2);
    assert.ok(problems.some((p) => p.startsWith("provider 'bad'")));
    assert.ok(problems.some((p) => p.startsWith("provider 'alsoBad'")));
});

test('guard: a URL the provider type never reads does not block the config', async () => {
    // The ollama class reads `host` and never `baseUrl`. A leftover baseUrl —
    // easy to acquire by switching a provider's type in the UI — is inert, so
    // failing the save on it locks the user out of a perfectly good config.
    const problems = await checkConfigEndpoints({
        providers: {
            ollama: { type: 'ollama', host: 'http://127.0.0.1:11434', baseUrl: '/v1' },
        },
    });
    assert.deepEqual(problems, []);
});

test('guard: the field a provider DOES read is still checked after a type switch', async () => {
    const problems = await checkConfigEndpoints({
        providers: {
            // Same spec, now openai — baseUrl is live and must be judged.
            gpu: { type: 'openai', baseUrl: 'http://169.254.169.254/v1', host: 'http://127.0.0.1:11434' },
        },
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /baseUrl/);
});

test('guard: endpointFor names the field each provider type fetches', () => {
    assert.deepEqual(endpointFor({ type: 'openai', baseUrl: 'http://h/v1' }), { field: 'baseUrl', value: 'http://h/v1' });
    assert.deepEqual(endpointFor({ type: 'ollama', host: 'http://h' }), { field: 'host', value: 'http://h' });
    assert.equal(endpointFor({ type: 'onnx', cacheDir: '/srv' }), null);
    assert.equal(endpointFor({ type: 'ollama' }), null);
});

test('guard: providers with no URL (onnx/clip) are not checked', async () => {
    const problems = await checkConfigEndpoints({
        providers: { onnx: { type: 'onnx', cacheDir: null }, clip: { type: 'clip', cacheDir: null } },
    });
    assert.deepEqual(problems, []);
});

// ── Runtime config hooks the API depends on ──────────────────────────────────

test('embedd.validate: checks a candidate without adopting it', async () => {
    const e = new Embedd();
    const before = (await e.routerFor(null)).spaceRule('text').model;
    e.validate({ spaces: { text: { model: 'candidate', dim: 999 } } });
    assert.equal((await e.routerFor(null)).spaceRule('text').model, before, 'validation must not mutate');
    assert.throws(() => e.validate({ spaces: { text: { provider: 'ghost', model: 'm', dim: 1 } } }), /undeclared provider/);
    await e.stop();
});

test('embedd.setServerConfig: adopts a good config and invalidates every user', async () => {
    const e = new Embedd({ resolveUserConfig: async () => null });
    assert.equal((await e.routerFor('alice')).spaceRule('text').model, 'bge-small-en-v1.5');
    e.setServerConfig({ spaces: { text: { model: 'new-default', dim: 384 } } });
    assert.equal((await e.routerFor('alice')).spaceRule('text').model, 'new-default', 'users sit on top of the defaults');
    await e.stop();
});

test('embedd.setServerConfig: a bad config is rejected and leaves the old one running', async () => {
    const e = new Embedd();
    assert.throws(() => e.setServerConfig({ spaces: { text: { provider: 'ghost', model: 'm', dim: 1 } } }), /undeclared provider/);
    assert.equal((await e.routerFor(null)).spaceRule('text').model, 'bge-small-en-v1.5', 'still serving the previous config');
    await e.stop();
});
