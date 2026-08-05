import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EventEmitter from 'eventemitter2';
import HookService from '../../../../../src/core/workspace/services/hook/index.js';

function createWorkspace(id = 'workspace-1', rootPath = '/tmp/workspace') {
    const workspace = new EventEmitter({ wildcard: true, delimiter: '.', newListener: false });
    workspace.id = id;
    workspace.name = 'test-workspace';
    workspace.rootPath = rootPath;
    workspace.hooksPath = path.join(rootPath, 'git/hooks');
    workspace.isActive = false;
    return workspace;
}

describe('HookService', () => {
    test('deduplicates identical workspace events briefly', async () => {
        const workspace = createWorkspace();
        const calls = [];
        const service = new HookService({
            workspaceManager: { getWorkspace: async () => workspace },
            contextManager: {},
        });
        service.registerHook({
            id: 'test-hook',
            events: ['document.inserted'],
            run: async (eventName, payload) => calls.push({ eventName, payload }),
        });

        service.trackWorkspace(workspace);
        workspace.emit('document.inserted', { id: 42, source: 'db' });
        workspace.emit('document.inserted', { id: 42, source: 'db' });
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(calls.length, 1);
    });

    test('does not dispatch hook-originated events back into hooks', async () => {
        const workspace = createWorkspace();
        const calls = [];
        const service = new HookService({
            workspaceManager: { getWorkspace: async () => workspace },
            contextManager: {},
        });
        service.registerHook({
            id: 'test-hook',
            events: ['document.inserted'],
            run: async (eventName, payload) => calls.push({ eventName, payload }),
        });

        service.trackWorkspace(workspace);
        workspace.emit('document.inserted', { id: 42, source: 'hook' });
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(calls.length, 0);
    });
});

describe('HookService declarative rules', () => {
    let rootPath;
    let workspace;
    let service;
    let linkCalls;

    function writeRules(relPath, rules) {
        const filePath = path.join(workspace.hooksPath, relPath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({ rules }));
        return filePath;
    }

    const youtubeRule = {
        id: 'youtube-to-media',
        when: { event: 'document.inserted', schema: 'tab', url: { host: 'youtube.com' } },
        then: [{ action: 'link', paths: ['/media/youtube'], tags: ['custom/video'] }],
    };

    function emitYoutubeTab(id = 7) {
        workspace.emit('document.inserted', {
            id,
            document: { id, schema: 'data/schema/tab', data: { url: 'https://www.youtube.com/watch?v=abc' } },
            context: { paths: ['/inbox'] },
            source: 'db',
        });
    }

    beforeEach(() => {
        rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-service-'));
        workspace = createWorkspace('workspace-rules', rootPath);
        fs.mkdirSync(workspace.hooksPath, { recursive: true });
        linkCalls = [];
        workspace.getContextTreeSelector = (p) => ({ type: 'context', path: p });
        workspace.link = async (id, opts) => linkCalls.push({ id, opts });
        service = new HookService({
            workspaceManager: { getWorkspace: async () => workspace },
        });
        service.trackWorkspace(workspace);
    });

    afterEach(() => {
        service.untrackWorkspace(workspace.id);
        fs.rmSync(rootPath, { recursive: true, force: true });
    });

    test('matching rule in rules.json fires link with emitEvent:false', async () => {
        writeRules('rules.json', [youtubeRule]);
        emitYoutubeTab();
        await new Promise(resolve => setTimeout(resolve, 30));

        assert.equal(linkCalls.length, 1);
        assert.equal(linkCalls[0].id, 7);
        assert.deepEqual(linkCalls[0].opts.context, { type: 'context', path: '/media/youtube' });
        assert.deepEqual(linkCalls[0].opts.features, ['custom/video']);
        assert.equal(linkCalls[0].opts.emitEvent, false);
    });

    test('non-matching event/schema leaves rules idle', async () => {
        writeRules('rules.json', [youtubeRule]);
        workspace.emit('document.inserted', {
            id: 8,
            document: { id: 8, schema: 'data/schema/note', data: { title: 'n' } },
            source: 'db',
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 0);
    });

    test('hook-originated events never reach rules', async () => {
        writeRules('rules.json', [youtubeRule]);
        workspace.emit('document.inserted', {
            id: 9,
            document: { id: 9, schema: 'data/schema/tab', data: { url: 'https://youtube.com/watch?v=x' } },
            source: 'hook',
        });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 0);
    });

    test('underscore-prefixed rule files are ignored', async () => {
        writeRules('rules/_disabled.json', [youtubeRule]);
        emitYoutubeTab();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 0);
    });

    test('editing rules.json hot-reloads (mtime cache refresh)', async () => {
        const filePath = writeRules('rules.json', [youtubeRule]);
        emitYoutubeTab(10);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 1);

        fs.writeFileSync(filePath, JSON.stringify({
            rules: [{ ...youtubeRule, then: [{ action: 'link', paths: ['/elsewhere'] }] }],
        }));
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(filePath, future, future);

        emitYoutubeTab(11);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 2);
        assert.deepEqual(linkCalls[1].opts.context, { type: 'context', path: '/elsewhere' });
    });

    test('document.inserted.batch dispatches to hooks in its event directory', async () => {
        const hookDir = path.join(workspace.hooksPath, 'document.inserted.batch');
        fs.mkdirSync(hookDir, { recursive: true });
        const resultFile = path.join(rootPath, 'batch-result.json');
        fs.writeFileSync(path.join(hookDir, 'probe.js'), `
import fs from 'node:fs';
export default async function hook({ payload, classify }) {
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
        ids: payload?.ids, inToSort: classify(payload).inPath('/to-sort'),
    }));
}
`);
        workspace.emit('document.inserted.batch', {
            ids: [1, 2, 3],
            count: 3,
            context: { paths: ['/to-sort'] },
            source: 'db',
        });
        await new Promise(resolve => setTimeout(resolve, 60));

        const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        assert.deepEqual(result, { ids: [1, 2, 3], inToSort: true });
    });

    test('hook context exposes classify()', async () => {
        const hookDir = path.join(workspace.hooksPath, 'document.inserted');
        fs.mkdirSync(hookDir, { recursive: true });
        const resultFile = path.join(rootPath, 'classify-result.json');
        fs.writeFileSync(path.join(hookDir, 'probe.js'), `
import fs from 'node:fs';
export default async function hook({ classify }) {
    const c = classify();
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({
        isTab: c.isTab(), isYoutube: c.isYoutube(), inInbox: c.inPath('/inbox'),
    }));
}
`);
        emitYoutubeTab(12);
        await new Promise(resolve => setTimeout(resolve, 60));

        const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        assert.deepEqual(result, { isTab: true, isYoutube: true, inInbox: true });
    });
});

describe('HookService batch fan-out', () => {
    let rootPath;
    let workspace;
    let service;
    let linkCalls;
    let hookRuns;

    const docs = {
        1: { id: 1, schema: 'data/schema/message/email', data: { from: 'boss@corp.tld', subject: 'urgent' } },
        2: { id: 2, schema: 'data/schema/message/email', data: { from: 'news@list.tld', subject: 'weekly' } },
    };

    beforeEach(() => {
        rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-batch-'));
        workspace = createWorkspace('workspace-batch', rootPath);
        fs.mkdirSync(workspace.hooksPath, { recursive: true });
        linkCalls = [];
        hookRuns = [];
        workspace.getContextTreeSelector = (p) => ({ type: 'context', path: p });
        workspace.link = async (id, opts) => linkCalls.push({ id, opts });
        workspace.get = async (id) => docs[id] || null;
        service = new HookService({ workspaceManager: { getWorkspace: async () => workspace } });
        service.trackWorkspace(workspace);
    });

    afterEach(() => {
        service.untrackWorkspace(workspace.id);
        fs.rmSync(rootPath, { recursive: true, force: true });
    });

    test('document.inserted.batch fans out to singular hooks + rules per doc', async () => {
        // singular JS hook file
        fs.writeFileSync(path.join(workspace.hooksPath, 'document.inserted.js'),
            'export default async (ctx) => { globalThis.__batchHookRuns.push(ctx.payload); };');
        globalThis.__batchHookRuns = hookRuns;
        // singular rule matching one of the two emails
        fs.writeFileSync(path.join(workspace.hooksPath, 'rules.json'), JSON.stringify({ rules: [{
            id: 'boss-mail',
            when: { event: 'document.inserted', schema: 'email', from: 'boss@corp.tld' },
            then: [{ action: 'link', paths: ['/work/urgent'] }],
        }] }));

        workspace.emit('document.inserted.batch', {
            ids: [1, 2], count: 2,
            directory: { type: 'directory', path: '/imap/a@b.c/inbox' },
            context: null, source: 'db',
        });
        await new Promise(resolve => setTimeout(resolve, 50));

        // hook ran once per document with the full doc + batch flag
        assert.equal(hookRuns.length, 2);
        assert.deepEqual(hookRuns.map((p) => p.document.id).sort(), [1, 2]);
        assert.ok(hookRuns.every((p) => p.batch === true && p.batchCount === 2));
        // rule matched only the boss email
        assert.equal(linkCalls.length, 1);
        assert.equal(linkCalls[0].id, 1);
        delete globalThis.__batchHookRuns;
    });

    test('fan-out inherits provenance from the batch payload', async () => {
        fs.writeFileSync(path.join(workspace.hooksPath, 'rules.json'), JSON.stringify({ rules: [{
            id: 'boss-mail-cascade',
            cascade: true,
            when: { event: 'document.inserted', schema: 'email', from: 'boss@corp.tld' },
            then: [{ action: 'link', paths: ['/work/urgent'] }],
        }] }));

        workspace.emit('document.inserted.batch', {
            ids: [1], count: 1, context: null, source: 'db',
            eventId: 'evt-batch-1', origin: 'hook', causedBy: 'evt-root', depth: 1,
        });
        await new Promise(resolve => setTimeout(resolve, 50));

        // cascade rule fired; the write it made carries depth+1 and causedBy
        // pointing at the batch event.
        assert.equal(linkCalls.length, 1);
        assert.deepEqual(linkCalls[0].opts.provenance, { origin: 'rule', causedBy: 'evt-batch-1', depth: 2 });
    });

    test('doc-less singular compat emission (batch:true) is skipped', async () => {
        fs.writeFileSync(path.join(workspace.hooksPath, 'document.inserted.js'),
            'export default async (ctx) => { globalThis.__batchCompatRuns.push(ctx.payload); };');
        const runs = [];
        globalThis.__batchCompatRuns = runs;

        workspace.emit('document.inserted', { ids: [1, 2], count: 2, batch: true, source: 'db' });
        await new Promise(resolve => setTimeout(resolve, 50));

        assert.equal(runs.length, 0);
        delete globalThis.__batchCompatRuns;
    });
});

describe('HookService provenance + cascade control', () => {
    let rootPath;
    let workspace;
    let service;
    let linkCalls;

    const tabDoc = (id) => ({ id, schema: 'data/schema/tab', data: { url: 'https://youtube.com/watch?v=x' } });
    const emitTab = (id, extra = {}) => workspace.emit('document.inserted', {
        id, document: tabDoc(id), context: { paths: ['/inbox'] }, source: 'db', ...extra,
    });
    const RULE = {
        id: 'yt',
        when: { event: 'document.inserted', schema: 'tab', url: { host: 'youtube.com' } },
        then: [{ action: 'link', paths: ['/media'] }],
    };

    beforeEach(() => {
        rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-prov-'));
        workspace = createWorkspace('workspace-prov', rootPath);
        fs.mkdirSync(workspace.hooksPath, { recursive: true });
        linkCalls = [];
        workspace.getContextTreeSelector = (p) => ({ type: 'context', path: p });
        workspace.link = async (id, opts) => linkCalls.push({ id, opts });
        service = new HookService({ workspaceManager: { getWorkspace: async () => workspace } });
        service.trackWorkspace(workspace);
    });

    afterEach(() => {
        service.untrackWorkspace(workspace.id);
        fs.rmSync(rootPath, { recursive: true, force: true });
        delete process.env.CANVAS_HOOKS_MAX_DEPTH;
    });

    const writeRules = (rules) =>
        fs.writeFileSync(path.join(workspace.hooksPath, 'rules.json'), JSON.stringify({ rules }));

    test('automated-origin event skips a plain rule', async () => {
        writeRules([RULE]);
        emitTab(1, { eventId: 'e1', origin: 'hook', causedBy: 'e0', depth: 1 });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 0);
    });

    test('automated-origin event runs a cascade:true rule and stamps provenance on its writes', async () => {
        writeRules([{ ...RULE, cascade: true }]);
        emitTab(2, { eventId: 'e2', origin: 'rule', causedBy: 'e0', depth: 1 });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 1);
        assert.deepEqual(linkCalls[0].opts.provenance, { origin: 'rule', causedBy: 'e2', depth: 2 });
    });

    test('user-origin event still runs plain rules; rule writes carry origin rule + depth 1', async () => {
        writeRules([RULE]);
        emitTab(3, { eventId: 'e3', origin: 'user' });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 1);
        assert.deepEqual(linkCalls[0].opts.provenance, { origin: 'rule', causedBy: 'e3', depth: 1 });
    });

    test('depth ceiling drops the event even for cascade rules', async () => {
        writeRules([{ ...RULE, cascade: true }]);
        emitTab(4, { eventId: 'e4', origin: 'rule', causedBy: 'e3', depth: 2 });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 0);
    });

    test('automated-origin event skips a plain JS hook but runs one exporting cascade=true', async () => {
        const hookDir = path.join(workspace.hooksPath, 'document.inserted');
        fs.mkdirSync(hookDir, { recursive: true });
        fs.writeFileSync(path.join(hookDir, 'plain.js'),
            'export default async () => { globalThis.__provPlain.push(1); };');
        fs.writeFileSync(path.join(hookDir, 'cascading.js'),
            'export const cascade = true;\nexport default async () => { globalThis.__provCascade.push(1); };');
        globalThis.__provPlain = [];
        globalThis.__provCascade = [];

        emitTab(5, { eventId: 'e5', origin: 'hook', causedBy: 'e0', depth: 1 });
        await new Promise(resolve => setTimeout(resolve, 60));

        assert.equal(globalThis.__provPlain.length, 0);
        assert.equal(globalThis.__provCascade.length, 1);
        delete globalThis.__provPlain;
        delete globalThis.__provCascade;
    });

    test('ctx.insert stamps origin/causedBy/depth on the write options', async () => {
        const putCalls = [];
        workspace.put = async (doc, options) => { putCalls.push({ doc, options }); return { id: 99 }; };
        const hookDir = path.join(workspace.hooksPath, 'document.inserted');
        fs.mkdirSync(hookDir, { recursive: true });
        fs.writeFileSync(path.join(hookDir, 'inserter.js'), `
export default async ({ insert }) => {
    await insert({ schema: 'data/schema/note', data: { title: 't', content: 'c' } }, { context: '/notes' });
};`);

        emitTab(6, { eventId: 'e6', origin: 'user' });
        await new Promise(resolve => setTimeout(resolve, 60));

        assert.equal(putCalls.length, 1);
        assert.equal(putCalls[0].options.context, '/notes');
        assert.deepEqual(putCalls[0].options.provenance, { origin: 'hook', causedBy: 'e6', depth: 1 });
    });

    test('runs are recorded in the run log (rule ok, hook error, cascade skip)', async () => {
        writeRules([RULE]);
        const hookDir = path.join(workspace.hooksPath, 'document.inserted');
        fs.mkdirSync(hookDir, { recursive: true });
        fs.writeFileSync(path.join(hookDir, 'thrower.js'),
            'export default async () => { throw new Error("kaboom"); };');

        emitTab(20, { eventId: 'e20' });
        // automated event → both handlers skip (rule matches but no cascade)
        emitTab(21, { eventId: 'e21', origin: 'hook', causedBy: 'e20', depth: 1 });
        await new Promise(resolve => setTimeout(resolve, 80));

        const runs = await service.runLogFor(workspace).query({ limit: 50 });
        const byKey = (handlerType, status) => runs.filter((r) => r.handlerType === handlerType && r.status === status);

        const ruleOk = byKey('rule', 'ok');
        assert.equal(ruleOk.length, 1);
        assert.equal(ruleOk[0].handler, 'yt');
        assert.equal(ruleOk[0].eventId, 'e20');
        assert.deepEqual(ruleOk[0].actions, [{ action: 'link', status: 'ok' }]);
        assert.deepEqual(ruleOk[0].replayEnvelope.payload.document, { id: 20, schema: 'data/schema/tab' });

        const hookErr = byKey('hook', 'error');
        assert.equal(hookErr.length, 1);
        assert.equal(hookErr[0].handler, path.join('document.inserted', 'thrower.js'));
        assert.match(hookErr[0].error, /kaboom/);

        const skips = runs.filter((r) => r.status === 'skipped');
        assert.equal(skips.length, 2); // rule + hook, both for e21
        assert.ok(skips.every((r) => r.eventId === 'e21' && /cascade/.test(r.skipReason)));
    });

    test('dedup keys on eventId: same eventId dedups, distinct eventIds for the same doc both run', async () => {
        writeRules([RULE]);
        emitTab(7, { eventId: 'same' });
        emitTab(7, { eventId: 'same' });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 1);

        emitTab(7, { eventId: 'other' });
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(linkCalls.length, 2);
    });

    test('runTargeted executes ONLY the targeted rule and records the trigger', async () => {
        writeRules([
            RULE,
            { id: 'other', when: { event: 'document.inserted', schema: 'tab' }, then: [{ action: 'link', paths: ['/elsewhere'] }] },
        ]);
        const payload = {
            id: 30, document: tabDoc(30), context: null, directory: null,
            eventId: 'bf-1', origin: 'backfill', depth: 0, backfill: true,
        };
        const outcome = await service.runTargeted(workspace, { ruleId: 'yt' }, 'document.inserted', payload, { trigger: 'backfill' });

        assert.equal(outcome.status, 'ok');
        assert.equal(linkCalls.length, 1); // 'other' matched too but must NOT fire
        assert.deepEqual(linkCalls[0].opts.context, { type: 'context', path: '/media' });
        assert.deepEqual(linkCalls[0].opts.provenance, { origin: 'rule', causedBy: 'bf-1', depth: 1 });

        const [record] = await service.runLogFor(workspace).query({ handler: 'yt' });
        assert.equal(record.trigger, 'backfill');
        assert.equal(record.origin, 'backfill');
        assert.equal(record.status, 'ok');
    });

    test('runTargeted records a skip when the matcher does not match', async () => {
        writeRules([{ ...RULE, when: { ...RULE.when, schema: 'email' } }]);
        const payload = { id: 31, document: tabDoc(31), eventId: 'bf-2', origin: 'backfill', depth: 0 };
        const outcome = await service.runTargeted(workspace, { ruleId: 'yt' }, 'document.inserted', payload);

        assert.equal(outcome.status, 'skipped');
        assert.equal(linkCalls.length, 0);
        const [record] = await service.runLogFor(workspace).query({ handler: 'yt' });
        assert.equal(record.status, 'skipped');
        assert.equal(record.skipReason, 'matcher did not match');
    });

    test('runTargeted runs a JS hook file and rejects paths escaping the hooks root', async () => {
        const hookDir = path.join(workspace.hooksPath, 'document.inserted');
        fs.mkdirSync(hookDir, { recursive: true });
        fs.writeFileSync(path.join(hookDir, 'probe.js'),
            'export default async ({ payload }) => { globalThis.__targetedRuns.push(payload.id); };');
        globalThis.__targetedRuns = [];

        const payload = { id: 32, document: tabDoc(32), eventId: 'rp-1', origin: 'replay', depth: 0 };
        const outcome = await service.runTargeted(
            workspace, { hookFile: 'document.inserted/probe.js' }, 'document.inserted', payload, { trigger: 'replay' },
        );
        assert.equal(outcome.status, 'ok');
        assert.deepEqual(globalThis.__targetedRuns, [32]);

        const [record] = await service.runLogFor(workspace).query({ handler: 'probe' });
        assert.equal(record.trigger, 'replay');

        await assert.rejects(
            service.runTargeted(workspace, { hookFile: '../../etc/passwd' }, 'document.inserted', payload),
            /escapes the hooks root/,
        );
        await assert.rejects(
            service.runTargeted(workspace, { ruleId: 'missing' }, 'document.inserted', payload),
            /not found/,
        );
        delete globalThis.__targetedRuns;
    });
});
