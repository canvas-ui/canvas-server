import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startWorkspace } from './harness.js';

/**
 * Which document owns a filename in a context folder.
 *
 * A context path is AND(layers along the path), so everything filed below a
 * path is also listed AT it: three `CLAUDE.md` filed at `/`, `/dc-migration`
 * and `/dc-migration/tasks/foo` are all listed at `/`. That is the point of a
 * context tree — but it means one folder legitimately holds three documents
 * answering to one name, and exactly one of them is FILED there.
 *
 * The plain name belongs to that one, at every path. Anything else means
 * walking from `/` to `/dc-migration` renames files under the client: the
 * name `CLAUDE.md` pointed at whichever document happened to be inserted
 * first, and the `_<id>`-suffixed copies changed with it.
 *
 * The equivalent canvas-fuse cases live in that repo's `tests/wsview.rs` —
 * both wires name documents the same way, so both are held to this rule.
 */

const TREE = '/Trees/context';

describe('context folder filenames follow the path', () => {
    let h;
    let ids;

    before(async () => {
        h = await startWorkspace('dav-context-names-');

        // One title, three bodies: documents are content-addressed, so three
        // notes with identical content are ONE document filed three times —
        // which is a different scenario than three documents sharing a name.
        const put = async (treePath, content) => h.ws.db.put(
            { schema: 'data/schema/note', data: { title: 'CLAUDE', content } },
            { context: { tree: 'context', path: treePath } },
        );

        // Same name, three depths — DEEPEST FIRST. Insertion order is the
        // thing that used to decide this, so an order that agrees with depth
        // passes either way and tests nothing.
        ids = {
            task: await put('/dc-migration/tasks/foo', 'task guidance'),
            project: await put('/dc-migration', 'migration guidance'),
            root: await put('/', 'workspace guidance'),
        };
    });

    after(async () => { await h?.stop(); });

    // A collision suffix goes before the LAST dot on both wires
    // (render::with_id_suffix in canvas-fuse, path.extname here), so a note
    // reads CLAUDE.note_<id>.md.
    const names = (list) => list.filter((n) => n.endsWith('.md')).sort();

    test('every document below a path is listed at the path', async () => {
        assert.equal(names(await h.listNames(TREE)).length, 3);
        assert.equal(names(await h.listNames(`${TREE}/dc-migration`)).length, 2);
        assert.equal(names(await h.listNames(`${TREE}/dc-migration/tasks/foo`)).length, 1);
    });

    test('the plain name belongs to the document filed at that path', async () => {
        assert.deepEqual(names(await h.listNames(TREE)), [
            'CLAUDE.note.md',
            `CLAUDE.note_${ids.project}.md`,
            `CLAUDE.note_${ids.task}.md`,
        ].sort());

        assert.deepEqual(names(await h.listNames(`${TREE}/dc-migration`)), [
            'CLAUDE.note.md',
            `CLAUDE.note_${ids.task}.md`,
        ].sort());

        assert.deepEqual(names(await h.listNames(`${TREE}/dc-migration/tasks/foo`)), [
            'CLAUDE.note.md',
        ]);
    });

    test('the plain name OPENS the document filed at that path', async () => {
        // A name the listing showed has to be a name that opens, and it has to
        // open the same document the listing meant — GET resolves names through
        // findDocumentByName, which is a second implementation of this rule.
        const body = async (davPath) => (await h.dav('GET', davPath)).body.toString();

        assert.equal(await body(`${TREE}/CLAUDE.note.md`), 'workspace guidance');
        assert.equal(await body(`${TREE}/CLAUDE.note_${ids.task}.md`), 'task guidance');
        assert.equal(await body(`${TREE}/dc-migration/CLAUDE.note.md`), 'migration guidance');
        assert.equal(await body(`${TREE}/dc-migration/tasks/foo/CLAUDE.note.md`), 'task guidance');

        const atRoot = await h.dav('PROPFIND', `${TREE}/CLAUDE.note.md`, { headers: { depth: '0' } });
        const atProject = await h.dav('PROPFIND', `${TREE}/dc-migration/CLAUDE.note.md`, { headers: { depth: '0' } });
        assert.equal(atRoot.statusCode, 207);
        assert.equal(atProject.statusCode, 207);
    });
});
