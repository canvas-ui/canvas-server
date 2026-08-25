import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRuleFiles, loadRuleFile, matchRule, explainRule, executeRuleActions, interpolate, expandKeyTemplate, joinKey } from '../../../../../src/core/workspace/services/hook/rules.js';
import { classifyDocument } from '../../../../../src/core/workspace/lib/classifier.js';

const noopLogger = { debug: () => {}, warn: () => {} };

function tabPayload(url, contextPaths = ['/inbox']) {
    return {
        document: { id: 101, schema: 'data/schema/tab', data: { url, title: 't' } },
        context: { paths: contextPaths },
    };
}

function emailPayload(from, subject) {
    return {
        document: { id: 102, schema: 'data/schema/message/email', data: { from, subject } },
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
            document: { id: 103, schema: 'data/schema/file', metadata: { contentType: 'application/pdf' } },
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

    test('to matcher: any To/Cc recipient, string/array/object semantics', () => {
        const payload = {
            document: {
                id: 104, schema: 'data/schema/message/email',
                data: {
                    from: 'supplier@vendor.tld',
                    to: [{ address: 'Invoice@My-Company.tld', name: 'Invoices' }],
                    cc: ['faktury@my-company.tld'],
                    subject: 'Invoice 2026-042',
                },
            },
            context: { path: '/inbox' },
        };
        const c = classify(payload);
        const rule = (when) => ({ when: { event: 'document.inserted', ...when }, then: [] });
        assert.equal(matchRule(rule({ to: 'invoice@my-company.tld' }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ to: 'faktury@my-company.tld' }), 'document.inserted', c), true); // Cc counts
        assert.equal(matchRule(rule({ to: ['sales@', 'invoice@'] }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ to: 'nobody@my-company.tld' }), 'document.inserted', c), false);
        assert.equal(matchRule(rule({ to: { startsWith: 'invoice@' } }), 'document.inserted', c), true);
    });

    test('attachment matcher: true / mime pattern / { mime, filename }', () => {
        const withPdf = {
            document: {
                id: 105, schema: 'data/schema/message/email',
                data: {
                    from: 'supplier@vendor.tld',
                    to: ['invoice@my-company.tld'],
                    subject: 'Invoice',
                    attachments: [
                        { filename: 'logo.png', contentType: 'image/png' },
                        { filename: 'invoice-2026-042.pdf', contentType: 'application/pdf' },
                    ],
                },
            },
            context: { path: '/inbox' },
        };
        const c = classify(withPdf);
        const rule = (when) => ({ when: { event: 'document.inserted', ...when }, then: [] });
        assert.equal(matchRule(rule({ attachment: true }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ attachment: 'application/pdf' }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ attachment: '*' }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ attachment: ['text/csv', 'application/pdf'] }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ attachment: 'text/csv' }), 'document.inserted', c), false);
        assert.equal(matchRule(rule({ attachment: { mime: 'application/pdf', filename: 'invoice' } }), 'document.inserted', c), true);
        assert.equal(matchRule(rule({ attachment: { mime: 'application/pdf', filename: 'receipt' } }), 'document.inserted', c), false);

        // the full invoices use-case: to-alias AND pdf attachment
        const invoiceRule = {
            when: {
                event: 'document.inserted', schema: 'email',
                to: ['invoice@my-company.tld', 'faktury@my-company.tld'],
                attachment: 'application/pdf',
            },
            then: [],
        };
        assert.equal(matchRule(invoiceRule, 'document.inserted', c), true);

        const noAttachments = classify(emailPayload('supplier@vendor.tld', 'Invoice'));
        assert.equal(matchRule(rule({ attachment: true }), 'document.inserted', noAttachments), false);
        assert.equal(matchRule(rule({ attachment: 'application/pdf' }), 'document.inserted', noAttachments), false);
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
        const calls = { link: [], unlink: [], delete: [], destroy: [], persistBlob: [], agent: [], notify: [], emit: [], insert: [] };
        const workspace = {
            id: 'ws-1',
            name: 'test',
            rootPath: '/nonexistent/ws',
            homePath: '/nonexistent/ws/home',
            getContextTreeSelector: (p) => ({ type: 'context', path: p }),
            link: async (id, opts) => calls.link.push({ id, opts }),
            unlink: async (id, opts) => calls.unlink.push({ id, opts }),
            delete: async (id) => calls.delete.push({ id }),
            destroyDocument: async (doc) => { calls.destroy.push({ id: doc.id }); return { deleted: ['stored://x'], droppedRefs: [], docDeleted: true }; },
            persistBlob: async (buffer) => { calls.persistBlob.push({ size: buffer.length }); return { url: 'stored://workspace:data/abc', checksum: 'deadbeef', size: buffer.length }; },
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
        assert.equal(calls.insert[0].document.schema, 'data/schema/note');
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

    test('unlink action removes each path (dir: aware), doc survives', async () => {
        const payload = tabPayload('https://x.com');
        const { context, calls } = stubContext(payload);
        await executeRuleActions({
            id: 'r', when: {}, then: [{ action: 'unlink', paths: ['/inbox', 'dir:/staging'] }],
        }, context, noopLogger);

        assert.equal(calls.unlink.length, 2);
        assert.equal(calls.unlink[0].id, 101);
        assert.deepEqual(calls.unlink[0].opts.context, { type: 'context', path: '/inbox' });
        assert.equal(calls.unlink[1].opts.directory, '/staging');
        assert.equal(calls.delete.length, 0);
        assert.equal(calls.destroy.length, 0);
    });

    test('delete action purges from index only; destroy wipes backends too', async () => {
        const payload = emailPayload('spam@evil.com', 'buy now');
        const { context, calls } = stubContext(payload);
        await executeRuleActions({
            id: 'r', when: {}, then: [{ action: 'delete' }],
        }, context, noopLogger);
        assert.deepEqual(calls.delete, [{ id: 102 }]);
        assert.equal(calls.destroy.length, 0);

        await executeRuleActions({
            id: 'r2', when: {}, then: [{ action: 'destroy' }],
        }, context, noopLogger);
        assert.deepEqual(calls.destroy, [{ id: 102 }]);
        assert.equal(calls.delete.length, 1); // docDeleted:true -> no extra purge
    });

    test('destroy falls back to index purge when backend wipe incomplete', async () => {
        const payload = emailPayload('a@b.c', 's');
        const { context, calls } = stubContext(payload);
        context.workspace.destroyDocument = async (doc) => { calls.destroy.push({ id: doc.id }); return { deleted: [], droppedRefs: [], docDeleted: false }; };
        await executeRuleActions({
            id: 'r', when: {}, then: [{ action: 'destroy' }],
        }, context, noopLogger);
        assert.equal(calls.destroy.length, 1);
        assert.deepEqual(calls.delete, [{ id: 102 }]);
    });

    test('agent output.file backend:data persists blob and indexes File doc at insert path', async () => {
        const payload = emailPayload('boss@corp.com', 'weekly report');
        const { context, calls } = stubContext(payload);
        await executeRuleActions({
            id: 'r', when: {}, then: [{
                action: 'agent', slug: 'lucy', prompt: 'Summarize',
                output: { file: { path: 'reports/summary.txt', backend: 'data', insert: 'dir:/reports' } },
            }],
        }, context, noopLogger);

        assert.equal(calls.persistBlob.length, 1);
        assert.equal(calls.insert.length, 1);
        const doc = calls.insert[0].document;
        assert.equal(doc.schema, 'data/schema/file');
        assert.deepEqual(doc.checksumArray, ['sha256/deadbeef']);
        assert.deepEqual(doc.locations, [{ url: 'stored://workspace:data/abc' }]);
        assert.equal(doc.metadata.filename, 'summary.txt');
        assert.deepEqual(calls.insert[0].options, { context: null, directory: '/reports' });
    });

    test('agent output.file backend:home writes under home/ and rejects traversal', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-out-'));
        try {
            const payload = emailPayload('a@b.c', 'log me');
            const { context, calls } = stubContext(payload);
            context.workspace.homePath = dir;
            await executeRuleActions({
                id: 'r', when: {}, then: [{
                    action: 'agent', slug: 'lucy', prompt: 'p',
                    output: { file: { path: 'logs/agent.log', append: true } },
                }],
            }, context, noopLogger);
            assert.equal(fs.readFileSync(path.join(dir, 'logs', 'agent.log'), 'utf8'), 'ok\n');
            assert.equal(calls.insert.length, 0); // no insert requested

            const logged = [];
            await executeRuleActions({
                id: 'r2', when: {}, then: [{
                    action: 'agent', slug: 'lucy', prompt: 'p',
                    output: { file: { path: '../../etc/pwned' } },
                }],
            }, context, { debug: (m) => logged.push(m) });
            assert.ok(logged.some((m) => m.includes('outside home/')));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    test('script action with output captures stdout into the output pipeline', async () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-ws-'));
        try {
            fs.mkdirSync(path.join(ws, 'git', 'scripts'), { recursive: true });
            fs.writeFileSync(path.join(ws, 'git', 'scripts', 'echo.sh'), 'echo "script says hi"\n');
            const payload = tabPayload('https://x.com');
            const { context, calls } = stubContext(payload);
            context.workspace.rootPath = ws;
            await executeRuleActions({
                id: 'r', description: 'echo rule', when: {}, then: [{
                    action: 'script', path: 'scripts/echo.sh',
                    output: { note: { path: '/logs' }, notify: true },
                }],
            }, context, noopLogger);

            assert.equal(calls.insert.length, 1);
            assert.equal(calls.insert[0].document.data.content, 'script says hi');
            assert.equal(calls.insert[0].document.data.title, 'echo rule');
            assert.deepEqual(calls.notify, [{ message: 'script says hi', options: {} }]);
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    test('script gets sanitized env, the envelope on stdin and a var/tmp workdir (cleaned on success)', async () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-ws-'));
        try {
            fs.mkdirSync(path.join(ws, 'git', 'scripts'), { recursive: true });
            // Dump cwd, selected env and stdin as JSON on stdout.
            fs.writeFileSync(path.join(ws, 'git', 'scripts', 'probe.sh'), `
STDIN=$(cat)
echo "{\\"cwd\\":\\"$PWD\\",\\"event\\":\\"$CANVAS_EVENT\\",\\"eventId\\":\\"$CANVAS_EVENT_ID\\",\\"workspace\\":\\"$CANVAS_WORKSPACE\\",\\"workdir\\":\\"$CANVAS_WORK_DIR\\",\\"leak\\":\\"\${CANVAS_SECRET_PROBE:-none}\\",\\"stdin\\":$STDIN}"
`);
            process.env.CANVAS_SECRET_PROBE = 'leaky';
            const payload = { ...tabPayload('https://x.com'), eventId: 'evt-script-1' };
            const { context, calls } = stubContext(payload);
            context.workspace.rootPath = ws;
            await executeRuleActions({
                id: 'probe-rule', when: {}, then: [{
                    action: 'script', path: 'scripts/probe.sh',
                    output: { note: { path: '/logs', title: 't' } },
                }],
            }, context, noopLogger);

            assert.equal(calls.insert.length, 1);
            const probe = JSON.parse(calls.insert[0].document.data.content);
            const expectedWorkDir = path.join(ws, 'var/tmp', 'probe-rule', 'evt-script-1');
            assert.equal(probe.workdir, expectedWorkDir);
            // cwd == workdir (compare via suffix — $PWD may be a realpath)
            assert.ok(probe.cwd.endsWith(path.join('probe-rule', 'evt-script-1')));
            assert.equal(probe.event, 'document.inserted');
            assert.equal(probe.eventId, 'evt-script-1');
            assert.equal(probe.workspace, context.workspace.id);
            assert.equal(probe.leak, 'none'); // server env did NOT leak
            assert.equal(probe.stdin.event, 'document.inserted');
            assert.equal(probe.stdin.eventId, 'evt-script-1');
            assert.equal(probe.stdin.rule.id, 'probe-rule');
            assert.equal(probe.stdin.payload.document.schema, 'data/schema/tab');
            // clean exit → workdir removed (async cleanup; poll briefly)
            for (let i = 0; i < 20 && fs.existsSync(expectedWorkDir); i++) {
                await new Promise((r) => setTimeout(r, 25));
            }
            assert.equal(fs.existsSync(expectedWorkDir), false);
        } finally {
            delete process.env.CANVAS_SECRET_PROBE;
            fs.rmSync(ws, { recursive: true, force: true });
        }
    });

    test('script honors a custom timeout (long-running script killed, no output)', async () => {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-ws-'));
        try {
            fs.mkdirSync(path.join(ws, 'git', 'scripts'), { recursive: true });
            fs.writeFileSync(path.join(ws, 'git', 'scripts', 'slow.sh'), 'sleep 30\necho done\n');
            const payload = tabPayload('https://x.com');
            const { context, calls } = stubContext(payload);
            context.workspace.rootPath = ws;
            const t0 = Date.now();
            await executeRuleActions({
                id: 'slow', when: {}, then: [{
                    action: 'script', path: 'scripts/slow.sh', timeout: 1200,
                    output: { notify: true },
                }],
            }, context, noopLogger);
            assert.ok(Date.now() - t0 < 10_000, 'timeout did not kick in');
            assert.equal(calls.notify.length, 0); // no stdout captured
        } finally {
            fs.rmSync(ws, { recursive: true, force: true });
        }
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

    test('unknown and failing actions are logged, not thrown; per-action results returned', async () => {
        const payload = tabPayload('https://x.com');
        const { context, calls } = stubContext(payload);
        context.workspace.link = async () => { throw new Error('boom'); };
        const results = await executeRuleActions({
            id: 'r', when: {}, then: [
                { action: 'nope' },
                { action: 'link', paths: ['/a'] },
                { action: 'notify', message: 'still runs' },
            ],
        }, context, noopLogger);
        assert.equal(calls.notify.length, 1);
        assert.deepEqual(results, [
            { action: 'nope', status: 'skipped', error: 'unknown action' },
            { action: 'link', status: 'error', error: 'boom' },
            { action: 'notify', status: 'ok' },
        ]);
    });

    test('interpolate resolves nested paths, blanks missing ones', () => {
        assert.equal(interpolate('{{a.b}} {{a.missing}} {{c}}', { a: { b: 'x' }, c: 3 }), 'x  3');
        assert.equal(interpolate(42, {}), 42);
    });

    test('explainRule reports every check without short-circuiting', () => {
        const payload = tabPayload('https://youtube.com/watch?v=1');
        const c = classifyDocument(payload.document, payload);
        const rule = {
            id: 'yt',
            when: { event: 'document.inserted', schema: 'tab', url: { host: 'youtube.com' }, from: 'boss@', bogus: 1 },
            then: [],
        };
        const explained = explainRule(rule, 'document.inserted', c);
        assert.equal(explained.matched, false);
        assert.equal(explained.enabled, true);
        const byKey = Object.fromEntries(explained.checks.map((chk) => [chk.key, chk]));
        assert.equal(byKey.event.matched, true);
        assert.equal(byKey.schema.matched, true);
        assert.equal(byKey.url.matched, true);
        assert.equal(byKey.from.matched, false); // reported despite earlier passes
        assert.equal(byKey.bogus.matched, false);
        assert.equal(byKey.bogus.unknown, true);

        const matching = explainRule({ id: 'ok', when: { event: 'document.inserted', schema: 'tab' }, then: [] }, 'document.inserted', c);
        assert.equal(matching.matched, true);
        const disabled = explainRule({ id: 'off', enabled: false, when: { event: 'document.inserted' }, then: [] }, 'document.inserted', c);
        assert.equal(disabled.matched, false);
        assert.equal(disabled.enabled, false);
    });
});

describe('store action', () => {
    function filePayload(contextPaths, extra = {}) {
        return {
            document: {
                id: 301,
                schema: 'data/schema/file',
                data: { title: 'Pinterest: UI / mood board?' },
                metadata: { contentType: 'image/png', ...extra },
                locations: [{ url: 'stored://workspace:data/sha256-abc' }],
            },
            context: { paths: contextPaths },
        };
    }

    function storeContext(payload, eventName = 'document.linked') {
        const transfers = [];
        const workspace = {
            id: 'ws-1', name: 'test',
            documentByteEndpoints: async () => [{ backend: 'workspace:data', key: 'sha256-abc' }],
            transferDocumentBytes: async (doc, opts) => { transfers.push({ id: doc.id, ...opts }); return { ok: true, to: { url: `stored://${opts.to}/${opts.key}` } }; },
        };
        const context = { workspace, payload, eventName, classify: () => classify(payload) };
        return { context, transfers };
    }

    test('folder + recursive mirrors the sub-path below the matched prefix, name from mime', async () => {
        const payload = filePayload(['/projects/canvas/UI/mobile']);
        const { context, transfers } = storeContext(payload);
        await executeRuleActions({
            id: 'r', when: { path: '/projects/canvas/UI' },
            then: [{ action: 'store', to: 'workspace:home', folder: '/Projects/Canvas/UI/', recursive: true }],
        }, context, noopLogger);
        assert.equal(transfers.length, 1);
        assert.equal(transfers[0].to, 'workspace:home');
        assert.equal(transfers[0].mode, 'move');
        assert.equal(transfers[0].key, 'Projects/Canvas/UI/mobile/sha256-abc.png');
    });

    test('folder without recursive files flat; key template names the file', async () => {
        const payload = filePayload(['/projects/canvas/UI/mobile'], { filename: 'hero.PNG' });
        const { context, transfers } = storeContext(payload);
        await executeRuleActions({
            id: 'r', when: { path: '/projects/canvas/UI' },
            then: [{ action: 'store', to: 'workspace:home', folder: 'Projects/Canvas/UI', key: '{{title}}{{ext}}', mode: 'copy' }],
        }, context, noopLogger);
        assert.equal(transfers[0].mode, 'copy');
        assert.equal(transfers[0].key, 'Projects/Canvas/UI/Pinterest- UI - mood board.png');
    });

    test('legacy key-only rules keep their exact key; no key keeps the source key', async () => {
        const payload = filePayload(['/x']);
        const { context, transfers } = storeContext(payload);
        await executeRuleActions({
            id: 'r', when: {},
            then: [
                { action: 'store', to: 'workspace:home', key: 'Fotky/{{YYYY}}/{{basename}}{{ext}}' },
                { action: 'store', to: 'nas' },
            ],
        }, context, noopLogger);
        assert.match(transfers[0].key, /^Fotky\/\d{4}\/sha256-abc\.png$/);
        assert.equal(transfers[1].key, undefined);
    });

    test('skips when the bytes are not on the `from` backend', async () => {
        const payload = filePayload(['/x']);
        const { context, transfers } = storeContext(payload);
        await executeRuleActions({
            id: 'r', when: {}, then: [{ action: 'store', to: 'workspace:home', from: 'nas', folder: 'a' }],
        }, context, noopLogger);
        assert.equal(transfers.length, 0);
    });

    test('joinKey / expandKeyTemplate never escape the root', () => {
        assert.equal(joinKey('/a//b/', '../../etc', './c', 'x.txt'), 'a/b/etc/c/x.txt');
        assert.equal(joinKey('', null, undefined), '');
        const key = expandKeyTemplate('{{title}}{{ext}}', { doc: { id: 1, data: { title: '../../evil' }, metadata: { contentType: 'image/jpeg' } }, sourceKey: 'k' });
        assert.equal(key, 'evil.jpg');
    });
});
