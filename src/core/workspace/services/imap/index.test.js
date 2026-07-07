import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { WorkspaceMailIndex } from './index.js';

const RAW_EMAIL = Buffer.from([
    'From: alice@example.com',
    'To: bob@example.com',
    'Subject: Hello',
    'Message-ID: <test-1@example.com>',
    'Date: Mon, 16 Jun 2025 10:00:00 +0000',
    '',
    'body text',
    '',
].join('\r\n'), 'utf8');

describe('WorkspaceMailIndex', () => {
    let rootPath;
    let mail;
    let puts;
    let blobs;
    let lockCalls;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-mail-'));
        puts = [];
        blobs = [];
        lockCalls = [];
    });

    afterEach(async () => {
        if (mail) await mail.stop();
        if (rootPath) await fs.remove(rootPath);
        mail = null; rootPath = null;
    });

    function createMail(overrides = {}) {
        return new WorkspaceMailIndex({
            rootPath,
            workspaceId: 'test-workspace',
            logger: { warn() {}, debug() {} },
            getBackendsTreeSelector: (spec) => spec,
            getDb: () => ({}),
            lockBackendNode: (nodePath, holder) => { lockCalls.push({ nodePath, holder, locked: true }); },
            unlockBackendNode: (nodePath, holder) => { lockCalls.push({ nodePath, holder, locked: false }); },
            put: async (record, options) => {
                const id = record.id || `doc-${puts.length + 1}`;
                puts.push({ record: { ...record, id }, options });
                return id;
            },
            // Stand-in for the blob indexer's persistBlob (content-addressable).
            persistBlob: async (buffer) => {
                const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
                blobs.push({ checksum, size: buffer.length });
                return { url: `stored://workspace:data/${checksum.slice(0, 2)}/${checksum.slice(2, 4)}/${checksum}`, key: checksum, checksum, size: buffer.length };
            },
            ...overrides,
        });
    }

    function rawEmail({ subject = 'Hello', id = 'test-1', attachment = false } = {}) {
        const lines = [
            'From: alice@example.com',
            'To: bob@example.com',
            `Subject: ${subject}`,
            `Message-ID: <${id}@example.com>`,
            'Date: Mon, 16 Jun 2025 10:00:00 +0000',
        ];
        if (attachment) {
            lines.push(
                'MIME-Version: 1.0',
                'Content-Type: multipart/mixed; boundary="B"',
                '', '--B',
                'Content-Type: text/plain', '', 'body text', '',
                '--B',
                'Content-Type: application/octet-stream; name="a.bin"',
                'Content-Disposition: attachment; filename="a.bin"',
                'Content-Transfer-Encoding: base64', '',
                Buffer.from(`payload-${id}`).toString('base64'),
                '--B--', '',
            );
        } else {
            lines.push('', 'body text', '');
        }
        return Buffer.from(lines.join('\r\n'), 'utf8');
    }

    test('ingestMessage builds one Email doc with workspace:data + imap:// locations', async () => {
        mail = createMail();
        await mail.start();

        const emitted = [];
        mail.on('object:add', (p) => emitted.push(p));

        const docId = await mail.ingestMessage({ raw: RAW_EMAIL, account: 'alice@example.com', folder: 'INBOX', uid: 5 });

        assert.equal(puts.length, 1);
        const { record, options } = puts[0];
        assert.equal(record.id, docId);
        assert.equal(record.schema, 'data/abstraction/email');
        const urls = record.locations.map((l) => l.url);
        assert.ok(urls.some((u) => u.startsWith('stored://workspace:data/')), `expected stored://workspace:data location, got ${urls}`);
        assert.ok(urls.some((u) => u.startsWith('imap://alice@example.com/INBOX;UID=5')), `expected imap:// location, got ${urls}`);
        assert.equal(record.checksumArray.length, 1);
        // filed into the directory /.backends path, NOT the context root
        assert.equal(options.context, null);
        assert.equal(String(options.directory), '/.backends/imap/alice@example.com/inbox');
        // raw blob persisted into the content-addressable store
        assert.equal(blobs.length, 1);
        assert.equal(record.checksumArray[0], `sha256/${blobs[0].checksum}`);
        // uniform service event contract
        assert.equal(emitted.length, 1);
        assert.equal(emitted[0].kind, 'message');
        assert.equal(emitted[0].docId, docId);
    });

    test('imap:// location describe/destroy reference-drop when no credentials are wired', async () => {
        mail = createMail();
        await mail.start();
        const url = 'imap://nobody@example.com/INBOX;UID=9';
        assert.deepEqual(await mail.describeImapLocation(url), {
            url, scheme: 'imap', backend: 'nobody@example.com', kind: 'imap', deletable: false,
        });
        assert.deepEqual(await mail.destroyImapLocation(url), { ok: false });
    });

    test('imap:// location is deletable once credentials exist in stored.json', async () => {
        mail = createMail();
        await mail.start();
        await mail.writeStoredConfig({ backends: { 'imap:acct': {
            driver: 'imap', account: 'carol@example.com', user: 'carol@example.com',
            password: 'secret', host: 'imap.example.com', port: 993, enabled: false,
        } } });
        // describe constructs a backend from creds (no network) → deletable via EXPUNGE capability
        const d = await mail.describeImapLocation('imap://carol@example.com/INBOX;UID=3');
        assert.equal(d.deletable, true);
    });

    test('readOnly mailbox is never deletable (describe + destroy reference-drop)', async () => {
        mail = createMail();
        await mail.start();
        await mail.writeStoredConfig({ backends: { 'imap:acct': {
            driver: 'imap', account: 'carol@example.com', user: 'carol@example.com',
            password: 'secret', host: 'imap.example.com', port: 993, enabled: false,
            readOnly: true,
        } } });
        const d = await mail.describeImapLocation('imap://carol@example.com/INBOX;UID=3');
        assert.equal(d.deletable, false);
        assert.deepEqual(await mail.destroyImapLocation('imap://carol@example.com/INBOX;UID=3'), { ok: false });
    });

    test('saveMailbox locks the account node; removeMailbox unlocks it', async () => {
        mail = createMail();
        await mail.start();
        // Host is unreachable — sync fails but registration (and the lock) happen.
        const saved = await mail.saveMailbox({
            id: 'acct', user: 'dave@example.com', password: 'secret',
            host: '127.0.0.1', port: 1, tls: false, pollInterval: 60000,
        });
        assert.equal(saved.id, 'acct');
        assert.ok(lockCalls.some((c) => c.locked && c.nodePath === '/.backends/imap/dave@example.com' && c.holder === 'imap:acct'));

        await mail.removeMailbox('acct');
        assert.ok(lockCalls.some((c) => !c.locked && c.nodePath === '/.backends/imap/dave@example.com' && c.holder === 'imap:acct'));
    });

    test('ingestBatch groups by feature signature into putMany calls (single put untouched)', async () => {
        const putManyCalls = [];
        mail = createMail({
            putMany: async (records, options) => {
                putManyCalls.push({ records, options });
                return records.map((_, i) => `batch-${putManyCalls.length}-${i}`);
            },
        });
        await mail.start();

        const emitted = [];
        mail.on('object:add', (p) => emitted.push(p));

        const docIds = await mail.ingestBatch([
            { kind: 'message', raw: rawEmail({ id: 'm1' }), account: 'alice@example.com', folder: 'INBOX', uid: 1 },
            { kind: 'message', raw: rawEmail({ id: 'm2' }), account: 'alice@example.com', folder: 'INBOX', uid: 2 },
            { kind: 'message', raw: rawEmail({ id: 'm3', attachment: true }), account: 'alice@example.com', folder: 'INBOX', uid: 3 },
        ]);

        // no per-message puts; two putMany groups (plain vs +attachment feature)
        assert.equal(puts.length, 0);
        assert.equal(putManyCalls.length, 2);
        assert.equal(docIds.length, 3);
        const sizes = putManyCalls.map((c) => c.records.length).sort();
        assert.deepEqual(sizes, [1, 2]);
        for (const call of putManyCalls) {
            assert.equal(call.options.context, null);
            assert.equal(String(call.options.directory), '/.backends/imap/alice@example.com/inbox');
            assert.ok(call.options.features.includes('data/backend/imap/alice@example.com'));
        }
        const attachmentGroup = putManyCalls.find((c) => c.records.length === 1);
        assert.ok(attachmentGroup.options.features.some((f) => f.includes('attachment')), `expected attachment feature, got ${attachmentGroup.options.features}`);
        assert.equal(emitted.length, 3);
        assert.ok(emitted.every((e) => e.kind === 'message' && e.docId));
    });

    test('ingestBatch falls back to sequential single puts without a putMany seam', async () => {
        mail = createMail();
        await mail.start();
        const docIds = await mail.ingestBatch([
            { kind: 'message', raw: rawEmail({ id: 's1' }), account: 'alice@example.com', folder: 'INBOX', uid: 1 },
            { kind: 'message', raw: rawEmail({ id: 's2' }), account: 'alice@example.com', folder: 'INBOX', uid: 2 },
        ]);
        assert.equal(puts.length, 2);
        assert.equal(docIds.length, 2);
    });

    test('saveMailbox resets the UID cursor only when initialSyncDays widens', async () => {
        mail = createMail();
        await mail.start();
        const base = {
            id: 'acct', user: 'dave@example.com', password: 'secret',
            host: '127.0.0.1', port: 1, tls: false, pollInterval: 60000, initialSyncDays: 180,
        };
        await mail.saveMailbox(base);
        await mail.patchStoredBackend('imap:acct', { lastUid: 42, lastSyncAt: '2026-01-01T00:00:00.000Z' });

        // same window → cursor untouched
        await mail.saveMailbox({ ...base, password: '' });
        assert.equal((await mail.readStoredConfig()).backends['imap:acct'].lastUid, 42);

        // narrower window → cursor untouched
        await mail.saveMailbox({ ...base, password: '', initialSyncDays: 30 });
        assert.equal((await mail.readStoredConfig()).backends['imap:acct'].lastUid, 42);

        // wider window → full re-sync wanted, cursor reset
        await mail.saveMailbox({ ...base, password: '', initialSyncDays: 365 });
        assert.equal((await mail.readStoredConfig()).backends['imap:acct'].lastUid, 0);
    });

    test('saveMailbox returns immediately with a syncing runtime status', async () => {
        mail = createMail();
        await mail.start();
        const saved = await mail.saveMailbox({
            id: 'acct', user: 'dave@example.com', password: 'secret',
            host: '127.0.0.1', port: 1, tls: false, pollInterval: 60000,
        });
        // The (unreachable) sync runs in the background; the save response
        // already reflects it.
        assert.equal(saved.runtime.syncing, true);
        assert.equal(saved.runtime.status, 'syncing');
    });

    test('stored.json read/write roundtrip + empty getImapStatus', async () => {
        mail = createMail();
        await mail.start();

        assert.deepEqual(await mail.readStoredConfig(), { backends: {} });
        const status = await mail.getImapStatus();
        assert.equal(status.mailboxCount, 0);
        assert.equal(status.activeMailboxCount, 0);

        await mail.writeStoredConfig({ backends: { 'imap:acct': { driver: 'imap', user: 'u', enabled: false } } });
        assert.equal((await mail.readStoredConfig()).backends['imap:acct'].user, 'u');
    });
});
