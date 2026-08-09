'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Inferd from '../../../src/services/inferd/src/index.js';

// embedImageQuery: the query twin of the ingest-side embedImage batch — raw
// image bytes → one vector in the workspace's image space, for search-by-image.
// The query image is ephemeral: nothing is enqueued, stored, or indexed.

async function withServer(handler, fn) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null;
            seen.push({ url: req.url, body });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(handler(body)));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    try { return await fn(url, seen); }
    finally { await new Promise((resolve) => server.close(resolve)); }
}

const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // magic bytes are enough for the wire test
const embeddings = (vectors) => ({ data: vectors.map((embedding, index) => ({ index, embedding })) });

test('embedImageQuery: bytes → one vector via the workspace image space', async () => {
    await withServer(() => embeddings([[0.1, 0.2, 0.3, 0.4]]), async (url, seen) => {
        const e = new Inferd({
            providers: { mock: { type: 'openai', baseUrl: url, imageInput: 'data-uri' } },
            spaces: { image: { provider: 'mock', model: 'siglip-mock', dim: 4, chunk: false } },
        });
        e.registerWorkspace('ws-1', { resolveInput: async () => null, storeVectors: async () => {} }, { userId: 'u1' });

        const vector = await e.embedImageQuery('ws-1', PNG, 'image/png');
        assert.deepEqual(vector, [0.1, 0.2, 0.3, 0.4]);

        // Wire shape: one batched data-URI request carrying the query bytes.
        assert.equal(seen.length, 1);
        assert.deepEqual(seen[0].body.input, [`data:image/png;base64,${PNG.toString('base64')}`]);
        assert.equal(seen[0].body.model, 'siglip-mock');
        await e.stop();
    });
});

test('aux chunks: comment (-1) and generated summary (-2) land as reserved text-space rows', async () => {
    await withServer((body) => embeddings(body.input.map((_, i) => [i + 1, 0, 0, 0])), async (url) => {
        const e = new Inferd({
            providers: { mock: { type: 'openai', baseUrl: url } },
            spaces: { text: { provider: 'mock', model: 'bge-mock', dim: 4, chunk: false } },
        });
        const stored = [];
        e.registerWorkspace('ws-1', {
            // Non-inferdable doc (skip) that carries BOTH aux texts — the photo-
            // with-caption shape once the captioner writes metadata.summary back.
            resolveInput: async () => ({ skip: true, schema: 'data/schema/file', updatedAt: 'now', comment: 'user note', summary: 'generated caption' }),
            storeVectors: async (docId, schema, updatedAt, chunks, opts) => { stored.push({ chunks, opts }); },
        }, { userId: 'u1' });

        e.enqueue('ws-1', 42);
        await e.drained();
        const textWrite = stored.find((s) => s.opts.space === 'text' && s.chunks.length > 0);
        assert.ok(textWrite, 'expected a text-space write carrying the aux chunks');
        assert.deepEqual(textWrite.chunks.map((c) => c.chunkId).sort((x, y) => x - y), [-2, -1]);
        const byId = Object.fromEntries(textWrite.chunks.map((c) => [c.chunkId, c.text]));
        assert.equal(byId[-1], 'user note');
        assert.equal(byId[-2], 'generated caption');
        await e.stop();
    });
});

test('embedImageQuery: unknown space / bad input → null, no provider call', async () => {
    await withServer(() => embeddings([[1]]), async (url, seen) => {
        // NOTE: spaces merge key-wise with the built-ins, so the default (clip)
        // image space always exists — "no image space" is probed via an unknown
        // space name, which exercises the same missing-rule guard.
        const e = new Inferd({
            providers: { mock: { type: 'openai', baseUrl: url, imageInput: 'data-uri' } },
            spaces: { image: { provider: 'mock', model: 'siglip-mock', dim: 4, chunk: false } },
        });
        e.registerWorkspace('ws-1', { resolveInput: async () => null, storeVectors: async () => {} }, { userId: 'u1' });

        assert.equal(await e.embedImageQuery('ws-1', PNG, 'image/png', 'no-such-space'), null);
        assert.equal(await e.embedImageQuery('ws-1', Buffer.alloc(0), 'image/png'), null); // empty
        assert.equal(await e.embedImageQuery('ws-1', 'not-a-buffer', 'image/png'), null);  // wrong type
        assert.equal(seen.length, 0, 'must not reach the provider');
        await e.stop();
    });
});
