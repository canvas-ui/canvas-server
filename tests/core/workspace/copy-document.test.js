import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { copyDocumentContent, copyDocumentOnce } from '../../../src/core/workspace/lib/copy-document.js';

async function setup(t, overrides = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-copy-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const original = {
        id: 7, schema: 'data/schema/file', schemaVersion: '3.0', data: {},
        locations: [{ url: 'stored://workspace:home/Photos/holiday.jpg' }],
        metadata: { contentType: 'image/jpeg', geo: { lat: 48, lon: 17 }, custom: 'keep' },
        features: ['tag/holiday', 'device/id/source', 'data/schema/file'],
        comment: 'A memory', checksumArray: ['sha256/abc'], timelines: [{ timeline: 'content', start: '2026-01-01' }],
        relations: { references: [123] }, acl: { users: { stranger: 'write' } },
        ...overrides,
    };
    const puts = [];
    const source = { id: 'source', get: async () => original, resolveDocument: async () => ({ stream: Readable.from(['photo']) }) };
    const destination = { id: 'destination', varPath: root,
        persistBlob: async stream => { let text = ''; for await (const chunk of stream) text += chunk; assert.equal(text, 'photo'); return { url: 'stored://workspace:data/abc', checksum: 'abc', size: 5 }; },
        put: async (record, spec) => { puts.push({ record, spec }); return 91; },
    };
    const spec = { context: { tree: 'context', path: '/Imported' }, directory: null };
    return { original, puts, source, destination, spec };
}

test('copies bytes and portable metadata; excludes source identity, locations, relationships and ACL', async t => {
    const { original, puts, source, destination, spec } = await setup(t);
    const snapshot = structuredClone(original);
    assert.deepEqual(await copyDocumentContent(source, destination, 7, spec), { sourceId: 7, destinationId: 91 });
    const { record, spec: placed } = puts[0];
    assert.deepEqual(record.locations, [{ url: 'stored://workspace:data/abc' }]);
    assert.equal(record.metadata.filename, 'holiday.jpg');
    assert.deepEqual(record.metadata.geo, snapshot.metadata.geo);
    assert.equal(record.comment, 'A memory');
    assert.deepEqual(record.timelines, snapshot.timelines);
    assert.deepEqual(record.features, ['tag/holiday']);
    for (const key of ['id', 'relations', 'acl', 'createdAt']) assert.equal(record[key], undefined);
    assert.deepEqual(placed, spec);
    assert.deepEqual(original, snapshot);
});

test('receipt survives retries, concurrent requests and a lost response', async t => {
    const setupData = await setup(t);
    const request = { ...setupData, documentId: 7, operationId: 'job-1', userId: 'user' };
    const results = await Promise.all([copyDocumentOnce(request), copyDocumentOnce(request)]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(setupData.puts.length, 1);
    await copyDocumentOnce(request);
    assert.equal(setupData.puts.length, 1);
    await assert.rejects(copyDocumentOnce({ ...request, documentId: 8 }), /already used/);
});

test('missing bytes or checksum mismatch never inserts a destination document', async t => {
    const { source, destination, spec, puts } = await setup(t);
    source.resolveDocument = async () => null;
    await assert.rejects(copyDocumentContent(source, destination, 7, spec), /unavailable/);
    source.resolveDocument = async () => ({ stream: Readable.from(['photo']) });
    destination.persistBlob = async () => ({ url: 'stored://workspace:data/other', checksum: 'other' });
    await assert.rejects(copyDocumentContent(source, destination, 7, spec), /changed/);
    assert.equal(puts.length, 0);
});

test('inline notes copy without blob access and keep their content', async t => {
    const { source, destination, spec, puts } = await setup(t, { schema: 'data/schema/note', data: { title: 'Note', content: '# Hello' }, locations: [] });
    source.resolveDocument = async () => { throw new Error('Must not fetch bytes'); };
    await copyDocumentContent(source, destination, 7, spec);
    assert.equal(puts[0].record.data.content, '# Hello');
    assert.equal(puts[0].record.checksumArray, undefined);
});

test('email attachment bytes are copied and the source attachment stays unchanged', async t => {
    const { source, destination, spec, puts, original } = await setup(t, { schema: 'data/schema/message/email', data: { attachments: [{ url: 'stored://workspace:data/attachment', filename: 'photo.jpg' }] }, locations: [] });
    await copyDocumentContent(source, destination, 7, spec);
    assert.equal(puts[0].record.data.attachments[0].url, 'stored://workspace:data/abc');
    assert.equal(original.data.attachments[0].url, 'stored://workspace:data/attachment');
});


test('drawings retain scene identity rather than using the preview checksum', async t => {
    const { source, destination, spec, puts } = await setup(t, { schema: 'data/schema/drawing', data: { scene: { elements: [] } }, checksumArray: ['sha256/scene'] });
    await copyDocumentContent(source, destination, 7, spec);
    assert.deepEqual(puts[0].record.checksumArray, ['sha256/scene']);
    assert.deepEqual(puts[0].record.locations, [{ url: 'stored://workspace:data/abc' }]);
});
