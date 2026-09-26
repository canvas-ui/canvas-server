import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import Fastify from 'fastify';
import compress from '@fastify/compress';
import documentRoutes from '../../src/transports/routes/workspaces/documents.js';

const email = {
    id: 42, schema: 'data/schema/message/email',
    data: {
        subject: 'Locally indexed message',
        body: 'Full offline body. '.repeat(500),
        bodyHtml: '<p>Full offline HTML body.</p>'.repeat(500),
        headers: { received: 'Original message headers' },
        attachments: [{ filename: 'invoice.pdf', url: 'stored://workspace:data/invoice' }],
    },
};
const url = '/workspaces/universe/documents?treeNameOrTreeId=backends&treeType=directory&context=/imap/alice/inbox&limit=50';

async function build(t, docs = [email]) {
    const app = Fastify();
    t.after(() => app.close());
    await app.register(compress, { global: false });
    app.decorate('authenticate', async (request) => { request.user = { id: 'owner' }; });
    app.decorate('authenticateClient', async () => {});
    const calls = [];
    const workspace = {
        isActive: true,
        getDirectoryTreeSelector: (path, tree) => ({ path, tree }),
        async list(spec) {
            calls.push(spec);
            return Object.assign([...docs], { count: docs.length, totalCount: docs.length });
        },
        async get() { return email; },
        async syncBackend() { assert.fail('Browsing must not synchronize a mailbox'); },
        async syncBackendContainer() { assert.fail('Browsing must not synchronize a folder'); },
        async resolveDocument() { assert.fail('Browsing must not fetch message bytes'); },
    };
    app.decorate('workspaceManager', {
        resolveWorkspaceId: async () => 'workspace-id',
        getWorkspace: async () => workspace,
    });
    app.register(documentRoutes, { prefix: '/workspaces/:id/documents' });
    await app.ready();
    return { app, calls };
}

test('IMAP listing reads local index and compresses complete documents losslessly', async (t) => {
    const { app, calls } = await build(t);
    const response = await app.inject({ url, headers: { 'accept-encoding': 'gzip, deflate, br' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-encoding'], 'gzip');
    assert.match(response.headers.vary, /accept-encoding/i);
    const decoded = gunzipSync(response.rawPayload);
    assert.deepEqual(JSON.parse(decoded).payload, [email]);
    assert.ok(response.rawPayload.length < decoded.length / 5);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].context, null);
    assert.deepEqual(calls[0].directory, { tree: 'backends', path: '/imap/alice/inbox' });
    assert.equal(calls[0].limit, 50);
});

test('clients without gzip support receive full identity responses', async (t) => {
    const { app } = await build(t);
    for (const encoding of [undefined, 'identity', 'gzip;q=0, identity;q=1']) {
        const response = await app.inject({ url, headers: encoding ? { 'accept-encoding': encoding } : {} });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-encoding'], undefined);
        assert.deepEqual(response.json().payload, [email]);
    }
});

test('small lists and routes that did not opt in stay uncompressed', async (t) => {
    const { app } = await build(t, []);
    for (const target of [url, '/workspaces/universe/documents/42']) {
        const response = await app.inject({ url: target, headers: { 'accept-encoding': 'gzip' } });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-encoding'], undefined);
    }
});
