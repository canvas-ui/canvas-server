import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EventEmitter from 'eventemitter2';
import HookService from '../../../../../src/core/workspace/services/hook/index.js';
import PendingActionStore, { applyAmendments } from '../../../../../src/core/workspace/services/hook/pending-actions.js';

function createWorkspace(id, rootPath) {
    const workspace = new EventEmitter({ wildcard: true, delimiter: '.', newListener: false });
    workspace.id = id;
    workspace.name = 'test-workspace';
    workspace.rootPath = rootPath;
    workspace.hooksPath = path.join(rootPath, 'git/hooks');
    workspace.isActive = false;
    return workspace;
}

describe('PendingActionStore', () => {
    let rootPath;
    let store;

    beforeEach(() => {
        rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-store-'));
        store = new PendingActionStore(rootPath);
    });

    afterEach(() => {
        fs.rmSync(rootPath, { recursive: true, force: true });
    });

    test('propose + get round-trips a pending record', async () => {
        const record = store.propose({ handler: 'r1', title: 'File invoice', actions: [{ action: 'link', paths: ['/x'] }] });
        assert.ok(record.actionId.startsWith('pa_'));
        assert.equal(record.status, 'pending');

        const read = await store.get(record.actionId);
        assert.equal(read.title, 'File invoice');
        assert.equal(read.status, 'pending');
    });

    test('supersede wins on read (last-write-wins per actionId)', async () => {
        const record = store.propose({ handler: 'r1', actions: [] });
        store.supersede(record, { status: 'declined', decidedAt: new Date().toISOString() });

        const read = await store.get(record.actionId);
        assert.equal(read.status, 'declined');

        const pending = await store.query({ status: 'pending' });
        assert.equal(pending.length, 0);
        const declined = await store.query({ status: 'declined' });
        assert.equal(declined.length, 1);
    });

    test('pending record past expiresAt reads as expired', async () => {
        const record = store.propose({ handler: 'r1', actions: [], expiresAt: new Date(Date.now() - 1000).toISOString() });
        const read = await store.get(record.actionId);
        assert.equal(read.status, 'expired');
        assert.equal((await store.query({ status: 'pending' })).length, 0);
        assert.equal((await store.query({ status: 'expired' })).length, 1);
    });

    test('query returns newest first and respects limit', async () => {
        store.propose({ handler: 'a', actions: [] });
        store.propose({ handler: 'b', actions: [] });
        store.propose({ handler: 'c', actions: [] });
        const all = await store.query({});
        assert.deepEqual(all.map((r) => r.handler), ['c', 'b', 'a']);
        assert.equal((await store.query({ limit: 2 })).length, 2);
    });
});

describe('applyAmendments', () => {
    const record = {
        actionId: 'pa_1',
        actions: [{ action: 'agent', prompt: 'x', output: { note: { path: '/drafts', title: 'Draft' } } }],
        editable: ['actions.0.output.note.title'],
    };

    test('applies allowlisted path and marks amended', () => {
        const next = applyAmendments(record, { 'actions.0.output.note.title': 'Better title' });
        assert.equal(next.actions[0].output.note.title, 'Better title');
        assert.equal(next.amended, true);
        // original untouched
        assert.equal(record.actions[0].output.note.title, 'Draft');
    });

    test('rejects paths outside the allowlist', () => {
        assert.throws(() => applyAmendments(record, { 'actions.0.prompt': 'evil' }), /not amendable/);
    });

    test('rejects non-resolving paths', () => {
        const rec = { ...record, editable: ['actions.5.output.note.title'] };
        assert.throws(() => applyAmendments(rec, { 'actions.5.output.note.title': 'x' }), /does not resolve/);
    });
});

describe('HookService approval flow', () => {
    let rootPath;
    let workspace;
    let service;
    let linkCalls;
    const doc = { id: 7, schema: 'data/abstraction/email', data: { subject: 'Invoice 42', from: 'foo@bar.baz' } };

    function writeRules(rules) {
        fs.mkdirSync(workspace.hooksPath, { recursive: true });
        fs.writeFileSync(path.join(workspace.hooksPath, 'rules.json'), JSON.stringify({ rules }));
    }

    function emitEmail() {
        workspace.emit('document.inserted', {
            id: doc.id,
            document: doc,
            context: { paths: ['/inbox'] },
            eventId: 'evt_test_1',
            source: 'db',
        });
    }

    const approvalRule = {
        id: 'invoice-router',
        description: 'File invoice + forward',
        approval: true,
        ttl: '24h',
        when: { event: 'document.inserted', schema: 'email' },
        then: [{ action: 'link', paths: ['/accounting/received'] }],
    };

    beforeEach(() => {
        rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-approval-'));
        workspace = createWorkspace('workspace-approval', rootPath);
        linkCalls = [];
        workspace.getContextTreeSelector = (p) => ({ type: 'context', path: p });
        workspace.link = async (id, opts) => linkCalls.push({ id, opts });
        workspace.get = async (id) => (id === doc.id ? doc : null);
        service = new HookService({
            workspaceManager: { getWorkspace: async () => workspace },
        });
        service.trackWorkspace(workspace);
    });

    afterEach(() => {
        service.untrackWorkspace(workspace.id);
        fs.rmSync(rootPath, { recursive: true, force: true });
    });

    test('approval rule proposes instead of executing', async () => {
        writeRules([approvalRule]);
        const proposed = [];
        workspace.on('action.proposed', (p) => proposed.push(p));

        emitEmail();
        await new Promise((resolve) => setTimeout(resolve, 30));

        assert.equal(linkCalls.length, 0, 'held action must not execute');
        assert.equal(proposed.length, 1);

        const pending = await service.pendingFor(workspace).query({ status: 'pending' });
        assert.equal(pending.length, 1);
        assert.equal(pending[0].handler, 'invoice-router');
        assert.equal(pending[0].event, 'document.inserted');
        assert.ok(pending[0].expiresAt, 'rule ttl sets expiresAt');
        assert.deepEqual(pending[0].actions, approvalRule.then);
        // envelope stores the doc as a stub, not the full body
        assert.deepEqual(pending[0].envelope.payload.document, { id: 7, schema: doc.schema });

        const runs = await service.runLogFor(workspace).query({});
        assert.ok(runs.some((r) => r.status === 'held' && r.handler === 'invoice-router'));
    });

    test('approve executes the stored action with rule provenance', async () => {
        writeRules([approvalRule]);
        emitEmail();
        await new Promise((resolve) => setTimeout(resolve, 30));

        const [pending] = await service.pendingFor(workspace).query({ status: 'pending' });
        const decided = await service.decidePending(workspace, pending.actionId, { decision: 'approve', decidedBy: 'user-1' });

        assert.equal(decided.status, 'approved');
        assert.equal(decided.decidedBy, 'user-1');
        assert.equal(decided.result[0].status, 'ok');
        assert.equal(linkCalls.length, 1);
        assert.deepEqual(linkCalls[0].opts.context, { type: 'context', path: '/accounting/received' });
        assert.equal(linkCalls[0].opts.provenance.origin, 'rule');
        assert.equal(linkCalls[0].opts.provenance.causedBy, 'evt_test_1');

        const runs = await service.runLogFor(workspace).query({});
        assert.ok(runs.some((r) => r.trigger === 'approval' && r.status === 'ok'));
        // re-approving a decided action is rejected
        await assert.rejects(
            () => service.decidePending(workspace, pending.actionId, { decision: 'approve' }),
            /only pending or failed/,
        );
    });

    test('decline never executes and supersedes the record', async () => {
        writeRules([approvalRule]);
        emitEmail();
        await new Promise((resolve) => setTimeout(resolve, 30));

        const [pending] = await service.pendingFor(workspace).query({ status: 'pending' });
        const decided = await service.decidePending(workspace, pending.actionId, { decision: 'decline' });

        assert.equal(decided.status, 'declined');
        assert.equal(linkCalls.length, 0);
        assert.equal((await service.pendingFor(workspace).query({ status: 'pending' })).length, 0);
    });

    test('action-level approval holds only the flagged action', async () => {
        writeRules([{
            id: 'split-rule',
            when: { event: 'document.inserted', schema: 'email' },
            then: [
                { action: 'link', paths: ['/inbox/processed'] },
                { action: 'link', paths: ['/accounting/received'], approval: true },
            ],
        }]);
        emitEmail();
        await new Promise((resolve) => setTimeout(resolve, 30));

        assert.equal(linkCalls.length, 1, 'immediate action executed');
        assert.deepEqual(linkCalls[0].opts.context, { type: 'context', path: '/inbox/processed' });
        const pending = await service.pendingFor(workspace).query({ status: 'pending' });
        assert.equal(pending.length, 1);
        assert.deepEqual(pending[0].actions, [{ action: 'link', paths: ['/accounting/received'], approval: true }]);
    });

    test('amended approve applies allowlisted edits before execution', async () => {
        writeRules([{
            ...approvalRule,
            editable: ['actions.0.paths'],
        }]);
        emitEmail();
        await new Promise((resolve) => setTimeout(resolve, 30));

        const [pending] = await service.pendingFor(workspace).query({ status: 'pending' });
        const decided = await service.decidePending(workspace, pending.actionId, {
            decision: 'approve',
            amend: { 'actions.0.paths': ['/accounting/2026/07/received'] },
        });

        assert.equal(decided.status, 'approved');
        assert.equal(decided.amended, true);
        assert.equal(linkCalls.length, 1);
        assert.deepEqual(linkCalls[0].opts.context, { type: 'context', path: '/accounting/2026/07/received' });

        await assert.rejects(
            () => service.decidePending(workspace, 'pa_missing', { decision: 'approve' }),
            /not found/,
        );
    });

    test('ctx.propose from a JS hook lands in the queue', async () => {
        fs.mkdirSync(path.join(workspace.hooksPath, 'document.inserted'), { recursive: true });
        fs.writeFileSync(
            path.join(workspace.hooksPath, 'document.inserted', 'draft-reply.js'),
            `export default async function hook({ propose, payload }) {
                await propose(
                    { action: 'notify', message: 'draft for ' + payload.id },
                    { title: 'Draft reply', editable: ['actions.0.message'] },
                );
            }`,
        );
        emitEmail();
        await new Promise((resolve) => setTimeout(resolve, 50));

        const pending = await service.pendingFor(workspace).query({ status: 'pending' });
        assert.equal(pending.length, 1);
        assert.equal(pending[0].handlerType, 'hook');
        assert.equal(pending[0].handler, path.join('document.inserted', 'draft-reply.js'));
        assert.equal(pending[0].title, 'Draft reply');
        assert.deepEqual(pending[0].editable, ['actions.0.message']);
    });
});
