import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Readable } from 'stream';
import workspaceDocumentRoutes from './documents.js';

// Route-level tests for the per-document sub-resources added for the object
// properties card: /memberships, /content ?url allowlist + attachment headers,
// /destroy keepDocument passthrough.

const EMAIL_DOC = {
    id: 42,
    schema: 'data/abstraction/email',
    metadata: { contentType: 'message/rfc822', size: 1000 },
    locations: [
        { url: 'stored://workspace:data/raw-eml-key' },
        { url: 'imap://alice@example.com/INBOX;UID=5' },
    ],
    data: {
        subject: 'hi',
        attachments: [
            { filename: 'report.pdf', contentType: 'application/pdf', size: 77, url: 'stored://workspace:data/att-key' },
        ],
    },
};

describe('workspace document sub-resource routes', () => {
    let app;
    let workspace;

    beforeEach(async () => {
        workspace = {
            isActive: true,
            destroyCalls: [],
            resolveCalls: [],
            async get(id) { return id === 42 ? EMAIL_DOC : null; },
            async resolveDocument(doc, options = {}) {
                this.resolveCalls.push(options);
                return { stream: Readable.from(Buffer.from('bytes')), url: options.url || doc.locations[0].url };
            },
            async destroyDocument(doc, options = {}) {
                this.destroyCalls.push({ id: doc.id, options });
                return { deleted: options.urls || [], droppedRefs: [], kept: [], docDeleted: options.keepDocument !== true };
            },
            async listTrees() {
                return [
                    { id: 'ctx-tree-id', name: 'context', type: 'context' },
                    { id: 'dir-tree-id', name: 'directory', type: 'directory' },
                ];
            },
            getTree(nameOrId) {
                if (nameOrId === 'directory' || nameOrId === 'dir-tree-id') {
                    return { id: 'dir-tree-id', name: 'directory', type: 'directory' };
                }
                return { id: 'ctx-tree-id', name: 'context', type: 'context' };
            },
            async listDocumentTreeMemberships(id, treeId) {
                return treeId === 'dir-tree-id' ? ['/.backends/imap/alice@example.com/inbox'] : ['/work/mail'];
            },
        };

        app = Fastify();
        app.decorate('authenticate', async (request) => { request.user = { id: 'user-id' }; });
        app.decorate('authenticateClient', async (request) => { request.user = { id: 'user-id' }; });
        app.decorate('workspaceManager', {
            resolveWorkspaceId: () => 'workspace-id',
            getWorkspace: async () => workspace,
        });
        app.register(workspaceDocumentRoutes, { prefix: '/workspaces/:id/documents' });
        await app.ready();
    });

    afterEach(async () => {
        await app.close();
    });

    test('GET /:docId/memberships returns per-tree paths', async () => {
        const response = await app.inject({ method: 'GET', url: '/workspaces/universe/documents/42/memberships' });
        assert.equal(response.statusCode, 200);
        const { payload } = response.json();
        assert.equal(payload.documentId, 42);
        assert.equal(payload.memberships.length, 2);
        const dir = payload.memberships.find((m) => m.type === 'directory');
        assert.deepEqual(dir.paths, ['/.backends/imap/alice@example.com/inbox']);
        const ctx = payload.memberships.find((m) => m.type === 'context');
        assert.deepEqual(ctx.paths, ['/work/mail']);
    });

    test('GET /:docId/memberships?tree= scopes to one tree', async () => {
        const response = await app.inject({ method: 'GET', url: '/workspaces/universe/documents/42/memberships?tree=directory' });
        assert.equal(response.statusCode, 200);
        const { payload } = response.json();
        assert.equal(payload.memberships.length, 1);
        assert.equal(payload.memberships[0].tree, 'directory');
    });

    test('GET /:docId/memberships 404s on unknown doc', async () => {
        const response = await app.inject({ method: 'GET', url: '/workspaces/universe/documents/7/memberships' });
        assert.equal(response.statusCode, 404);
    });

    test('content ?url rejects a URL that is not the doc\'s own', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/workspaces/universe/documents/42/content?url=' + encodeURIComponent('stored://workspace:data/other-docs-blob'),
        });
        assert.equal(response.statusCode, 403);
        assert.equal(workspace.resolveCalls.length, 0);
    });

    test('content ?url allows own location url', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/workspaces/universe/documents/42/content?url=' + encodeURIComponent('stored://workspace:data/raw-eml-key'),
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-type'], 'message/rfc822');
        assert.equal(response.headers['content-length'], '1000');
    });

    test('content ?url for an attachment uses attachment headers, not doc metadata', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/workspaces/universe/documents/42/content?url=' + encodeURIComponent('stored://workspace:data/att-key') + '&download',
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['content-type'], 'application/pdf');
        assert.equal(response.headers['content-length'], '77');
        assert.match(response.headers['content-disposition'], /filename="report\.pdf"/);
    });

    test('DELETE /destroy passes urls + keepDocument through to destroyDocument', async () => {
        const response = await app.inject({
            method: 'DELETE',
            url: '/workspaces/universe/documents/destroy',
            payload: { documentIds: [42], urls: ['stored://workspace:data/raw-eml-key'], keepDocument: true },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(workspace.destroyCalls.length, 1);
        assert.deepEqual(workspace.destroyCalls[0].options, {
            urls: ['stored://workspace:data/raw-eml-key'],
            keepDocument: true,
        });
        const { payload } = response.json();
        assert.equal(payload.successful[0].docDeleted, false);
    });

    test('DELETE /destroy defaults keepDocument to false', async () => {
        const response = await app.inject({
            method: 'DELETE',
            url: '/workspaces/universe/documents/destroy',
            payload: { documentIds: [42] },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(workspace.destroyCalls[0].options.keepDocument, false);
    });
});
