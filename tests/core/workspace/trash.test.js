import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

import Workspace from '../../../src/core/workspace/Workspace.js';
import {
    WORKSPACE_LAYOUTS,
    workspaceInternals,
    workspaceServices,
} from '../../../src/core/workspace/lib/constants.js';

/**
 * Trash semantics for filesystem-style deletes — see docs/data-representation.md.
 *
 * The rule under test: unlink is non-destructive, and a document is filed into
 * the trash ONLY when the unlink removed its last placement. The subtlety worth
 * a test of its own is that "last placement" cannot mean "no memberships left":
 * every insert also ticks the default context tree's root and unlink refuses to
 * remove it, so a naive membership test reports every document as filed forever.
 */

const note = (title) => ({ schema: 'data/schema/note', data: { title, content: title } });

describe('workspace trash', () => {
    let root;
    let ws;

    const dirSel = (p) => ({ context: null, directory: ws.getDirectoryTreeSelector(p, 'directory') });
    const dirPaths = async (id) => {
        const placements = await ws.listDocumentPlacements(id);
        return placements.find((p) => p.tree === 'directory')?.paths ?? [];
    };
    const trashIds = async () => (await ws.listTrash()).documents.map((d) => d.id);

    before(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-trash-'));
        const store = {
            id: 'ws-trash-1',
            name: 'ws',
            owner: 'user-1',
            layout: WORKSPACE_LAYOUTS.FULL,
            internals: { ...workspaceInternals(WORKSPACE_LAYOUTS.FULL) },
            services: workspaceServices(WORKSPACE_LAYOUTS.FULL),
        };
        ws = new Workspace({
            rootPath: root,
            configStore: {
                store,
                get: (key, fallback) => (store[key] !== undefined ? store[key] : fallback),
                set: (key, value) => { store[key] = value; },
                delete: (key) => { delete store[key]; },
            },
            logger: { info() {}, warn() {}, debug() {}, error() {} },
        });
        await ws.start();
    });

    after(async () => {
        await ws?.stop().catch(() => {});
        if (root) { await fs.remove(root); }
    });

    test('unlink leaves a document alone while it is still filed elsewhere', async () => {
        const id = await ws.put(note('two-places'), dirSel('/x'));
        await ws.link(id, dirSel('/y'));

        await ws.unlink(id, dirSel('/x'), { trashIfOrphaned: true });

        assert.deepEqual(await dirPaths(id), ['/y']);
        assert.equal((await trashIds()).includes(id), false);
    });

    test('unlinking the last placement files the document into the trash', async () => {
        const id = await ws.put(note('last-place'), dirSel('/only'));

        await ws.unlink(id, dirSel('/only'), { trashIfOrphaned: true });

        assert.deepEqual(await dirPaths(id), [Workspace.TRASH_PATH]);
        assert.ok((await trashIds()).includes(id));
        // Non-destructive: the document itself is untouched.
        assert.ok(await ws.get(id));
    });

    test('trashing records where the document came from, and restore puts it back', async () => {
        const id = await ws.put(note('restore-me'), dirSel('/projects/alpha'));
        await ws.unlink(id, dirSel('/projects/alpha'), { trashIfOrphaned: true });

        const trashed = (await ws.listTrash()).documents.find((d) => d.id === id);
        assert.ok(trashed.trashed?.trashedAt);
        assert.deepEqual(
            trashed.trashed.placements.find((p) => p.tree === 'directory')?.paths,
            ['/projects/alpha'],
        );

        const result = await ws.restoreFromTrash([id]);
        assert.deepEqual(result.restored, [id]);
        assert.deepEqual(result.failed, []);
        assert.deepEqual(await dirPaths(id), ['/projects/alpha']);
        assert.equal((await trashIds()).includes(id), false);
    });

    test('restore recreates a path that was removed while the document sat in the trash', async () => {
        const id = await ws.put(note('gone-folder'), dirSel('/temporary/folder'));
        await ws.unlink(id, dirSel('/temporary/folder'), { trashIfOrphaned: true });

        const tree = ws.getTree('directory');
        await tree.removePath('/temporary/folder', true);
        assert.equal(tree.pathExists('/temporary/folder'), false);

        const result = await ws.restoreFromTrash([id]);
        assert.deepEqual(result.restored, [id]);
        assert.deepEqual(await dirPaths(id), ['/temporary/folder']);
    });

    test('filing a trashed document anywhere real takes it back out of the trash', async () => {
        // A file manager's cross-directory move is a copy and a delete; if the
        // delete lands first the copy must undo the trashing, not leave a ghost.
        const id = await ws.put(note('recopy'), dirSel('/src'));
        await ws.unlink(id, dirSel('/src'), { trashIfOrphaned: true });
        assert.ok((await trashIds()).includes(id));

        await ws.link(id, dirSel('/dest'));

        assert.deepEqual(await dirPaths(id), ['/dest']);
        assert.equal((await trashIds()).includes(id), false);
    });

    test('unlink without the flag never trashes — the default stays plain detach', async () => {
        const id = await ws.put(note('plain-detach'), dirSel('/plain'));

        await ws.unlink(id, dirSel('/plain'));

        assert.deepEqual(await dirPaths(id), []);
        assert.equal((await trashIds()).includes(id), false);
        assert.ok(await ws.get(id));
    });

    test('a document that was already filed nowhere is not swept into the trash', async () => {
        // Detached earlier through the plain API, then caught by a bulk remove:
        // this unlink orphans nothing, so it must not trash — there would be no
        // provenance to restore it by either.
        const id = await ws.put(note('already-detached'), dirSel('/somewhere'));
        await ws.unlink(id, dirSel('/somewhere'));
        assert.deepEqual(await dirPaths(id), []);

        await ws.unlink(id, dirSel('/somewhere'), { trashIfOrphaned: true });

        assert.equal((await trashIds()).includes(id), false);
        assert.deepEqual(await dirPaths(id), []);
    });

    test('a restore with nothing to restore to leaves the document in the trash', async () => {
        // Stranding is the failure mode to avoid: out of the trash AND filed
        // nowhere means the document is listed by neither.
        const id = await ws.put(note('no-provenance'), dirSel('/vanishing'));
        await ws.unlink(id, dirSel('/vanishing'), { trashIfOrphaned: true });
        assert.ok((await trashIds()).includes(id));

        // Simulate a trashing that recorded no usable target.
        await ws.db.internalStore.put(`workspace/trash/${id}`, { trashedAt: new Date().toISOString(), placements: [] });

        const result = await ws.restoreFromTrash([id]);

        assert.deepEqual(result.restored, []);
        assert.equal(result.failed[0]?.id, id);
        assert.ok((await trashIds()).includes(id), 'document must stay in the trash');
    });

    test('emptying the trash destroys, and only what is in the trash', async () => {
        const doomed = await ws.put(note('doomed'), dirSel('/doomed'));
        const keeper = await ws.put(note('keeper'), dirSel('/keeper'));
        await ws.unlink(doomed, dirSel('/doomed'), { trashIfOrphaned: true });

        const result = await ws.emptyTrash();

        assert.ok(result.destroyed.includes(doomed));
        assert.deepEqual(await trashIds(), []);
        assert.equal(await ws.get(doomed).catch(() => null), null);
        assert.ok(await ws.get(keeper));
    });
});
