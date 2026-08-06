import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import Workspace from '../../../src/core/workspace/Workspace.js';
import { startWorkspace } from './harness.js';

/**
 * The filesystem contract, as one table.
 *
 * Both wires (WebDAV here, canvas-fuse in its own repo) are supposed to mean the
 * same thing by the same gesture, because the rules live server-side. This file
 * states the contract in terms of INDEX STATE after each operation — not in
 * terms of HTTP or FUSE — so it reads as the specification the two wires are
 * held to, and a change in one that is not a change in the rules will fail here.
 *
 * See docs/data-representation.md. The equivalent canvas-fuse cases live in
 * `src/ui/fuse/tests/wsview.rs`; they exercise the same rules through the tree
 * state, since the REST calls underneath are the ones asserted here.
 */

describe('filesystem contract', () => {
    let h;

    before(async () => { h = await startWorkspace('dav-conformance-'); });
    after(async () => { await h?.stop(); });

    const put = (davPath, body = 'x') => h.dav('PUT', davPath, { body: Buffer.from(body) });
    const move = (from, to) => h.dav('MOVE', from, {
        headers: { destination: `/workspaces/ws/dav${to}`, host: 'localhost' },
    });
    const copy = (from, to) => h.dav('COPY', from, {
        headers: { destination: `/workspaces/ws/dav${to}`, host: 'localhost' },
    });
    const trashNames = async () => (await h.listNames('/Trash')).filter((n) => n !== 'Trash');

    test('CREATE: a written file becomes one document, filed where it was written', async () => {
        await put('/Trees/directory/contract/a.txt', 'first');
        const doc = await h.docAt('/contract', 'a.txt');

        assert.ok(doc, 'the document exists');
        assert.deepEqual(await h.dirPaths(doc.id), ['/contract']);
    });

    test('EDIT: rewriting keeps the document and its placements', async () => {
        const before = await h.docAt('/contract', 'a.txt');
        await put('/Trees/directory/contract/a.txt', 'second');
        const after = await h.docAt('/contract', 'a.txt');

        assert.equal(after.id, before.id);
        assert.deepEqual(await h.dirPaths(after.id), ['/contract']);
    });

    test('COPY: one document gains a second placement — never a duplicate', async () => {
        const doc = await h.docAt('/contract', 'a.txt');
        await copy('/Trees/directory/contract/a.txt', '/Trees/directory/second/a.txt');

        assert.deepEqual((await h.dirPaths(doc.id)).sort(), ['/contract', '/second']);
    });

    test('MOVE: placements change, the document does not', async () => {
        const doc = await h.docAt('/contract', 'a.txt');
        await move('/Trees/directory/second/a.txt', '/Trees/directory/third/a.txt');

        assert.deepEqual((await h.dirPaths(doc.id)).sort(), ['/contract', '/third']);
        assert.equal((await h.docAt('/third', 'a.txt')).id, doc.id, 'same document, new place');
    });

    test('RENAME in place: the name changes everywhere, the placements do not', async () => {
        const doc = await h.docAt('/contract', 'a.txt');
        await move('/Trees/directory/contract/a.txt', '/Trees/directory/contract/renamed.txt');

        assert.deepEqual((await h.dirPaths(doc.id)).sort(), ['/contract', '/third']);
        assert.ok((await h.listNames('/Trees/directory/contract')).includes('renamed.txt'));
        // HARD-LINK SEMANTICS, and the contract states it out loud: a document
        // has ONE name, so renaming it in one folder renames it in every folder
        // it is filed into. Per-placement names would need per-placement
        // metadata, which bitmaps cannot carry.
        assert.ok((await h.listNames('/Trees/directory/third')).includes('renamed.txt'));
        assert.equal((await h.listNames('/Trees/directory/third')).includes('a.txt'), false);
    });

    test('DELETE with another placement: detaches only, nothing trashed', async () => {
        const doc = await h.docAt('/contract', 'renamed.txt');
        await h.dav('DELETE', '/Trees/directory/contract/renamed.txt');

        assert.deepEqual(await h.dirPaths(doc.id), ['/third'], 'still filed elsewhere');
        assert.ok(await h.ws.get(doc.id));
        assert.deepEqual(await trashNames(), []);
    });

    test('DELETE of the last placement: trashed, not destroyed', async () => {
        const doc = await h.docAt('/third', 'renamed.txt');
        await h.dav('DELETE', '/Trees/directory/third/renamed.txt');

        assert.deepEqual(await h.dirPaths(doc.id), [Workspace.TRASH_PATH]);
        assert.ok(await h.ws.get(doc.id), 'the document survives');
        assert.deepEqual(await trashNames(), ['renamed.txt']);
    });

    test('RESTORE: moving out of the trash re-files it where it was', async () => {
        const doc = (await h.ws.listTrash()).documents[0];
        await move('/Trash/renamed.txt', '/Trees/directory/restored/renamed.txt');

        assert.deepEqual(await h.dirPaths(doc.id), ['/restored']);
        assert.deepEqual(await trashNames(), []);
    });

    test('DRAG TO TRASH: removes the document from every placement at once', async () => {
        const doc = await h.docAt('/restored', 'renamed.txt');
        await h.ws.link(doc.id, { context: null, directory: h.ws.getDirectoryTreeSelector('/elsewhere', 'directory') });
        assert.deepEqual((await h.dirPaths(doc.id)).sort(), ['/elsewhere', '/restored']);

        await move('/Trees/directory/restored/renamed.txt', '/Trash/renamed.txt');

        assert.deepEqual(await h.dirPaths(doc.id), [Workspace.TRASH_PATH]);
    });

    test('EMPTY: the one gesture that destroys', async () => {
        const doc = (await h.ws.listTrash()).documents[0];
        await h.dav('DELETE', '/Trash/renamed.txt');

        assert.equal(await h.ws.get(doc.id).catch(() => null), null);
        assert.deepEqual(await trashNames(), []);
    });

    test('FOLDER MOVE: a tree operation — the documents come along', async () => {
        await put('/Trees/directory/box/inside.txt', 'contents');
        const doc = await h.docAt('/box', 'inside.txt');

        await move('/Trees/directory/box', '/Trees/directory/moved-box');

        assert.deepEqual(await h.dirPaths(doc.id), ['/moved-box']);
    });

    test('HOME: bytes move in and out; the index follows only where it should', async () => {
        const fs = (await import('fs-extra')).default;
        const path = (await import('node:path')).default;
        await fs.outputFile(path.join(h.ws.homePath, 'drop/file.txt'), 'from the drive');

        // In: an ingest, becoming a document.
        await move('/Home/drop/file.txt', '/Trees/directory/ingested/file.txt');
        const doc = await h.docAt('/ingested', 'file.txt');
        assert.equal(doc.schema, 'data/schema/file');
        assert.equal(await fs.pathExists(path.join(h.ws.homePath, 'drop/file.txt')), false);

        // Out: a materialization; COPY leaves the document filed.
        await copy('/Trees/directory/ingested/file.txt', '/Home/exported/file.txt');
        assert.equal(await fs.readFile(path.join(h.ws.homePath, 'exported/file.txt'), 'utf-8'), 'from the drive');
        assert.deepEqual(await h.dirPaths(doc.id), ['/ingested']);
    });

    test('READ: a byte window is served as a byte window', async () => {
        await put('/Trees/directory/ranges/r.txt', 'abcdefghij');
        const res = await h.dav('GET', '/Trees/directory/ranges/r.txt', { headers: { range: 'bytes=2-5' } });

        assert.equal(res.statusCode, 206);
        assert.equal(res.body.toString(), 'cdef');
    });
});
