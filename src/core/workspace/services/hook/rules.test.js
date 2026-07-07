import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRuleFiles, loadRuleFile, matchRule, executeRuleActions, interpolate } from './rules.js';
import { classifyDocument } from '../../lib/classifier.js';

const noopLogger = { debug: () => {} };

function tabPayload(url, contextPaths = ['/inbox']) {
    return {
        document: { id: 101, schema: 'data/abstraction/tab', data: { url, title: 't' } },
        context: { paths: contextPaths },
    };
}

function emailPayload(from, subject) {
    return {
        document: { id: 102, schema: 'data/abstraction/email', data: { from, subject } },
        context: { path: '/inbox' },
    };
}

function classify(payload) {
    return classifyDocument(payload.document, payload);
}

describe('rule matching', () => {
    test('event is required and must match (string or array)', () => {
        const c = classify(tabPayload('https://youtube.com/watch?v=1'));
        assert.equal(matchRule({ when: {}, then: [] }, 'document.inserted', c), false);
        assert.equal(matchRule({ when: { event: 'document.inserted' }, then: [] }, 'document.inserted', c), true);
        assert.equal(matchRule({ when: { event: ['document.inserted', 'document.updated'] }, then: [] }, 'document.updated', c), true);
        assert.equal(matchRule({ when: { event: 'document.removed' }, then: [] }, 'document.inserted', c), false);
    });

    test('when keys AND together, array values OR', () => {
        const c = classify(emailPayload('boss@corp.com', 'URGENT: prod down'));
        const rule = (when) => ({ when: { event: 'document.inserted', ...when }, then: [] });
        assert.equal(matchRule(rule({ schema: 'email', from: 'boss@corp.com' }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ schema: 'email', from: 'other@corp.com' }), 'document.inserted', c), false);
        assert.equal(matchRule(rule({ from: ['x@y.z', 'boss@corp.com'] }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ subject: 'urgent' }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ subject: { startsWith: 'urgent' } }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ subject: { equals: 'urgent' } }), 'document.inserted', c), false);
        assert.equal(matchRule(rule({ subject: { regex: '^URGENT:' } }), 'document.inserted', c), true);
    });

    test('url matchers: substring, host, prefix, regex', () => {
        const c = classify(tabPayload('https://www.youtube.com/watch?v=abc'));
        const rule = (url) => ({ when: { event: 'document.inserted', url }, then: [] });
        assert.equal(matchRule(rule('youtube.com/watch'), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ host: 'youtube.com' }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ host: 'vimeo.com' }), 'document.inserted', c), false);
        assert.equal(matchRule(rule({ prefix: 'https://www.youtube.com/' }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ regex: 'watch\\?v=' }), 'document.inserted', c), true);
    });

    test('path and mime matchers', () => {
        const filePayload = {
            document: { id: 103, schema: 'data/abstraction/file', metadata: { contentType: 'application/pdf' } },
            context: { paths: ['/to-sort/docs'] },
        };
        const c = classify(filePayload);
        const rule = (when) => ({ when: { event: 'document.inserted', ...when }, then: [] });
        assert.equal(matchRule(rule({ path: '/to-sort' }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ path: '/projects' }), 'document.inserted', c), false);
        assert.equal(matchRule(rule({ mime: 'application/pdf' }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ mime: 'image/*' }), 'document.inserted', c), false);
    });

    test('disabled rule never matches', () => {
        const c = classify(tabPayload('https://example.com'));
        assert.equal(matchRule({ enabled: false, when: { event: 'document.inserted' }, then: [] }, 'document.inserted', c), false);
    });
});

describe('rule loading', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-rules-')); });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('resolveRuleFiles: rules.json + rules/*.json sorted, _ disabled', () => {
        fs.writeFileSync(path.join(dir, 'rules.json'), '{"rules":[]}');
        fs.mkdirSync(path.join(dir, 'rules'));
        fs.writeFileSync(path.join(dir, 'rules', 'b.json'), '{"rules":[]}');
        fs.writeFileSync(path.join(dir, 'rules', 'a.json'), '{"rules":[]}');
        fs.writeFileSync(path.join(dir, 'rules', '_off.json'), '{"rules":[]}');
        fs.writeFileSync(path.join(dir, 'rules', 'not-json.js'), '');

        const files = resolveRuleFiles(dir);
        assert.deepEqual(files.map((f) => path.relative(dir, f)),
            ['rules.json', 'rules/a.json', 'rules/b.json']);
    });

    test('malformed JSON yields empty list, valid rules filtered by shape', () => {
        const bad = path.join(dir, 'rules.json');
        fs.writeFileSync(bad, '{nope');
        assert.deepEqual(loadRuleFile(bad, new Map(), noopLogger), []);

        fs.writeFileSync(bad, JSON.stringify({
            rules: [
                { id: 'ok', when: { event: 'document.inserted' }, then: [] },
                { id: 'no-then', when: { event: 'x' } },
                'garbage',
            ],
        }));
        const rules = loadRuleFile(bad, new Map(), noopLogger);
        assert.equal(rules.length, 1);
        assert.equal(rules[0].id, 'ok');
    });

    test('mtime cache: hit until file changes', () => {
        const file = path.join(dir, 'rules.json');
        fs.writeFileSync(file, JSON.stringify({ rules: [{ id: 'v1', when: { event: 'e' }, then: [] }] }));
        const cache = new Map();

        const first = loadRuleFile(file, cache, noopLogger);
        assert.equal(first[0].id, 'v1');
        assert.equal(loadRuleFile(file, cache, noopLogger), first); // same array = cache hit

        fs.writeFileSync(file, JSON.stringify({ rules: [{ id: 'v2', when: { event: 'e' }, then: [] }] }));
        const past = new Date(Date.now() + 5000);
        fs.utimesSync(file, past, past); // force distinct mtime
        assert.equal(loadRuleFile(file, cache, noopLogger)[0].id, 'v2');
    });
});

describe('rule actions', () => {
    function stubContext(payload) {
        const calls = { link: [], agent: [], notify: [], emit: [], insert: [] };
        const workspace = {
            id: 'ws-1',
            name: 'test',
            rootPath: '/nonexistent/ws',
            getContextTreeSelector: (p) => ({ type: 'context', path: p }),
            link: async (id, opts) => calls.link.push({ id, opts }),
        };
        const context = {
            workspace,
            payload,
            eventName: 'document.inserted',
            agent: async (slug, prompt) => { calls.agent.push({ slug, prompt }); return 'ok'; },
            notify: async (message, options) => calls.notify.push({ message, options }),
            emit: async (event, p) => calls.emit.push({ event, p }),
            insert: async (document, options) => { calls.insert.push({ document, options }); return { id: 999, ...document }; },
        };
        return { context, calls };
    }

    test('link action links each path with emitEvent:false', async () => {
        const payload = tabPayload('https://youtube.com/watch?v=1');
        const { context, calls } = stubContext(payload);
        await executeRuleActions({
            id: 'r', when: {}, then: [{ action: 'link', paths: ['/media/youtube', '/to-watch'], tags: ['custom/video'] }],
        }, context, noopLogger);

        assert.equal(calls.link.length, 2);
        assert.equal(calls.link[0].id, 101);
        assert.deepEqual(calls.link[0].opts.context, { type: 'context', path: '/media/youtube' });
        assert.deepEqual(calls.link[0].opts.features, ['custom/video']);
        assert.equal(calls.link[0].opts.emitEvent, false);
    });

    test('tag action re-links on the payload context paths', async () => {
        const payload = tabPayload('https://x.com', ['/inbox', '/work']);
        const { context, calls } = stubContext(payload);
        await executeRuleActions({
            id: 'r', when: {}, then: [{ action: 'tag', tags: ['custom/urgent'] }],
        }, context, noopLogger);

        assert.equal(calls.link.length, 1);
        assert.deepEqual(calls.link[0].opts.context, ['/inbox', '/work']);
        assert.deepEqual(calls.link[0].opts.features, ['custom/urgent']);
        assert.equal(calls.link[0].opts.emitEvent, false);
    });

    test('agent and notify actions interpolate templates', async () => {
        const payload = emailPayload('boss@corp.com', 'prod down');
        const { context, calls } = stubContext(payload);
        await executeRuleActions({
            id: 'r', when: {}, then: [
                { action: 'agent', slug: 'lucy', prompt: 'Check email {{doc.id}}: {{doc.data.subject}}' },
                { action: 'notify', message: 'mail from {{doc.data.from}} missing {{doc.data.nope}}!' },
            ],
        }, context, noopLogger);

        assert.deepEqual(calls.agent, [{ slug: 'lucy', prompt: 'Check email 102: prod down' }]);
        assert.deepEqual(calls.notify, [{ message: 'mail from boss@corp.com missing !', options: {} }]);
    });

    test('link action routes dir:-prefixed paths to the directory tree', async () => {
        const payload = tabPayload('https://x.com');
        const { context, calls } = stubContext(payload);
        await executeRuleActions({
            id: 'r', when: {}, then: [{ action: 'link', paths: ['dir:/projects/dc', 'ctx:/work', '/plain'] }],
        }, context, noopLogger);

        assert.equal(calls.link.length, 3);
        assert.equal(calls.link[0].opts.directory, '/projects/dc');
        assert.equal(calls.link[0].opts.context, undefined);
        assert.deepEqual(calls.link[1].opts.context, { type: 'context', path: '/work' });
        assert.deepEqual(calls.link[2].opts.context, { type: 'context', path: '/plain' });
    });

    test('agent action output saves the reply as a note and notifies', async () => {
        const payload = emailPayload('boss@corp.com', 'DC migration');
        const { context, calls } = stubContext(payload);
        await executeRuleActions({
            id: 'r', description: 'DC mail summarizer', when: {}, then: [{
                action: 'agent', slug: 'lucy', prompt: 'Summarize {{doc.data.subject}}',
                output: { note: { path: '/work/summaries', title: 'Summary: {{doc.data.subject}}' }, notify: true },
            }],
        }, context, noopLogger);

        assert.equal(calls.agent.length, 1);
        assert.equal(calls.insert.length, 1);
        assert.equal(calls.insert[0].document.schema, 'data/abstraction/note');
        assert.equal(calls.insert[0].document.data.title, 'Summary: DC migration');
        assert.equal(calls.insert[0].document.data.content, 'ok');
        assert.deepEqual(calls.insert[0].options, { context: '/work/summaries' });
        assert.deepEqual(calls.notify, [{ message: 'ok', options: {} }]);
    });

    test('agent action without output leaves the reply alone', async () => {
        const payload = emailPayload('a@b.c', 's');
        const { context, calls } = stubContext(payload);
        await executeRuleActions({
            id: 'r', when: {}, then: [{ action: 'agent', slug: 'lucy', prompt: 'p' }],
        }, context, noopLogger);
        assert.equal(calls.insert.length, 0);
        assert.equal(calls.notify.length, 0);
    });

    test('script action refuses paths outside git/', async () => {
        const payload = tabPayload('https://x.com');
        const { context } = stubContext(payload);
        const logged = [];
        await executeRuleActions({
            id: 'r', when: {}, then: [{ action: 'script', path: '../../etc/passwd' }],
        }, context, { debug: (m) => logged.push(m) });
        assert.ok(logged.some((m) => m.includes('outside git/')));
    });

    test('unknown and failing actions are logged, not thrown', async () => {
        const payload = tabPayload('https://x.com');
        const { context, calls } = stubContext(payload);
        context.workspace.link = async () => { throw new Error('boom'); };
        await assert.doesNotReject(executeRuleActions({
            id: 'r', when: {}, then: [
                { action: 'nope' },
                { action: 'link', paths: ['/a'] },
                { action: 'notify', message: 'still runs' },
            ],
        }, context, noopLogger));
        assert.equal(calls.notify.length, 1);
    });

    test('interpolate resolves nested paths, blanks missing ones', () => {
        assert.equal(interpolate('{{a.b}} {{a.missing}} {{c}}', { a: { b: 'x' }, c: 3 }), 'x  3');
        assert.equal(interpolate(42, {}), 42);
    });
});
