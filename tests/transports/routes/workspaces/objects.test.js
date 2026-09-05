import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import workspaceObjectRoutes from '../../../../src/transports/routes/workspaces/objects.js';

const SHA_A = 'aa'.repeat(32);
const SHA_BLOB = 'ab'.repeat(32);

async function drain(source) {
    if (Buffer.isBuffer(source)) return source;
    if (typeof source === 'string') return Buffer.from(source);
    const chunks = [];
    for await (const chunk of source) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}

describe('workspace keyed object routes', () => {
    let app;
    let calls;
    let workspace;

    beforeEach(async () => {
        calls = [];
        const record = (name, ...args) => calls.push({ name, args });
        const objects = new Map([
            ['a.txt', { sha256: SHA_A, size: 3, mtime: 1700000000000, mimeType: 'text/plain', docId: 100001, bytes: Buffer.from('abc') }],
            ['dir x/a.txt', { sha256: SHA_A, size: 3, mtime: 1700000000000, mimeType: 'text/plain', docId: 100002, bytes: Buffer.from('abc') }],
        ]);
        workspace = {
            async listBackendObjects(driver, address, options) {
                record('listBackendObjects', driver, address, options);
                return { objects: [{ key: 'a.txt', sha256: SHA_A, size: 3, mtime: 1700000000000, mimeType: 'text/plain' }], cursor: null, head: 7 };
            },
            async backendChanges(driver, address, options) {
                record('backendChanges', driver, address, options);
                if (options.since < 5) return { changes: [], head: 10, oldest: 6, cursor: options.since, cursorTooOld: true };
                return { changes: [{ seq: 6, ts: 1, op: 'put', key: 'a.txt', sha256: SHA_A, size: 3, mtime: 1, origin: 'dev1' }], head: 10, oldest: 6, cursor: 10, cursorTooOld: false };
            },
            async statBackendObject(driver, address, key) {
                record('statBackendObject', driver, address, key);
                if (address === 'nope') throw Object.assign(new Error('Unknown backend: nope'), { code: 'BACKEND_NOT_FOUND', statusCode: 404 });
                const o = objects.get(key);
                return o ? { key, id: `sha256:${o.sha256}`, sha256: o.sha256, size: o.size, mtime: o.mtime, mimeType: o.mimeType, docId: o.docId } : null;
            },
            async resolveBackendObject(driver, address, key, options) {
                record('resolveBackendObject', driver, address, key, options);
                const o = objects.get(key);
                if (options.range) return { data: Readable.from([o.bytes.subarray(options.range.start, options.range.end + 1)]), ranged: true };
                return { data: Readable.from([o.bytes]), ranged: false };
            },
            async writeBackendObject(driver, address, key, source, options) {
                const body = await drain(source);
                record('writeBackendObject', driver, address, key, body.toString(), options);
                if (options.ifMatch === 'stale') return { ok: false, reason: 'precondition-failed', current: { sha256: 'cc'.repeat(32), size: 9, mtime: 5 } };
                if (key === 'bad.txt') return { ok: false, reason: 'checksum-mismatch', expected: 'x', actual: 'y' };
                return {
                    ok: true, key, id: `sha256:${SHA_A}`, sha256: SHA_A, size: body.length, mtime: options.mtime ?? 1, seq: 11, docId: 100001,
                    previous: key === 'existing.txt' ? { id: 'sha256:old', checksums: { sha256: 'dd'.repeat(32) } } : null,
                    unchanged: key === 'same.txt',
                };
            },
            async removeBackendObject(driver, address, key, options) {
                record('removeBackendObject', driver, address, key, options);
                if (options.ifMatch === 'stale') return { ok: false, reason: 'precondition-failed', current: { sha256: SHA_A, size: 3, mtime: 1 } };
                return { ok: true, key, sha256: SHA_A, seq: 12, docId: 100001 };
            },
            async renameBackendObject(driver, address, from, to, options) {
                record('renameBackendObject', driver, address, from, to, options);
                if (to === 'taken.txt') return { ok: false, reason: 'target-exists', key: to };
                return { ok: true, from, to, sha256: SHA_A, seq: 13, docId: 100001, state: 'complete' };
            },
            async statBlobByChecksum(sha) {
                record('statBlobByChecksum', sha);
                return sha === SHA_BLOB ? { url: 'stored://workspace:data/x', key: 'x', checksum: sha, mimeType: 'image/png' } : null;
            },
            async resolveStoredUrl(url, options) {
                record('resolveStoredUrl', url, options);
                return { data: Readable.from([Buffer.from('blob-bytes')]), ranged: false };
            },
        };

        app = Fastify();
        app.decorate('authenticate', async (request) => { request.user = { id: 'user-id' }; });
        app.decorate('workspaceManager', { resolveWorkspaceId: () => 'workspace-id', getWorkspace: async () => workspace });
        app.addHook('preHandler', async (request) => {
            request.workspace = workspace;
            request.workspaceAccess = { isOwner: true, permissions: ['read', 'write', 'admin'] };
        });
        app.register(workspaceObjectRoutes, { prefix: '/workspaces/:id/backends' });
        await app.ready();
    });

    afterEach(async () => { await app.close(); });

    const B = '/workspaces/universe/backends/file/workspace%3Ahome';
    const inject = (method, url, extra = {}) => app.inject({ method, url, ...extra, headers: { authorization: 'Bearer jwt', ...(extra.headers || {}) } });
    const called = (name) => calls.find((c) => c.name === name)?.args;

    test('GET objects lists with paging args', async () => {
        const res = await inject('GET', `${B}/objects?prefix=UI/&cursor=UI/a.jpg&limit=50`);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(called('listBackendObjects'), ['file', 'workspace:home', { prefix: 'UI/', after: 'UI/a.jpg', limit: 50 }]);
        assert.equal(res.json().payload.objects[0].sha256, SHA_A);
        assert.equal(res.json().payload.head, 7);
        assert.equal(res.json().count, 1);
    });

    test('GET changes: 410 when the cursor was trimmed, entries otherwise', async () => {
        const stale = await inject('GET', `${B}/changes?since=1`);
        assert.equal(stale.statusCode, 410);
        assert.equal(stale.json().code, 'CURSOR_TOO_OLD');
        assert.equal(stale.json().payload.oldest, 6);

        const ok = await inject('GET', `${B}/changes?since=6&limit=10`);
        assert.equal(ok.statusCode, 200);
        assert.deepEqual(called('backendChanges'), ['file', 'workspace:home', { since: 1, limit: 1000 }]);
        assert.equal(ok.json().payload.changes[0].origin, 'dev1');
        assert.equal(ok.json().payload.head, 10);
    });

    test('HEAD describes the object without a body; If-None-Match → 304', async () => {
        const res = await inject('HEAD', `${B}/objects/a.txt`);
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers.etag, `"${SHA_A}"`);
        assert.equal(res.headers['x-canvas-size'], '3');
        assert.equal(res.headers['x-canvas-mtime'], '1700000000000');
        assert.equal(res.headers['x-canvas-doc-id'], '100001');
        assert.equal(res.headers['content-length'], '3');
        assert.equal(res.body, '');

        const cached = await inject('HEAD', `${B}/objects/a.txt`, { headers: { 'if-none-match': `"${SHA_A}"` } });
        assert.equal(cached.statusCode, 304);

        const missing = await inject('HEAD', `${B}/objects/nope.txt`);
        assert.equal(missing.statusCode, 404);
    });

    test('GET streams bytes, honours Range, 416 when unsatisfiable, decodes the key', async () => {
        const full = await inject('GET', `${B}/objects/a.txt`);
        assert.equal(full.statusCode, 200);
        assert.equal(full.body, 'abc');
        assert.equal(full.headers['content-type'], 'text/plain');
        assert.equal(full.headers.etag, `"${SHA_A}"`);

        const part = await inject('GET', `${B}/objects/a.txt`, { headers: { range: 'bytes=1-2' } });
        assert.equal(part.statusCode, 206);
        assert.equal(part.body, 'bc');
        assert.equal(part.headers['content-range'], 'bytes 1-2/3');
        assert.deepEqual(called('resolveBackendObject').slice(0, 3), ['file', 'workspace:home', 'a.txt']);

        const bad = await inject('GET', `${B}/objects/a.txt`, { headers: { range: 'bytes=10-' } });
        assert.equal(bad.statusCode, 416);

        const decoded = await inject('GET', `${B}/objects/dir%20x/a.txt`);
        assert.equal(decoded.statusCode, 200, decoded.body);
        assert.ok(calls.some((c) => c.name === 'statBackendObject' && c.args[2] === 'dir x/a.txt'), 'wildcard key is URL-decoded');

        const notModified = await inject('GET', `${B}/objects/a.txt`, { headers: { 'if-none-match': `W/"${SHA_A}"` } });
        assert.equal(notModified.statusCode, 304);
    });

    test('typed errors from the workspace map to their status + code', async () => {
        const res = await inject('HEAD', '/workspaces/universe/backends/file/nope/objects/a.txt');
        assert.equal(res.statusCode, 404);
        const json = await inject('GET', '/workspaces/universe/backends/file/nope/objects/a.txt');
        assert.equal(json.statusCode, 404);
        assert.equal(json.json().code, 'BACKEND_NOT_FOUND');
    });

    test('PUT streams the raw body with the precondition headers', async () => {
        const res = await inject('PUT', `${B}/objects/UI/new.txt`, {
            payload: 'hello',
            headers: { 'content-type': 'text/plain', 'if-none-match': '*', 'x-canvas-mtime': '1700000000000', 'x-canvas-origin': 'laptop', 'x-canvas-sha256': SHA_A.toUpperCase() },
        });
        assert.equal(res.statusCode, 201, res.body);
        const [driver, address, key, body, options] = called('writeBackendObject');
        assert.deepEqual([driver, address, key, body], ['file', 'workspace:home', 'UI/new.txt', 'hello']);
        assert.deepEqual(options, { ifMatch: undefined, ifNoneMatch: '*', sha256: SHA_A, mtime: 1700000000000, origin: 'laptop', mimeType: 'text/plain' });
        assert.equal(res.json().payload.sha256, SHA_A);
        assert.equal(res.json().payload.docId, 100001);
        assert.equal(res.headers.etag, `"${SHA_A}"`);
    });

    test('PUT over existing content is 200 with previous; identical bytes report unchanged', async () => {
        const replaced = await inject('PUT', `${B}/objects/existing.txt`, { payload: 'v2', headers: { 'if-match': `"${SHA_A}"` } });
        assert.equal(replaced.statusCode, 200);
        assert.equal(replaced.json().payload.previous.sha256, 'dd'.repeat(32));
        const same = await inject('PUT', `${B}/objects/same.txt`, { payload: 'v2' });
        assert.equal(same.statusCode, 200);
        assert.equal(same.json().payload.unchanged, true);
    });

    test('PUT failures: 412 with current, 422 on checksum mismatch, JSON bodies stay raw', async () => {
        const stale = await inject('PUT', `${B}/objects/x.txt`, { payload: 'v', headers: { 'if-match': 'stale' } });
        assert.equal(stale.statusCode, 412);
        assert.equal(stale.json().code, 'PRECONDITION_FAILED');
        assert.equal(stale.json().payload.current.sha256, 'cc'.repeat(32));

        const corrupt = await inject('PUT', `${B}/objects/bad.txt`, { payload: 'v' });
        assert.equal(corrupt.statusCode, 422);
        assert.equal(corrupt.json().code, 'CHECKSUM_MISMATCH');

        const json = await inject('PUT', `${B}/objects/data.json`, { payload: '{"a":1}', headers: { 'content-type': 'application/json' } });
        assert.equal(json.statusCode, 201, json.body);
        const call = calls.filter((c) => c.name === 'writeBackendObject').at(-1).args;
        assert.equal(call[3], '{"a":1}', 'body reached the workspace as bytes, not a parsed object');
        assert.equal(call[4].mimeType, 'application/json');
    });

    test('PUT ?sha256= places already-uploaded bytes', async () => {
        const res = await inject('PUT', `${B}/objects/UI/ref.png?sha256=${SHA_BLOB}`, { payload: '' });
        assert.equal(res.statusCode, 201, res.body);
        assert.deepEqual(called('statBlobByChecksum'), [SHA_BLOB]);
        const call = calls.filter((c) => c.name === 'writeBackendObject').at(-1).args;
        assert.equal(call[3], 'blob-bytes');
        assert.equal(call[4].sha256, SHA_BLOB);
        assert.equal(call[4].mimeType, 'image/png');

        const missing = await inject('PUT', `${B}/objects/UI/ref2.png?sha256=${'ef'.repeat(32)}`, { payload: '' });
        assert.equal(missing.statusCode, 404);
        assert.equal(missing.json().code, 'BLOB_NOT_FOUND');
        const malformed = await inject('PUT', `${B}/objects/UI/ref3.png?sha256=zz`, { payload: '' });
        assert.equal(malformed.statusCode, 400);
    });

    test('PUT with X-Canvas-Conflict-Of needs the conflict inbox', async () => {
        const res = await inject('PUT', `${B}/objects/c.txt`, { payload: 'mine', headers: { 'x-canvas-conflict-of': 'c.txt' } });
        assert.equal(res.statusCode, 501);
        assert.equal(res.json().code, 'NOT_IMPLEMENTED');
    });

    test('PUT with X-Canvas-Conflict-Of feeds the conflict inbox with the device metadata', async () => {
        workspace.createSyncConflict = async (input) => {
            const body = await drain(input.source);
            calls.push({ name: 'createSyncConflict', args: [{ ...input, source: body.toString() }] });
            return { docId: 100009, key: input.conflictOf, mode: input.mode };
        };
        const res = await inject('PUT', `${B}/objects/Docs/c%20(conflict).txt`, {
            payload: 'mine',
            headers: { 'x-canvas-conflict-of': 'Docs/c.txt', 'x-canvas-conflict-mode': 'rename', 'x-canvas-origin': 'dev-laptop', 'x-canvas-device-name': 'laptop', 'x-canvas-base-sha256': 'ee'.repeat(32), 'x-canvas-mtime': '5' },
        });
        assert.equal(res.statusCode, 201, res.body);
        const [input] = called('createSyncConflict');
        assert.equal(input.backend, 'workspace:home');
        assert.equal(input.key, 'Docs/c (conflict).txt');
        assert.equal(input.conflictOf, 'Docs/c.txt');
        assert.equal(input.mode, 'rename');
        assert.equal(input.device, 'dev-laptop');
        assert.equal(input.deviceName, 'laptop');
        assert.equal(input.baseSha256, 'ee'.repeat(32));
        assert.equal(input.mtime, 5);
        assert.equal(input.source, 'mine');
        assert.equal(res.json().payload.docId, 100009);
    });

    test('DELETE honours If-Match', async () => {
        const res = await inject('DELETE', `${B}/objects/a.txt`, { headers: { 'if-match': `"${SHA_A}"`, 'x-canvas-origin': 'laptop' } });
        assert.equal(res.statusCode, 200, res.body);
        assert.deepEqual(called('removeBackendObject'), ['file', 'workspace:home', 'a.txt', { ifMatch: `"${SHA_A}"`, origin: 'laptop' }]);
        assert.equal(res.json().payload.seq, 12);
        const stale = await inject('DELETE', `${B}/objects/a.txt`, { headers: { 'if-match': 'stale' } });
        assert.equal(stale.statusCode, 412);
    });

    test('POST objects/rename', async () => {
        const res = await inject('POST', `${B}/objects/rename`, { payload: { from: 'a.txt', to: 'b.txt', ifMatch: SHA_A, origin: 'laptop' } });
        assert.equal(res.statusCode, 200, res.body);
        assert.deepEqual(called('renameBackendObject'), ['file', 'workspace:home', 'a.txt', 'b.txt', { ifMatch: SHA_A, origin: 'laptop' }]);
        assert.equal(res.json().payload.to, 'b.txt');
        const taken = await inject('POST', `${B}/objects/rename`, { payload: { from: 'a.txt', to: 'taken.txt' } });
        assert.equal(taken.statusCode, 409);
        assert.equal(taken.json().code, 'TARGET_EXISTS');
        const invalid = await inject('POST', `${B}/objects/rename`, { payload: { from: 'a.txt' } });
        assert.equal(invalid.statusCode, 400);
    });
});
