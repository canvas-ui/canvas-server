import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

import Workspace from '../../../src/core/workspace/Workspace.js';
import { WorkspaceStoredIndex } from '../../../src/core/workspace/lib/WorkspaceStoredIndex.js';
import {
    WORKSPACE_LAYOUTS,
    workspaceInternals,
    workspaceServices,
} from '../../../src/core/workspace/lib/constants.js';

/**
 * `Home/` is a real filesystem, so files arrive and disappear WITHOUT going
 * through the document layer — a file manager, rsync, another device. What the
 * index does about that is the whole question:
 *
 *   - a new file becomes a document, mirrored in the backends tree;
 *   - a deleted file ORPHANS its document (locations dropped, backend paths
 *     unticked) and never deletes it — curated placements are user intent and
 *     outrank backend liveness;
 *   - the bytes coming back re-bind to the same document, because identity is
 *     the checksum.
 *
 * Driven through explicit resyncs rather than the chokidar watcher: same
 * reconcile path, no timing races.
 */

const HOME_BACKEND = WorkspaceStoredIndex.HOME_STORED_BACKEND;

describe('home backend reconcile', () => {
    let root;
    let ws;

    const homeFile = (rel) => path.join(ws.homePath, rel);
    // Awaited, not background: the test acts on the result of the reconcile.
    const resync = async () => { await ws.syncBackend('file', HOME_BACKEND, { background: false }); };

    // Backend mirrors deliberately stay OUT of the user's context (the mirror
    // tree sets linkContextRoot:false) until something files them, so a
    // freshly-indexed home file is only visible through the backends tree.
    const backendDocs = async () => {
        const { documents } = await ws.listBackendDocuments('file', HOME_BACKEND);
        return documents || [];
    };
    const docForFile = async (filename) =>
        (await backendDocs()).find((doc) => (doc.locations || []).some((l) => String(l.url).endsWith(`/${filename}`))) || null;

    before(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-home-'));
        const store = {
            id: 'ws-home-1',
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
        // Index the home drive, but without chokidar: the tests drive resyncs.
        await ws.updateBackend('file', HOME_BACKEND, { enabled: true, watch: false });
    });

    after(async () => {
        await ws?.stop().catch(() => {});
        if (root) { await fs.remove(root); }
    });

    test('a file dropped into Home becomes a document', async () => {
        await fs.outputFile(homeFile('notes/plan.txt'), 'plan contents');
        await resync();

        const doc = await docForFile('plan.txt');
        assert.ok(doc, 'the scan should have indexed the new file');
        assert.equal(doc.schema, 'data/schema/file');
        assert.ok(doc.checksumArray?.length, 'a File document carries its checksum');

        const backendPaths = await ws.listDocumentTreeMemberships(doc.id, Workspace.BACKENDS_TREE_NAME);
        assert.ok(backendPaths.length > 0, 'and is mirrored in the backends tree');
    });

    test('deleting the file orphans the document and keeps what the user filed', async () => {
        // Deliberately in a SUBFOLDER: the mirror nests one tree node per folder,
        // and a non-recursive listing of the backend root sees only files sitting
        // directly in it — so absences in subfolders (i.e. almost every real
        // file) silently went unreconciled, leaving documents that point at bytes
        // which no longer exist.
        await fs.outputFile(homeFile('notes/keepme.txt'), 'user filed this');
        await resync();
        const doc = await docForFile('keepme.txt');
        assert.ok(doc);

        // The user files it somewhere of their own — that is intent, and it must
        // outlive the backing file.
        await ws.link(doc.id, { context: null, directory: ws.getDirectoryTreeSelector('/curated', 'directory') });

        await fs.remove(homeFile('notes/keepme.txt'));
        await resync();

        const after = await ws.get(doc.id);
        assert.ok(after, 'the document must survive its bytes disappearing');
        assert.deepEqual(after.locations, [], 'the dead location is dropped');
        assert.ok(after.orphanedAt, 'and the document is marked orphaned');

        const dirPaths = await ws.listDocumentTreeMemberships(doc.id, Workspace.DIRECTORY_TREE_NAME);
        assert.ok(dirPaths.includes('/curated'), 'the curated placement stays');

        const backendPaths = await ws.listDocumentTreeMemberships(doc.id, Workspace.BACKENDS_TREE_NAME);
        assert.deepEqual(backendPaths, [], 'the backend mirror path is unticked');
    });

    test('the same bytes coming back re-bind to the same document', async () => {
        await fs.outputFile(homeFile('notes/returning.txt'), 'identical bytes');
        await resync();
        const before = await docForFile('returning.txt');
        assert.ok(before);

        await fs.remove(homeFile('notes/returning.txt'));
        await resync();
        assert.deepEqual((await ws.get(before.id)).locations, []);

        // Restored from a backup, re-synced from another device, whatever.
        await fs.outputFile(homeFile('notes/returning.txt'), 'identical bytes');
        await resync();

        const after = await ws.get(before.id);
        assert.equal(after.id, before.id, 'identity is the checksum, so it is the same document');
        assert.ok(after.locations.length > 0, 'and it has its location back');
    });

    test('renaming a file keeps one document, not two', async () => {
        await fs.outputFile(homeFile('notes/before.txt'), 'renamed bytes');
        await resync();
        const before = await docForFile('before.txt');
        assert.ok(before);

        await fs.move(homeFile('notes/before.txt'), homeFile('notes/after.txt'));
        await resync();

        const after = await docForFile('after.txt');
        assert.ok(after, 'the file is indexed under its new name');
        assert.equal(after.id, before.id, 'a rename is the same bytes — one document');
        assert.ok(
            (after.locations || []).every((l) => !String(l.url).endsWith('/before.txt')),
            'the old location is gone',
        );
    });

    test('workspace internals never become documents', async () => {
        // The workspace must not index itself: its own runtime dirs are excluded
        // from the home backend.
        const before = (await backendDocs()).length;
        await fs.outputFile(path.join(ws.dbPath, 'scratch.tmp'), 'internal');
        // A dotfile in the home drive is excluded too (effectiveExclusions).
        await fs.outputFile(homeFile('.hidden/secret.txt'), 'hidden');
        await resync();
        assert.equal((await backendDocs()).length, before);
    });
});
