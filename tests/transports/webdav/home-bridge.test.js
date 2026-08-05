import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'fs-extra';

import { startWorkspace } from './harness.js';

/**
 * `Home/` is a real filesystem; the other roots are the index. Moving between
 * them is the one case where bytes genuinely move — everything inside the index
 * is a membership change. Home → tree is an ingest (persistBlob + a File
 * document), tree → Home is a materialization.
 */

describe('webdav home ↔ index bridge', () => {
    let h;

    before(async () => { h = await startWorkspace('dav-home-'); });
    after(async () => { await h?.stop(); });

    const homeFile = (relPath) => path.join(h.ws.homePath, relPath);

    test('moving a file out of Home files it into the tree and removes the original', async () => {
        await fs.outputFile(homeFile('inbox/scan.pdf'), 'scanned bytes');

        const res = await h.dav('MOVE', '/Home/inbox/scan.pdf', {
            headers: { destination: '/workspaces/ws/dav/Trees/directory/filed/scan.pdf', host: 'localhost' },
        });
        assert.equal(res.statusCode, 201);

        const doc = await h.docAt('/filed', 'scan.pdf');
        assert.ok(doc, 'a File document should exist at the destination');
        assert.equal(doc.schema, 'data/schema/file');
        assert.match(doc.locations[0].url, /^stored:\/\/workspace:data\//);
        assert.equal((await h.dav('GET', '/Trees/directory/filed/scan.pdf')).body.toString(), 'scanned bytes');
        assert.equal(await fs.pathExists(homeFile('inbox/scan.pdf')), false, 'MOVE must remove the original');
    });

    test('copying out of Home leaves the original in place', async () => {
        await fs.outputFile(homeFile('inbox/keep.txt'), 'keep me');

        const res = await h.dav('COPY', '/Home/inbox/keep.txt', {
            headers: { destination: '/workspaces/ws/dav/Trees/directory/filed/keep.txt', host: 'localhost' },
        });
        assert.equal(res.statusCode, 201);

        assert.ok(await h.docAt('/filed', 'keep.txt'));
        assert.equal(await fs.readFile(homeFile('inbox/keep.txt'), 'utf-8'), 'keep me');
    });

    test('copying a document into Home writes a real file and keeps the document', async () => {
        await h.dav('PUT', '/Trees/directory/out/export.txt', { body: Buffer.from('export me') });
        const doc = await h.docAt('/out', 'export.txt');

        const res = await h.dav('COPY', '/Trees/directory/out/export.txt', {
            headers: { destination: '/workspaces/ws/dav/Home/exports/export.txt', host: 'localhost' },
        });
        assert.equal(res.statusCode, 201);

        assert.equal(await fs.readFile(homeFile('exports/export.txt'), 'utf-8'), 'export me');
        assert.deepEqual(await h.dirPaths(doc.id), ['/out'], 'COPY must not unfile the document');
    });

    test('moving a document into Home unfiles it, and trashes it if that was its last placement', async () => {
        await h.dav('PUT', '/Trees/directory/out/leaving.txt', { body: Buffer.from('leaving') });
        const doc = await h.docAt('/out', 'leaving.txt');

        const res = await h.dav('MOVE', '/Trees/directory/out/leaving.txt', {
            headers: { destination: '/workspaces/ws/dav/Home/exports/leaving.txt', host: 'localhost' },
        });
        assert.equal(res.statusCode, 201);

        assert.equal(await fs.readFile(homeFile('exports/leaving.txt'), 'utf-8'), 'leaving');
        // Removed from the tree, but recoverable — the bytes left the index, the
        // document did not cease to exist.
        assert.deepEqual(await h.dirPaths(doc.id), ['/.trash']);
        assert.ok((await h.listNames('/Trash')).includes('leaving.txt'));
    });

    test('re-ingesting the same bytes resolves to the same document', async () => {
        await fs.outputFile(homeFile('inbox/twice.txt'), 'identical bytes');
        await h.dav('COPY', '/Home/inbox/twice.txt', {
            headers: { destination: '/workspaces/ws/dav/Trees/directory/a/twice.txt', host: 'localhost' },
        });
        const first = await h.docAt('/a', 'twice.txt');

        await h.dav('COPY', '/Home/inbox/twice.txt', {
            headers: { destination: '/workspaces/ws/dav/Trees/directory/b/twice.txt', host: 'localhost' },
        });
        const second = await h.docAt('/b', 'twice.txt');

        // Content addressing: one document, two placements — not two documents.
        assert.equal(second.id, first.id);
        assert.deepEqual((await h.dirPaths(first.id)).sort(), ['/a', '/b']);
    });

    test('a folder cannot be filed into a tree as if it were a file', async () => {
        await fs.ensureDir(homeFile('inbox/adir'));
        const res = await h.dav('MOVE', '/Home/inbox/adir', {
            headers: { destination: '/workspaces/ws/dav/Trees/directory/filed/adir', host: 'localhost' },
        });
        assert.equal(res.statusCode, 502);
        assert.ok(await fs.pathExists(homeFile('inbox/adir')));
    });
});
