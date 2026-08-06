import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import VirtualNamedContextFS from '../../../src/transports/webdav/VirtualNamedContextFS.js';
import { startWorkspace } from './harness.js';

/**
 * `Contexts/**` writes.
 *
 * A context is FLAT: its documents are its files, and a gesture means the same
 * thing here as anywhere else on the mount — nothing is inferred from which
 * folder you are standing in. Grouping is a derived, read-only `.by-schema/`.
 *
 * A context is also a VIEW: a write files a document INTO it, and a delete only
 * detaches it — never trashes, never destroys, because the document still lives
 * wherever its trees put it.
 *
 * Driven against a real workspace with a Context stand-in: the Context class
 * itself is permissions + events over `workspace.put/unlink`, and this is about
 * what the VFS asks it for.
 */

function stubContext(ws, contextPath = '/webdav-test') {
    const selector = () => ws.getContextTreeSelector(contextPath);
    return {
        id: 'ctx-1',
        userId: 'user-1',
        path: contextPath,
        workspace: ws,
        calls: [],
        async list(_userId, spec = {}) {
            const features = spec.attributes?.allOf ?? [];
            const docs = await ws.db.list({ context: selector(), features });
            return Array.isArray(docs) ? docs : [];
        },
        async put(_userId, document) {
            this.calls.push(['put', document.schema]);
            return ws.put(document, { context: selector() });
        },
        async unlink(_userId, documentId) {
            this.calls.push(['unlink', documentId]);
            return ws.unlink(documentId, { context: selector() });
        },
    };
}

describe('webdav context writes', () => {
    let h;
    let ctx;
    let vfs;

    before(async () => {
        h = await startWorkspace('dav-ctx-');
        ctx = stubContext(h.ws);
        vfs = new VirtualNamedContextFS(ctx);
    });
    after(async () => { await h?.stop(); });

    const put = (vPath, body) => vfs.put(vPath, Buffer.from(body));
    const names = async (vPath) => (await vfs.readdir(vPath)).map((e) => e.name);

    test('a context lists its documents as files, plus the derived view', async () => {
        await put('/thought.md', '# Idea\n\nbody');
        await put('/reddit.url', 'https://reddit.com/r/rust');

        assert.deepEqual((await names('/')).sort(), ['.by-schema', 'reddit.url', 'thought.md']);
        assert.equal(await streamText(vfs, '/thought.md'), '# Idea\n\nbody');
    });

    test('the same naming rule as the rest of the mount: .url is a tab, .md is a file', async () => {
        // No folder declares a schema here, so nothing converts based on where
        // it was dropped — the filename is the only signal, exactly as under
        // Trees/**.
        assert.equal((await vfs.docAt('/reddit.url')).schema, 'data/schema/tab');
        assert.equal((await vfs.docAt('/reddit.url')).data.url, 'https://reddit.com/r/rust');
        assert.equal((await vfs.docAt('/thought.md')).schema, 'data/schema/file');
    });

    test('editing a .url navigates it; removing it closes that tab', async () => {
        // What a context-bound browser sees: the file IS the tab.
        await put('/reddit.url', 'https://reddit.com/r/programming');
        const tab = await vfs.docAt('/reddit.url');
        assert.equal(tab.data.url, 'https://reddit.com/r/programming');

        await vfs.del('/reddit.url');
        assert.equal(await vfs.docAt('/reddit.url'), null, 'gone from the view');
        assert.ok(await h.ws.get(tab.id), 'the document itself survives');
    });

    test('writing over an existing document updates it in place', async () => {
        const before = await vfs.docAt('/thought.md');
        const result = await put('/thought.md', 'rewritten');
        assert.equal(result.created, false);

        const after = await vfs.docAt('/thought.md');
        assert.equal(after.id, before.id, 'the document id survives an edit');
        assert.equal(await streamText(vfs, '/thought.md'), 'rewritten');
    });

    test('.by-schema groups the same documents, read-only', async () => {
        const folders = await names('/.by-schema');
        assert.ok(folders.includes('Files'), `expected a Files group: ${folders}`);
        assert.deepEqual(await names('/.by-schema/Files'), ['thought.md']);

        // Derived views are not places you write to.
        await assert.rejects(() => put('/.by-schema/Files/new.txt', 'x'), /derived view/);
        await assert.rejects(() => vfs.del('/.by-schema/Files/thought.md'), /derived view/);
    });

    test('deleting from a context only detaches it', async () => {
        await put('/temporary.md', 'here for a moment');
        const doc = await vfs.docAt('/temporary.md');
        await h.ws.link(doc.id, { context: null, directory: h.ws.getDirectoryTreeSelector('/kept', 'directory') });

        await vfs.del('/temporary.md');

        assert.equal(await vfs.docAt('/temporary.md'), null, 'gone from the view');
        assert.ok(await h.ws.get(doc.id), 'but the document survives');
        assert.deepEqual(await h.dirPaths(doc.id), ['/kept'], 'and keeps its tree placement');
        // PROPFIND depth 1 lists the collection itself first, so an empty trash
        // is exactly ['Trash'].
        assert.deepEqual(await h.listNames('/Trash'), ['Trash'], 'a context delete never trashes');
    });

    test('a context is flat: no folders to make, none to nest into', async () => {
        await assert.rejects(() => vfs.mkcol('/Invented'), /flat view/);
        await assert.rejects(() => put('/nested/deeper.md', 'x'), /flat view/);
    });
});

async function streamText(vfs, vPath) {
    const content = await vfs.getContent(vPath);
    if (content.buffer) return content.buffer.toString();
    const chunks = [];
    for await (const chunk of content.stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
}
