import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startWorkspace } from './harness.js';

/**
 * "A file is a file": anything without a canvas-native meaning is written as a
 * File document whose bytes go to the local blob store. Markdown included — a
 * new `.md` is no longer a note, because markdown is a general document format
 * and rendering it as a note is a UI decision, not a storage one.
 *
 * The one asymmetry worth defending with a test: an EXISTING document is
 * updated in its own schema, so saving over a note edits the note.
 */

describe('webdav file writes', () => {
    let h;

    before(async () => { h = await startWorkspace('dav-files-'); });
    after(async () => { await h?.stop(); });

    const put = (davPath, body, type) =>
        h.dav('PUT', davPath, { body: Buffer.isBuffer(body) ? body : Buffer.from(body), headers: type ? { 'content-type': type } : {} });

    test('a new .md is stored as a file, not a note', async () => {
        const res = await put('/Trees/directory/docs/readme.md', '# Title\n\nbody text\n');
        assert.equal(res.statusCode, 201);

        const doc = await h.docAt('/docs', 'readme.md');
        assert.ok(doc, 'document should exist');
        assert.equal(doc.schema, 'data/schema/file');
        // Bytes live in the local blob store, content-addressed.
        assert.match(doc.locations[0].url, /^stored:\/\/workspace:data\//);
        assert.equal(doc.locations[0].metadata.filename, 'readme.md');
        assert.ok(doc.checksumArray[0].startsWith('sha256/'));
        assert.deepEqual(doc.data, {});
    });

    test('the bytes come back verbatim', async () => {
        const body = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x10, 0x00]);
        await put('/Trees/directory/docs/blob.bin', body);

        const res = await h.dav('GET', '/Trees/directory/docs/blob.bin');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, body);
    });

    test('re-writing a file updates the same document with a new checksum', async () => {
        await put('/Trees/directory/docs/changing.txt', 'first');
        const before = await h.docAt('/docs', 'changing.txt');

        const res = await put('/Trees/directory/docs/changing.txt', 'second');
        assert.equal(res.statusCode, 204);

        const after = await h.docAt('/docs', 'changing.txt');
        assert.equal(after.id, before.id, 'the document id must survive an edit');
        assert.notEqual(after.checksumArray[0], before.checksumArray[0]);
        assert.deepEqual((await h.dav('GET', '/Trees/directory/docs/changing.txt')).body.toString(), 'second');
        // Still one placement — an edit is not a new filing.
        assert.deepEqual(await h.dirPaths(after.id), ['/docs']);
    });

    test('saving over an existing note edits the note instead of converting it', async () => {
        // Notes still exist (created by the UI/API); a mount must not silently
        // turn one into a file just because markdown is now file-shaped.
        const id = await h.ws.put(
            { schema: 'data/schema/note', data: { title: 'Meeting', content: 'old', filename: 'meeting.md' } },
            { context: null, directory: h.ws.getDirectoryTreeSelector('/notes', 'directory') },
        );

        const res = await put('/Trees/directory/notes/meeting.md', 'new body');
        assert.equal(res.statusCode, 204);

        const doc = await h.ws.get(id);
        assert.equal(doc.schema, 'data/schema/note', 'schema must survive the edit');
        assert.equal(doc.data.content, 'new body');
        assert.equal((await h.dav('GET', '/Trees/directory/notes/meeting.md')).body.toString(), 'new body');
    });

    test('.url and .todo.json keep their canvas meaning', async () => {
        await put('/Trees/directory/links/site.url', 'https://example.com/page');
        const tab = await h.docAt('/links', 'site.url');
        assert.equal(tab.schema, 'data/schema/tab');
        assert.equal(tab.data.url, 'https://example.com/page');

        await put('/Trees/directory/links/thing.todo.json', '{"done":true}');
        const todo = await h.docAt('/links', 'thing.todo.json');
        assert.equal(todo.schema, 'data/schema/task');
        assert.equal(todo.data.done, true);
    });

    test('a rename in place keeps the document in its folder', async () => {
        // MOVE is link-there + unlink-here, but when "there" and "here" are the
        // same folder the unlink would undo the link — and F2 in a file manager
        // is exactly that shape.
        await put('/Trees/directory/rename/old-name.txt', 'stable');
        const doc = await h.docAt('/rename', 'old-name.txt');

        const res = await h.dav('MOVE', '/Trees/directory/rename/old-name.txt', {
            headers: { destination: '/workspaces/ws/dav/Trees/directory/rename/new-name.txt', host: 'localhost' },
        });
        assert.equal(res.statusCode, 201);

        assert.deepEqual(await h.dirPaths(doc.id), ['/rename']);
        assert.deepEqual(await h.listNames('/Trees/directory/rename'), ['rename', 'new-name.txt']);
        assert.equal((await h.dav('GET', '/Trees/directory/rename/new-name.txt')).body.toString(), 'stable');
    });

    test('duplicating inside one folder is refused rather than silently renaming', async () => {
        // Content addressing means the "copy" is the same document, and a
        // document has one name — so an in-place duplicate would rename the
        // original.
        await put('/Trees/directory/dup/original.txt', 'bytes');

        const res = await h.dav('COPY', '/Trees/directory/dup/original.txt', {
            headers: { destination: '/workspaces/ws/dav/Trees/directory/dup/copy.txt', host: 'localhost' },
        });

        assert.equal(res.statusCode, 409);
        assert.ok((await h.listNames('/Trees/directory/dup')).includes('original.txt'));
    });

    test('renaming a file records the name on the document, not in data', async () => {
        await put('/Trees/directory/docs/before.pdf', 'pdf bytes');
        const doc = await h.docAt('/docs', 'before.pdf');

        const res = await h.dav('MOVE', '/Trees/directory/docs/before.pdf', {
            headers: { destination: '/workspaces/ws/dav/Trees/directory/docs/after.pdf', host: 'localhost' },
        });
        assert.equal(res.statusCode, 201);

        const renamed = await h.ws.get(doc.id);
        assert.equal(renamed.metadata.filename, 'after.pdf');
        assert.deepEqual(renamed.data, {}, 'core/File.js reserves data for JSON docs');
        assert.ok((await h.listNames('/Trees/directory/docs')).includes('after.pdf'));
    });
});
