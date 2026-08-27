import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import Context from '../../../src/core/context/lib/Context.js';
import VirtualNamedContextFS from '../../../src/transports/webdav/VirtualNamedContextFS.js';
import { startWorkspace } from './harness.js';

/**
 * A context folder is FLAT — its documents are its files — and its URL is a
 * path into a tree, so it holds what is filed at that path AND what is filed
 * below it. The document filed at the context's own path keeps the plain
 * filename; see docs/data-representation.md §2b-i.
 *
 * Re-aiming the context (`mbag://` → `mbag://dc-migration`) hands the plain
 * name to a different document, because the path is the question being asked.
 */
describe('a context folder names by its own path', () => {
    let h;
    let ids;

    before(async () => {
        h = await startWorkspace('dav-ctx-view-');

        // Deepest first, so document id and placement disagree — id order is
        // what used to decide this, and an agreeing order tests nothing.
        const put = (treePath, content) => h.ws.db.put(
            { schema: 'data/schema/note', data: { title: 'CLAUDE', content } },
            { context: { tree: 'context', path: treePath } },
        );
        ids = {
            task: await put('/dc-migration/tasks/foo', 'task guidance'),
            project: await put('/dc-migration', 'migration guidance'),
            root: await put('/', 'workspace guidance'),
        };
    });

    after(async () => { await h?.stop(); });

    const viewAt = (url) => new VirtualNamedContextFS(new Context(url, {
        id: 'ctx-1',
        userId: 'user-1',
        workspace: h.ws,
        workspaceManager: {},
        contextManager: { async saveContext() {} },
    }));

    const files = async (url) => (await viewAt(url).readdir('/'))
        .filter((entry) => !entry.isDir)
        .map((entry) => [entry.name, entry.doc.id]);

    test('the plain name is the document filed at the context path', async () => {
        const atRoot = await files('/');
        assert.deepEqual(
            atRoot.find(([name]) => name === 'CLAUDE.note.md')?.[1],
            ids.root,
        );
        assert.equal(atRoot.length, 3, 'a context holds its whole subtree');

        const atProject = await files('/dc-migration');
        assert.deepEqual(
            atProject.find(([name]) => name === 'CLAUDE.note.md')?.[1],
            ids.project,
        );
        assert.equal(atProject.length, 2);

        const atLeaf = await files('/dc-migration/tasks/foo');
        assert.deepEqual(atLeaf, [['CLAUDE.note.md', ids.task]]);
    });

    test('a name the listing showed is a name that opens', async () => {
        // stat() resolves names through findDocumentByName — a second
        // implementation of the same rule, and it has to agree with readdir.
        const view = viewAt('/dc-migration');
        assert.equal((await view.stat('/CLAUDE.note.md')).doc.id, ids.project);
        assert.equal((await view.stat(`/CLAUDE.note_${ids.task}.md`)).doc.id, ids.task);
    });
});
