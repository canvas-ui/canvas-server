import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
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

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-mail-'));
        puts = [];
    });

    afterEach(async () => {
        if (mail) await mail.stop();
        if (rootPath) await fs.remove(rootPath);
        mail = null; rootPath = null;
    });

    function createMail() {
        return new WorkspaceMailIndex({
            rootPath,
            dataPath: path.join(rootPath, 'data'),
            workspaceId: 'test-workspace',
            logger: { warn() {}, debug() {} },
            getIncomingTreeSelector: (spec) => spec,
            getDb: () => ({}),
            put: async (record, options) => {
                const id = record.id || `doc-${puts.length + 1}`;
                puts.push({ record: { ...record, id }, options });
                return id;
            },
        });
    }

    test('ingestMessage builds one Email doc with stored:// + imap:// locations', async () => {
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
        assert.ok(urls.some((u) => u.startsWith('stored://fs:data:email/')), `expected stored:// location, got ${urls}`);
        assert.ok(urls.some((u) => u.startsWith('imap://alice@example.com/INBOX;UID=5')), `expected imap:// location, got ${urls}`);
        assert.equal(record.checksumArray.length, 1);
        assert.match(String(options.directory), /imap\/alice/);
        // raw blob written to data/email/...
        const rawUrl = urls.find((u) => u.startsWith('stored://fs:data:email/'));
        const key = rawUrl.replace('stored://fs:data:email/', '');
        assert.ok(await fs.pathExists(path.join(rootPath, 'data', 'email', key)));
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
