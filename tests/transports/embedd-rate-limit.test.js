'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';

/**
 * The rate-limit wiring is easy to get wrong in a way unit tests of the route
 * handlers would never catch, so these boot a real fastify instance.
 *
 * The property that matters: `global: false` is the ONLY thing keeping the
 * limiter off every route that has not opted in. Drop it and the paths that
 * legitimately burst — CLI bulk uploads, WebDAV, the fs indexer — start getting
 * throttled on a server nobody thought they were changing.
 */

async function build({ global: globalFlag = false } = {}) {
    const app = Fastify();
    await app.register(fastifyRateLimit, {
        global: globalFlag,
        keyGenerator: (request) => request.user?.id || request.ip,
    });
    // Stand-in for an authenticated user, so the key generator has something.
    app.addHook('onRequest', async (request) => {
        request.user = { id: request.headers['x-test-user'] || 'alice' };
    });
    app.get('/unlimited', async () => ({ ok: true }));
    app.put('/limited', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
    await app.ready();
    return app;
}

test('rate limit: an opted-in route is capped', async () => {
    const app = await build();
    for (let i = 0; i < 3; i++) {
        const res = await app.inject({ method: 'PUT', url: '/limited' });
        assert.equal(res.statusCode, 200, `request ${i + 1} should pass`);
    }
    const blocked = await app.inject({ method: 'PUT', url: '/limited' });
    assert.equal(blocked.statusCode, 429);
    await app.close();
});

test('rate limit: global:false leaves every other route untouched', async () => {
    // The property that makes this safe to add to a server doing bulk uploads.
    const app = await build();
    for (let i = 0; i < 25; i++) {
        const res = await app.inject({ method: 'GET', url: '/unlimited' });
        assert.equal(res.statusCode, 200, `unlimited route throttled at ${i + 1}`);
    }
    await app.close();
});

test('rate limit: buckets are per user, not per IP', async () => {
    // Several users behind one NAT must not share a bucket.
    const app = await build();
    for (let i = 0; i < 3; i++) {
        await app.inject({ method: 'PUT', url: '/limited', headers: { 'x-test-user': 'alice' } });
    }
    const aliceBlocked = await app.inject({ method: 'PUT', url: '/limited', headers: { 'x-test-user': 'alice' } });
    assert.equal(aliceBlocked.statusCode, 429, 'alice is over her limit');

    const bob = await app.inject({ method: 'PUT', url: '/limited', headers: { 'x-test-user': 'bob' } });
    assert.equal(bob.statusCode, 200, 'bob has his own bucket');
    await app.close();
});

test('rate limit: a second registration in a child scope applies only there', async () => {
    // @fastify/rate-limit is fastify-plugin wrapped, which usually means a
    // plugin escapes encapsulation entirely — but its OPTIONS still resolve per
    // scope. Pinned because it is the non-obvious bit: a future change that
    // registers it inside a route plugin will work rather than fail loudly, and
    // will quietly shadow the root settings for that subtree only.
    const app = Fastify();
    await app.register(fastifyRateLimit, { global: false });
    await app.register(async (child) => {
        await child.register(fastifyRateLimit, { global: true, max: 1 });
        child.get('/child', async () => ({ ok: true }));
    });
    app.get('/root', async () => ({ ok: true }));
    await app.ready();

    assert.equal((await app.inject({ method: 'GET', url: '/child' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/child' })).statusCode, 429,
        'the child scope got its own global limiter');
    for (let i = 0; i < 4; i++) {
        assert.equal((await app.inject({ method: 'GET', url: '/root' })).statusCode, 200,
            'the root scope kept global:false');
    }
    await app.close();
});
