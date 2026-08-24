import test from 'node:test';
import assert from 'node:assert/strict';

import Context from '../../../src/core/context/lib/Context.js';

/**
 * A context's byte side answers to the context's own permissions.
 *
 * These used to be missing, so every caller that needed bytes — the WebDAV
 * mount, the /contexts/:id/blobs route — reached through to `context.workspace`
 * instead. That works, and it skips the check that guards the document half:
 * documentRead on a shared context was enough to write bytes into the owner's
 * workspace store.
 */

function makeContext({ acl = {} } = {}) {
    const calls = [];
    const tree = { id: 'tree-1', type: 'context', getLayerForPath: () => null };
    const workspace = {
        id: 'ws-1',
        name: 'labs',
        type: 'workspace',
        isActive: true,
        color: null,
        icon: null,
        getDefaultContextTree: () => tree,
        getTree: () => tree,
        getContextTree: () => tree,
        onAny() {},
        offAny() {},
        emit() {},
        async persistBlob(blob) { calls.push(['persistBlob', blob]); return { url: 'stored://workspace:data/ab/cd/ef', size: blob.length }; },
        async resolveDocument(doc) { calls.push(['resolveDocument', doc.id]); return { buffer: Buffer.from('bytes'), url: 'stored://x' }; },
    };
    const context = new Context('/', {
        id: 'ctx-1',
        userId: 'owner',
        acl,
        workspace,
        workspaceManager: {},
        contextManager: { async saveContext() {} },
    });
    return { context, calls };
}

test('the owner can store and resolve bytes through the context', async () => {
    const { context, calls } = makeContext();

    const stored = await context.persistBlob('owner', Buffer.from('hello'));
    assert.equal(stored.url, 'stored://workspace:data/ab/cd/ef');

    const resolved = await context.resolveDocument('owner', { id: 42, locations: [{ url: 'stored://x' }] });
    assert.equal(resolved.buffer.toString(), 'bytes');

    assert.deepEqual(calls.map(([name]) => name), ['persistBlob', 'resolveDocument']);
});

test('documentRead is not enough to write bytes', async () => {
    const { context, calls } = makeContext({ acl: { reader: 'documentRead' } });

    await assert.rejects(
        () => context.persistBlob('reader', Buffer.from('hello')),
        (err) => err.code === 'ACCESS_DENIED',
    );
    // A reader may still read the bytes of what it can see.
    await context.resolveDocument('reader', { id: 42, locations: [{ url: 'stored://x' }] });

    assert.deepEqual(calls.map(([name]) => name), ['resolveDocument']);
});

test('a stranger gets neither', async () => {
    const { context, calls } = makeContext();

    await assert.rejects(() => context.persistBlob('nobody', Buffer.from('x')), (e) => e.code === 'ACCESS_DENIED');
    await assert.rejects(() => context.resolveDocument('nobody', { id: 1 }), (e) => e.code === 'ACCESS_DENIED');
    assert.deepEqual(calls, []);
});
