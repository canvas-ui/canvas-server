'use strict';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import OpenAIProvider from '../../../src/services/embedd/src/providers/openai.js';

/**
 * Spin a throwaway OpenAI-compatible endpoint. `handler(body, req)` returns the
 * JSON to reply with (or a { status, body } pair); every request body is
 * recorded so the tests can assert the exact wire shape we send to vllm/TEI/
 * infinity — that shape is the whole contract with the inference host.
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

const embeddings = (vectors) => ({ data: vectors.map((embedding, index) => ({ index, embedding })) });

test('openai: embedText posts the OpenAI embeddings shape', async () => {
    await withServer(() => embeddings([[1, 2, 3], [4, 5, 6]]), async (url, seen) => {
        const p = new OpenAIProvider({ baseUrl: url, id: 'gpu' });
        const { vectors, dim } = await p.embedText(['a', 'b'], { model: 'bge-m3' });
        assert.deepEqual(vectors, [[1, 2, 3], [4, 5, 6]]);
        assert.equal(dim, 3);
        assert.equal(seen[0].url, '/v1/embeddings');
        assert.deepEqual(seen[0].body.input, ['a', 'b']);
        assert.equal(seen[0].body.model, 'bge-m3');
        // Explicit float encoding — servers that default to base64 would
        // otherwise hand back strings that decode into garbage vectors.
        assert.equal(seen[0].body.encoding_format, 'float');
    });
});

test('openai: a baseUrl that already ends in /v1 is not doubled', async () => {
    await withServer(() => embeddings([[1]]), async (url, seen) => {
        const p = new OpenAIProvider({ baseUrl: `${url}/v1` });
        await p.embedText(['a'], { model: 'm' });
        assert.equal(seen[0].url, '/v1/embeddings');
    });
});

test('openai: out-of-order responses are re-paired by index', async () => {
    // A server that parallelizes the batch may reply out of order; pairing by
    // arrival would attach every vector to the wrong document.
    await withServer(() => ({ data: [{ index: 1, embedding: [9] }, { index: 0, embedding: [1] }] }), async (url) => {
        const p = new OpenAIProvider({ baseUrl: url });
        const { vectors } = await p.embedText(['first', 'second'], { model: 'm' });
        assert.deepEqual(vectors, [[1], [9]]);
    });
});

test('openai: a short response throws rather than silently dropping documents', async () => {
    await withServer(() => embeddings([[1]]), async (url) => {
        const p = new OpenAIProvider({ baseUrl: url, id: 'gpu' });
        await assert.rejects(
            () => p.embedText(['a', 'b'], { model: 'm' }),
            /expected 2 embedding\(s\), got 1/,
        );
    });
});

test('openai: an HTTP error surfaces the status and body', async () => {
    await withServer(() => ({ status: 503, body: { error: 'model loading' } }), async (url) => {
        const p = new OpenAIProvider({ baseUrl: url, id: 'gpu' });
        await assert.rejects(() => p.embedText(['a'], { model: 'm' }), /gpu embeddings 503/);
    });
});

test('openai: apiKey is sent as a bearer token', async () => {
    await withServer(() => embeddings([[1]]), async (url, seen) => {
        const p = new OpenAIProvider({ baseUrl: url, apiKey: 'sk-test' });
        await p.embedText(['a'], { model: 'm' });
        assert.equal(seen[0].headers.authorization, 'Bearer sk-test');
    });
});

test('openai: dimensions is only sent when the rule asks for it', async () => {
    await withServer(() => embeddings([[1]]), async (url, seen) => {
        const p = new OpenAIProvider({ baseUrl: url });
        await p.embedText(['a'], { model: 'm' });
        assert.equal('dimensions' in seen[0].body, false, 'servers without Matryoshka support reject unknown fields');
        await p.embedText(['a'], { model: 'm', dimensions: 256 });
        assert.equal(seen[1].body.dimensions, 256);
    });
});

test('openai: embedQuery returns the single vector', async () => {
    await withServer(() => embeddings([[7, 8]]), async (url) => {
        const p = new OpenAIProvider({ baseUrl: url });
        const { vector, dim } = await p.embedQuery('red car', { model: 'm' });
        assert.deepEqual(vector, [7, 8]);
        assert.equal(dim, 2);
    });
});

// ── Images ───────────────────────────────────────────────────────────────────

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

test('openai: embedImage (data-uri) sends one batched request of data URIs', async () => {
    await withServer(() => embeddings([[1], [2]]), async (url, seen) => {
        const p = new OpenAIProvider({ baseUrl: url });
        const { vectors } = await p.embedImage([PNG, PNG], { model: 'siglip' }, { contentTypes: ['image/png', null] });
        assert.deepEqual(vectors, [[1], [2]]);
        assert.equal(seen.length, 1, 'the batch is one round-trip');
        assert.equal(seen[0].body.input.length, 2);
        assert.ok(seen[0].body.input[0].startsWith('data:image/png;base64,'));
        // No contentType supplied → sniffed from the magic bytes rather than guessed.
        assert.ok(seen[0].body.input[1].startsWith('data:image/png;base64,'));
    });
});

test('openai: embedImage (messages) sends vllm multimodal shape, one per image', async () => {
    await withServer(() => embeddings([[5]]), async (url, seen) => {
        const p = new OpenAIProvider({ baseUrl: url, imageInput: 'messages' });
        const { vectors } = await p.embedImage([PNG, PNG], { model: 'vlm2vec' }, { contentTypes: ['image/png', 'image/png'] });
        assert.deepEqual(vectors, [[5], [5]]);
        assert.equal(seen.length, 2, 'the chat shape carries one conversation, so one request per image');
        const content = seen[0].body.messages[0].content[0];
        assert.equal(content.type, 'image_url');
        assert.ok(content.image_url.url.startsWith('data:image/png;base64,'));
        assert.equal('input' in seen[0].body, false);
    });
});

test('openai: an unknown imageInput mode is rejected at construction', () => {
    assert.throws(
        () => new OpenAIProvider({ baseUrl: 'http://x', imageInput: 'psychic' }),
        /unknown imageInput 'psychic'/,
    );
});

test('openai: status pings /models and reports reachability', async () => {
    await withServer(() => ({ data: [{ id: 'bge-m3' }] }), async (url) => {
        const p = new OpenAIProvider({ baseUrl: url, id: 'gpu' });
        const s = await p.status();
        assert.equal(s.id, 'gpu');
        assert.equal(s.type, 'openai');
        assert.equal(s.reachable, true);
        assert.deepEqual(s.models, ['bge-m3']);
    });
});

test('openai: status on an unreachable host reports false instead of throwing', async () => {
    // Port 1 is reserved and never listening.
    const p = new OpenAIProvider({ baseUrl: 'http://127.0.0.1:1', id: 'gpu' });
    const s = await p.status();
    assert.equal(s.reachable, false);
});
