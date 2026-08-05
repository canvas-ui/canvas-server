import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { Writable } from 'node:stream';

import { WebDAVHandler } from '../../../src/transports/webdav/server.js';
import Workspace from '../../../src/core/workspace/Workspace.js';
import {
    WORKSPACE_LAYOUTS,
    workspaceInternals,
    workspaceServices,
} from '../../../src/core/workspace/lib/constants.js';

/**
 * A real workspace behind a real WebDAVHandler, driven with a fake
 * ServerResponse. Routing, Destination parsing and cross-root resolution are
 * exactly what these tests exist to cover, so stubbing them out would leave
 * nothing worth testing.
 */

export const PREFIX = '/workspaces/ws/dav';

/**
 * A real Writable, not an object with an end() method: file-backed documents are
 * streamed with `pipeline(content.stream, res)`, and a plain stub silently
 * swallows every streamed body.
 */
class FakeResponse extends Writable {
    constructor() {
        super();
        this.chunks = [];
        this.statusCode = null;
        this.headers = {};
        this.headersSent = false;
    }

    _write(chunk, _encoding, callback) {
        this.chunks.push(Buffer.from(chunk));
        callback();
    }

    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; }
    getHeader(key) { return this.headers[String(key).toLowerCase()]; }

    writeHead(code, headers) {
        this.statusCode = code;
        this.headersSent = true;
        Object.assign(this.headers, headers || {});
        return this;
    }

    end(chunk, encoding, callback) {
        this.headersSent = true;
        return super.end(chunk, encoding, callback);
    }

    get body() { return Buffer.concat(this.chunks); }
}

export function fakeRes() { return new FakeResponse(); }

export async function startWorkspace(prefix = 'dav-test-') {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    const store = {
        id: `ws-${path.basename(root)}`,
        name: 'ws',
        owner: 'user-1',
        layout: WORKSPACE_LAYOUTS.FULL,
        internals: { ...workspaceInternals(WORKSPACE_LAYOUTS.FULL) },
        services: workspaceServices(WORKSPACE_LAYOUTS.FULL),
    };
    const ws = new Workspace({
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

    const handler = new WebDAVHandler(async () => ({
        homePath: ws.homePath,
        workspace: ws,
        contextManager: null,
    }));

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

    return {
        ws,
        root,
        handler,
        dav,
        /** Display names PROPFIND reports for a collection. */
        listNames: async (davPath) => {
            const res = await dav('PROPFIND', davPath, { headers: { depth: '1' } });
            return [...res.body.toString().matchAll(/<D:displayname>([^<]*)<\/D:displayname>/g)].map((m) => m[1]);
        },
        /** Paths of the default directory tree that hold a document. */
        dirPaths: async (id) => {
            const placements = await ws.listDocumentPlacements(id);
            return placements.find((p) => p.tree === 'directory')?.paths ?? [];
        },
        /** The document behind a tree path, by filename. */
        docAt: async (treePath, filename) => {
            const docs = await ws.db.list({ context: null, directory: { tree: 'directory', path: treePath } });
            const { displayFilename } = await import('../../../src/transports/webdav/vfs-shared.js');
            return docs.find((doc) => displayFilename(doc) === filename) || null;
        },
        stop: async () => {
            await ws.stop().catch(() => {});
            await fs.remove(root);
        },
    };
}
