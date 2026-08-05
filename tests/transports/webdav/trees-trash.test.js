import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

import { WebDAVHandler } from '../../../src/transports/webdav/server.js';
import Workspace from '../../../src/core/workspace/Workspace.js';
import {
    WORKSPACE_LAYOUTS,
    workspaceInternals,
    workspaceServices,
} from '../../../src/core/workspace/lib/constants.js';

/**
 * WebDAV over the index-backed roots: delete detaches (and trashes the last
 * placement), MOVE re-tags by document id instead of copying bytes, and the
 * Trash root is a real destination you can drag into and out of.
 *
 * Driven through the real handler with a fake ServerResponse — the routing,
 * the Destination parsing and the cross-root resolution are exactly what these
 * tests are for, so stubbing them out would leave nothing worth testing.
 */

const PREFIX = '/workspaces/ws/dav';

function fakeRes() {
    const res = {
        statusCode: null,
        headers: {},
        body: Buffer.alloc(0),
        headersSent: false,
        setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
        writeHead(code, headers) {
            this.statusCode = code;
            this.headersSent = true;
            Object.assign(this.headers, headers || {});
        },
        end(chunk) {
            if (chunk) { this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); }
            this.headersSent = true;
            this.done = true;
        },
    };
    return res;
}

describe('webdav trees + trash', () => {
    let root;
    let ws;
    let handler;

    const dav = async (method, davPath, { body, headers = {} } = {}) => {
        const res = fakeRes();
        await handler.handle(res, {
            method,
            url: PREFIX + davPath,
            headers,
            body,
            userId: 'user-1',
            workspace: 'ws',
        });
        return res;
    };

    const listNames = async (davPath) => {
        const res = await dav('PROPFIND', davPath, { headers: { depth: '1' } });
        const xml = res.body.toString();
        return [...xml.matchAll(/<D:displayname>([^<]*)<\/D:displayname>/g)].map((m) => m[1]);
    };

    const dirPaths = async (id) => {
        const placements = await ws.listDocumentPlacements(id);
        return placements.find((p) => p.tree === 'directory')?.paths ?? [];
    };

    const putNote = async (davPath, content) =>
        dav('PUT', davPath, { body: Buffer.from(content, 'utf-8') });

    before(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'dav-trash-'));
        const store = {
            id: 'ws-dav-1',
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

        handler = new WebDAVHandler(async () => ({
            homePath: ws.homePath,
            workspace: ws,
            contextManager: null,
        }));
    });

    after(async () => {
        await ws?.stop().catch(() => {});
        if (root) { await fs.remove(root); }
    });

    test('the DAV root advertises Trash alongside Home, Contexts and Trees', async () => {
        const names = await listNames('/');
        for (const expected of ['Home', 'Contexts', 'Trees', 'Trash']) {
            assert.ok(names.includes(expected), `missing root ${expected}: ${names.join(', ')}`);
        }
    });

    test('deleting a document under a tree trashes it when it was its last placement', async () => {
        await putNote('/Trees/directory/notes/todo-list.todo.json', '{"done":false}');

        const before = await listNames('/Trees/directory/notes');
        assert.ok(before.includes('todo-list.todo.json'));

        const res = await dav('DELETE', '/Trees/directory/notes/todo-list.todo.json');
        assert.equal(res.statusCode, 204);

        const trash = await listNames('/Trash');
        assert.ok(trash.includes('todo-list.todo.json'), `trash held: ${trash.join(', ')}`);
    });

    test('MOVE between tree paths re-tags the same document — no copy, no new id', async () => {
        await putNote('/Trees/directory/src/moving.todo.json', '{"a":1}');
        const doc = await ws.db.list({ context: null, directory: { tree: 'directory', path: '/src' } })
            .then((docs) => docs.find((d) => d.data?.filename === 'moving.todo.json'));
        assert.ok(doc, 'document should exist at the source path');

        const res = await dav('MOVE', '/Trees/directory/src/moving.todo.json', {
            headers: { destination: `${PREFIX}/Trees/directory/dst/moving.todo.json`, host: 'localhost' },
        });
        assert.equal(res.statusCode, 201);

        assert.deepEqual(await dirPaths(doc.id), ['/dst']);
        assert.ok((await listNames('/Trees/directory/dst')).includes('moving.todo.json'));
        assert.equal((await listNames('/Trees/directory/src')).includes('moving.todo.json'), false);
    });

    test('MOVE onto Trash removes the document from every path at once', async () => {
        await putNote('/Trees/directory/one/shared.todo.json', '{"a":2}');
        const doc = await ws.db.list({ context: null, directory: { tree: 'directory', path: '/one' } })
            .then((docs) => docs.find((d) => d.data?.filename === 'shared.todo.json'));
        await ws.link(doc.id, { context: null, directory: ws.getDirectoryTreeSelector('/two', 'directory') });
        assert.deepEqual((await dirPaths(doc.id)).sort(), ['/one', '/two']);

        const res = await dav('MOVE', '/Trees/directory/one/shared.todo.json', {
            headers: { destination: `${PREFIX}/Trash/shared.todo.json`, host: 'localhost' },
        });
        assert.equal(res.statusCode, 201);

        // Dragging to the trash is the explicit "remove it everywhere" gesture,
        // unlike a plain delete which only detaches from one path.
        assert.deepEqual(await dirPaths(doc.id), [Workspace.TRASH_PATH]);
        assert.ok((await listNames('/Trash')).includes('shared.todo.json'));
    });

    test('MOVE out of Trash restores the document to the destination path', async () => {
        const trashed = (await ws.listTrash()).documents.find((d) => d.data?.filename === 'shared.todo.json');
        assert.ok(trashed);

        const res = await dav('MOVE', '/Trash/shared.todo.json', {
            headers: { destination: `${PREFIX}/Trees/directory/recovered/shared.todo.json`, host: 'localhost' },
        });
        assert.equal(res.statusCode, 201);

        assert.deepEqual(await dirPaths(trashed.id), ['/recovered']);
        assert.equal((await listNames('/Trash')).includes('shared.todo.json'), false);
    });

    test('DELETE inside Trash destroys — the one place a mount may', async () => {
        await putNote('/Trees/directory/doomed/gone.todo.json', '{"x":1}');
        const doc = await ws.db.list({ context: null, directory: { tree: 'directory', path: '/doomed' } })
            .then((docs) => docs.find((d) => d.data?.filename === 'gone.todo.json'));
        await dav('DELETE', '/Trees/directory/doomed/gone.todo.json');
        assert.ok((await listNames('/Trash')).includes('gone.todo.json'));

        const res = await dav('DELETE', '/Trash/gone.todo.json');
        assert.equal(res.statusCode, 204);

        assert.equal((await listNames('/Trash')).includes('gone.todo.json'), false);
        assert.equal(await ws.get(doc.id).catch(() => null), null);
    });

    test('client sidecar files are accepted and dropped, never stored', async () => {
        const res = await putNote('/Trees/directory/notes/.DS_Store', 'finder junk');
        assert.equal(res.statusCode, 201);

        assert.equal((await listNames('/Trees/directory/notes')).includes('.DS_Store'), false);
        // And removing one is a no-op success rather than a 404 mid-copy.
        assert.equal((await dav('DELETE', '/Trees/directory/notes/._resource')).statusCode, 204);
    });

    test('COPY files the same document at a second path — no duplicate', async () => {
        await putNote('/Trees/directory/copysrc/shared-copy.todo.json', '{"a":9}');
        const doc = await ws.db.list({ context: null, directory: { tree: 'directory', path: '/copysrc' } })
            .then((docs) => docs.find((d) => d.data?.filename === 'shared-copy.todo.json'));

        const res = await dav('COPY', '/Trees/directory/copysrc/shared-copy.todo.json', {
            headers: { destination: `${PREFIX}/Trees/directory/copydst/shared-copy.todo.json`, host: 'localhost' },
        });
        assert.equal(res.statusCode, 201);

        // One document, two placements — the source keeps its copy.
        assert.deepEqual((await dirPaths(doc.id)).sort(), ['/copydst', '/copysrc']);
        assert.ok((await listNames('/Trees/directory/copysrc')).includes('shared-copy.todo.json'));
        assert.ok((await listNames('/Trees/directory/copydst')).includes('shared-copy.todo.json'));
    });

    test('MOVE renames a folder, and its documents come along', async () => {
        await putNote('/Trees/directory/oldname/inside.todo.json', '{"a":10}');
        const doc = await ws.db.list({ context: null, directory: { tree: 'directory', path: '/oldname' } })
            .then((docs) => docs.find((d) => d.data?.filename === 'inside.todo.json'));

        const res = await dav('MOVE', '/Trees/directory/oldname', {
            headers: { destination: `${PREFIX}/Trees/directory/newname`, host: 'localhost' },
        });
        assert.equal(res.statusCode, 201);

        assert.deepEqual(await dirPaths(doc.id), ['/newname']);
        assert.ok((await listNames('/Trees/directory/newname')).includes('inside.todo.json'));
    });

    test('the trash path is not offered a second time inside its own tree', async () => {
        // It has its own root; listing it here too would be a second door into
        // the same folder, one that bypasses the trash semantics.
        await putNote('/Trees/directory/hidden/gone-soon.todo.json', '{"a":11}');
        await dav('DELETE', '/Trees/directory/hidden/gone-soon.todo.json');
        assert.ok((await listNames('/Trash')).includes('gone-soon.todo.json'));

        assert.equal((await listNames('/Trees/directory')).includes('.trash'), false);
    });

    test('the trash is not a write target', async () => {
        const res = await putNote('/Trash/nope.todo.json', '{"a":1}');
        assert.equal(res.statusCode, 403);
    });
});
