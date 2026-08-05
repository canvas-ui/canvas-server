import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'fs-extra';

import { startWorkspace } from './harness.js';

/**
 * Byte ranges, on both kinds of file a mount serves: real files under `Home/`
 * and blob-backed documents under the index-backed roots.
 *
 * Without this, a player seeking in a large file re-reads it from the start and
 * anything that reads a header before deciding what to do pulls the whole body
 * first — both wires streamed whole files only.
 */

const BODY = 'abcdefghijklmnopqrstuvwxyz'; // 26 bytes, offsets are obvious

describe('webdav byte ranges', () => {
    let h;

    before(async () => {
        h = await startWorkspace('dav-range-');
        await fs.outputFile(path.join(h.ws.homePath, 'files/alphabet.txt'), BODY);
        await h.dav('PUT', '/Trees/directory/files/alphabet.txt', { body: Buffer.from(BODY) });
    });
    after(async () => { await h?.stop(); });

    const get = (davPath, range) =>
        h.dav('GET', davPath, { headers: range ? { range } : {} });

    for (const [label, davPath] of [
        ['Home (a real file)', '/Home/files/alphabet.txt'],
        ['a blob-backed document', '/Trees/directory/files/alphabet.txt'],
    ]) {
        test(`${label}: a range serves exactly that window`, async () => {
            const res = await get(davPath, 'bytes=3-7');
            assert.equal(res.statusCode, 206);
            assert.equal(res.body.toString(), 'defgh');
            assert.equal(res.headers['content-range'], `bytes 3-7/${BODY.length}`);
            assert.equal(res.headers['content-length'], 5);
        });

        test(`${label}: an open-ended range runs to the end`, async () => {
            const res = await get(davPath, 'bytes=20-');
            assert.equal(res.statusCode, 206);
            assert.equal(res.body.toString(), 'uvwxyz');
        });

        test(`${label}: a suffix range serves the last bytes`, async () => {
            const res = await get(davPath, 'bytes=-4');
            assert.equal(res.statusCode, 206);
            assert.equal(res.body.toString(), 'wxyz');
        });

        test(`${label}: no range still serves the whole body`, async () => {
            const res = await get(davPath);
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.toString(), BODY);
            assert.equal(res.headers['accept-ranges'], 'bytes');
        });

        test(`${label}: a window past the end is 416, not a full body`, async () => {
            const res = await get(davPath, 'bytes=99-200');
            assert.equal(res.statusCode, 416);
            assert.equal(res.headers['content-range'], `bytes */${BODY.length}`);
            assert.equal(res.body.length, 0);
        });

        test(`${label}: a header we do not serve falls back to the whole body`, async () => {
            // Multi-range: answering 200 with everything is a legal response.
            const res = await get(davPath, 'bytes=0-3,10-12');
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.toString(), BODY);
        });
    }
});
