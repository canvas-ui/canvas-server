'use strict';

// Relocated from canvas-synapsd/tests (jest) during de-submoduling: it tests
// the SERVER's Workspace query translation against a real synapsd, and only
// ever ran there because synapsd was physically nested under src/services/.
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Workspace from '../../../src/core/workspace/Workspace.js';

const NOTE_SCHEMA = 'data/schema/note';

class MemoryConfig {
    constructor(seed = {}) {
        this.store = { ...seed };
    }

    get(key, fallback = undefined) {
        return Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : fallback;
    }

    set(key, value) {
        this.store[key] = value;
    }
}

function note(title) {
    return {
        schema: NOTE_SCHEMA,
        data: { title, content: title },
    };
}

function ids(results) {
    return results.map((doc) => doc.id).sort((a, b) => a - b);
}

describe('Workspace query translation', () => {
    let rootPath;
    let workspace;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-synapsd-test-'));
        workspace = new Workspace({
            rootPath,
            configStore: new MemoryConfig({
                id: 'workspace-query-test',
                name: 'Workspace Query Test',
                services: { home: { enabled: false } },
            }),
            logger: {
                debug() {},
                info() {},
                warn() {},
                error() {},
            },
        });
        await workspace.start();
    });

    afterEach(async () => {
        if (workspace) {
            await workspace.stop();
            workspace = null;
        }
        if (rootPath) {
            await fs.rm(rootPath, { recursive: true, force: true });
            rootPath = null;
        }
    });

    test('translates attributes to synapsd features and forwards pagination options', async () => {
        const firstId = await workspace.put(note('first'), { attributes: ['tag/workspace'] });
        const secondId = await workspace.put(note('second'), { attributes: ['tag/workspace'] });
        await workspace.put(note('third'), { attributes: ['tag/other'] });

        assert.deepEqual(ids(await workspace.list({ attributes: { allOf: ['tag/workspace'] } })), [firstId, secondId]);

        const page = await workspace.list({ attributes: { allOf: ['tag/workspace'] }, limit: 1, offset: 1 });
        assert.equal(page.length, 1);
        assert.equal(page[0].id, secondId);
        assert.equal(page.totalCount, 2);
    });

    test('composes canvas querySpec before delegating to synapsd', async () => {
        const tree = workspace.getDefaultContextTree();
        await tree.insertPath('/Saved', {
            leafType: 'canvas',
            querySpec: { features: { allOf: ['tag/canvas'] } },
        });

        const canvasDocId = await workspace.put(note('canvas match'), { attributes: ['tag/canvas'] });
        await workspace.put(note('canvas miss'), { attributes: ['tag/other'] });

        assert.deepEqual(ids(await workspace.list({ context: '/Saved' })), [canvasDocId]);
    });

    // Regression: the ctx:/dir: grammar migration must be honored on EVERY op,
    // not just writes. These guard the bugs that broke directory-tree sync:
    //   - reads forcing the selector into context (dir docs queried as ctx:)
    //   - unlinkMany referencing a non-existent `options` ("options is not defined")
    //   - the paths grammar not being authoritative (dir-only op dragging in ctx:/)
    describe('directory tree operations', () => {
        test('put → list → has → unlink round-trips on a directory path', async () => {
            const id = await workspace.put(note('dir-doc'), { context: null, directory: '/Docs' });

            // List must target the directory tree, not context.
            assert.deepEqual(ids(await workspace.list({ directory: '/Docs' })), [id]);
            assert.equal(await workspace.has(id, { directory: '/Docs' }), true);

            // Unlink from a directory path must succeed (no "options is not defined").
            const result = await workspace.unlinkMany([id], { directory: '/Docs' });
            assert.deepEqual(result.failed, []);
            assert.deepEqual(ids(result.successful), [id]);

            // Gone from the directory path afterwards.
            assert.deepEqual(ids(await workspace.list({ directory: '/Docs' })), []);
        });

        test('context and directory trees are isolated at the same path', async () => {
            const ctxId = await workspace.put(note('ctx'), { context: '/Shared' });
            const dirId = await workspace.put(note('dir'), { context: null, directory: '/Shared' });

            assert.deepEqual(ids(await workspace.list({ context: '/Shared' })), [ctxId]);
            assert.deepEqual(ids(await workspace.list({ directory: '/Shared' })), [dirId]);
        });

        test('a directory-only write does not leak into a context path', async () => {
            const dirId = await workspace.put(note('dir-only'), { context: null, directory: '/Isolated' });

            // Addressable under the directory tree, but not via the same context path
            // (root '/' is the universal set, so we assert the specific path instead).
            assert.deepEqual(ids(await workspace.list({ directory: '/Isolated' })), [dirId]);
            assert.deepEqual(ids(await workspace.list({ context: '/Isolated' })), []);
        });
    });
});
