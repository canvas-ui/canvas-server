import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebhookAdapter } from '../../../../src/services/messaging/src/adapters/webhook.js';

const noopLogger = { debug: () => {}, info: () => {} };

describe('WebhookAdapter', () => {
    let server;
    let baseUrl;
    let received;

    before(async () => {
        received = [];
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                received.push({ url: req.url, contentType: req.headers['content-type'], body });
                if (req.url === '/fail') { res.statusCode = 500; res.end('nope'); return; }
                res.statusCode = 200;
                res.end('ok');
            });
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    test('POSTs { text } as JSON to the bound URL', async () => {
        const adapter = new WebhookAdapter({ logger: noopLogger });
        const result = await adapter.sendText(`${baseUrl}/hook`, 'hello from canvas');
        assert.equal(result.delivered, true);
        assert.equal(received.length, 1);
        assert.equal(received[0].url, '/hook');
        assert.equal(received[0].contentType, 'application/json');
        assert.deepEqual(JSON.parse(received[0].body), { text: 'hello from canvas' });
    });

    test('non-2xx response throws', async () => {
        const adapter = new WebhookAdapter({ logger: noopLogger });
        await assert.rejects(adapter.sendText(`${baseUrl}/fail`, 'x'), /responded 500/);
    });

    test('rejects invalid URLs, non-http protocols and credentials-in-URL', async () => {
        const adapter = new WebhookAdapter({ logger: noopLogger });
        await assert.rejects(adapter.sendText('not a url', 'x'), /not a valid URL/);
        await assert.rejects(adapter.sendText('ftp://example.com/x', 'x'), /unsupported protocol/);
        await assert.rejects(adapter.sendText(`http://user:pass@127.0.0.1:${server.address().port}/hook`, 'x'), /credentials/);
    });

    test('times out slow receivers', async () => {
        const slow = http.createServer(() => { /* never respond */ });
        await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
        try {
            const adapter = new WebhookAdapter({ logger: noopLogger, timeoutMs: 300 });
            await assert.rejects(
                adapter.sendText(`http://127.0.0.1:${slow.address().port}/`, 'x'),
                /timed out/,
            );
        } finally {
            await new Promise((resolve) => { slow.closeAllConnections?.(); slow.close(resolve); });
        }
    });
});
