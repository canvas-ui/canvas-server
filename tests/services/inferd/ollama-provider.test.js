'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import OllamaProvider from '../../../src/services/inferd/src/providers/ollama.js';

/**
 * Throwaway Ollama daemon. `handler(body, req)` returns the JSON to reply with
 * (or a { status, body } pair); every request is recorded so the tests can
 * assert the wire shape and the headers.
 *
 * Ollama ships unauthenticated, but is routinely fronted by a proxy that
 * demands a bearer token — so `authRequired` models the case that matters:
 * without credential support such a host is unreachable, with no configuration
 * that can fix it.
 */
async function withServer(handler, fn) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null;
            seen.push({ url: req.url, method: req.method, body, headers: req.headers });
            const out = handler(body, req) || {};
            const status = out.status || 200;
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(out.body ?? out));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try { return await fn(url, seen); }
    finally { await new Promise((resolve) => server.close(resolve)); }
}

const guarded = (token, reply) => (body, req) => (
    req.headers.authorization === `Bearer ${token}`
        ? reply
        : { status: 401, body: { error: 'unauthorized' } }
);

test('ollama: embedText posts the native /api/embed shape', async () => {
    await withServer(() => ({ embeddings: [[1, 2, 3], [4, 5, 6]] }), async (url, seen) => {
        const p = new OllamaProvider({ host: url, id: 'local' });
        const { vectors, dim } = await p.embedText(['a', 'b'], { model: 'nomic-embed-text' });
        assert.deepEqual(vectors, [[1, 2, 3], [4, 5, 6]]);
        assert.equal(dim, 3);
        assert.equal(seen[0].url, '/api/embed');
        assert.deepEqual(seen[0].body, { model: 'nomic-embed-text', input: ['a', 'b'] });
    });
});

test('ollama: no apiKey means no Authorization header', async () => {
    await withServer(() => ({ embeddings: [[1]] }), async (url, seen) => {
        await new OllamaProvider({ host: url }).embedQuery('hi', { model: 'm' });
        assert.equal(seen[0].headers.authorization, undefined);
    });
});

test('ollama: an apiKey authenticates against a protected daemon', async () => {
    await withServer(guarded('s3cr3t', { embeddings: [[0.1, 0.2]] }), async (url) => {
        // Without the key the endpoint is simply unusable...
        await assert.rejects(
            new OllamaProvider({ host: url }).embedQuery('hi', { model: 'm' }),
            /401/,
        );
        // ...and with it, the same host works.
        const { vector, dim } = await new OllamaProvider({ host: url, apiKey: 's3cr3t' })
            .embedQuery('hi', { model: 'm' });
        assert.deepEqual(vector, [0.1, 0.2]);
        assert.equal(dim, 2);
    });
});

test('ollama: custom headers ride along, including on the status ping', async () => {
    await withServer(() => ({ embeddings: [[1]] }), async (url, seen) => {
        const p = new OllamaProvider({ host: url, apiKey: 'k', headers: { 'x-tenant': 'acme' } });
        await p.embedQuery('hi', { model: 'm' });
        assert.equal(seen[0].headers['x-tenant'], 'acme');
        assert.equal(seen[0].headers['content-type'], 'application/json');

        // The reachability ping hits a different route; an unauthenticated
        // probe against a guarded host would report the daemon as down.
        const status = await p.status();
        assert.equal(status.authenticated, true);
        assert.equal(seen[1].url, '/api/tags');
        assert.equal(seen[1].headers.authorization, 'Bearer k');
    });
});

test('ollama: a trailing slash on the host does not double up in the path', async () => {
    await withServer(() => ({ embeddings: [[1]] }), async (url, seen) => {
        await new OllamaProvider({ host: `${url}/` }).embedQuery('hi', { model: 'm' });
        assert.equal(seen[0].url, '/api/embed');
    });
});
