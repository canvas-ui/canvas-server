import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import workspaceDocumentRoutes from '../../../../src/transports/routes/workspaces/documents.js';
import { startWorkspace } from '../../webdav/harness.js';

/**
 * `linkedHere` on a path-scoped listing: whether the document is filed AT the
 * listed path or is showing through from one below it (a context path lists
 * its whole subtree — see docs/data-representation.md §2b-i).
 *
 * canvas-fuse renders documents as files and has no view of the tree, so this
 * flag is the whole of what it knows about placement: it decides which of two
 * same-named documents keeps the plain filename in a folder. A real workspace
 * here, not a mock — the answer is bitmap arithmetic, and a mock would only
 * assert that the route passes its own stub around.
 */
describe('linkedHere on a path-scoped document listing', () => {
    let h;
    let app;
    let ids;

    before(async () => {
        h = await startWorkspace('route-placement-');

        // Deepest first, so document id and placement disagree.
        const put = (treePath, content) => h.ws.db.put(
            { schema: 'data/schema/note', data: { title: 'CLAUDE', content } },
            { context: { tree: 'context', path: treePath } },
        );
        ids = {
            task: await put('/dc-migration/tasks/foo', 'task guidance'),
            project: await put('/dc-migration', 'migration guidance'),
            root: await put('/', 'workspace guidance'),
        };

        app = Fastify();
        app.decorate('authenticate', async (request) => { request.user = { id: 'user-1' }; });
        app.decorate('authenticateClient', async (request) => { request.user = { id: 'user-1' }; });
        app.decorate('workspaceManager', {
            resolveWorkspaceId: () => h.ws.id,
            getWorkspace: async () => h.ws,
        });
        app.register(workspaceDocumentRoutes, { prefix: '/workspaces/:id/documents' });
        await app.ready();
    });

    after(async () => {
        await app?.close();
        await h?.stop();
    });

    const listAt = async (treePath, extra = '') => {
        const url = `/workspaces/ws/documents?treeNameOrTreeId=context&treeType=context&context=${encodeURIComponent(treePath)}${extra}`;
        const response = await app.inject({ method: 'GET', url });
        assert.equal(response.statusCode, 200);
        return response.json().payload;
    };

    const placement = (docs) => Object.fromEntries(docs.map((doc) => [doc.id, doc.linkedHere]));

    test('says which document each path holds, not which was created first', async () => {
        const atRoot = await listAt('/');
        assert.equal(atRoot.length, 3, 'a path lists its whole subtree');
        assert.deepEqual(placement(atRoot), {
            [ids.root]: true,
            [ids.project]: false,
            [ids.task]: false,
        });

        assert.deepEqual(placement(await listAt('/dc-migration')), {
            [ids.project]: true,
            [ids.task]: false,
        });

        // A leaf has nothing below it: everything listed there is filed there.
        assert.deepEqual(placement(await listAt('/dc-migration/tasks/foo')), {
            [ids.task]: true,
        });
    });

    test('the documents themselves are unchanged by the flag', async () => {
        const [doc] = await listAt('/dc-migration/tasks/foo');
        assert.equal(doc.schema, 'data/schema/note');
        assert.equal(doc.data.content, 'task guidance');
        assert.ok(doc.checksumArray, 'the record is the whole record');
    });

    test('idsOnly stays a bare id list', async () => {
        const ids = await listAt('/', '&idsOnly=true');
        assert.ok(ids.every((entry) => typeof entry === 'number'), `got ${JSON.stringify(ids)}`);
    });
});
