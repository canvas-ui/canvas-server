import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverBackfillDocuments } from '../../../../../src/core/workspace/services/hook/backfill.js';

test('backend folder backfill includes descendants and advances beyond one batch', async () => {
    const docs = Array.from({ length: 205 }, (_, i) => ({ id: i + 1 }));
    const seen = [];
    const workspace = { list: async (spec) => {
        assert.deepEqual(spec.directory, { tree: 'backends', path: '/workspace/home/Work/Acme org/Accounting', recursive: true });
        assert.equal(spec.applyCanvasQuerySpec, false);
        assert.equal(spec.order, 'asc');
        return docs.slice(spec.offset, spec.offset + spec.limit);
    } };
    let offset = 0;
    do {
        const page = await discoverBackfillDocuments(workspace, { paths: ['backends:/workspace/home/Work/Acme org/Accounting'], limit: 100, offset });
        seen.push(...page.docs.map(doc => doc.id));
        offset = page.nextOffset;
    } while (offset !== null);
    assert.deepEqual(seen, docs.map(doc => doc.id));
});

test('alternative source paths are unioned before paging, without skipping duplicate placements', async () => {
    const workspace = { list: async ({ context, limit }) => (context === '/a'
        ? [{ id: 1 }, { id: 3 }, { id: 5 }]
        : [{ id: 1 }, { id: 2 }, { id: 4 }]).slice(0, limit) };
    const options = { paths: ['ctx:/a', 'ctx:/b'], limit: 2 };
    const first = await discoverBackfillDocuments(workspace, options);
    const second = await discoverBackfillDocuments(workspace, { ...options, offset: first.nextOffset });
    const third = await discoverBackfillDocuments(workspace, { ...options, offset: second.nextOffset });
    assert.deepEqual([...first.docs, ...second.docs, ...third.docs].map(doc => doc.id), [1, 2, 3, 4, 5]);
    assert.equal(third.nextOffset, null);
});

test('a discovery error is not reported as an empty successful folder', async () => {
    await assert.rejects(discoverBackfillDocuments({ list: async () => Object.assign([], { error: 'offline' }) }), /offline/);
});


test('non-recursive backfill asks for direct backend membership only', async () => {
    const workspace = { list: async (spec) => {
        assert.deepEqual(spec.directory, { tree: 'backends', path: '/workspace/home/foo/bar', recursive: false });
        return [{ id: 1 }];
    } };
    const result = await discoverBackfillDocuments(workspace, { paths: ['backends:/workspace/home/foo/bar'], recursive: false });
    assert.deepEqual(result.docs, [{ id: 1 }]);
    assert.equal(result.nextOffset, null);
});
