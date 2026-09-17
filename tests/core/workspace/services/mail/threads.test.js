import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { WorkspaceMailIndex } from '../../../../../src/core/workspace/services/mail/index.js';

/**
 * Email threads: `replies-to` to the immediate parent, resolved through the
 * alias keys the mail service puts into checksumArray (Message-ID lookup and
 * a parent->replies prefix). Stubbed db/checksum index, so what is under test
 * is the ORDER-INDEPENDENCE: parent first, reply first, and the References
 * fallback when the direct parent never arrives.
 */

function rawEmail({ id, inReplyTo = null, references = [], subject = 'Hello' }) {
    const lines = [
        'From: alice@example.com',
        'To: bob@example.com',
        `Subject: ${subject}`,
        `Message-ID: <${id}@example.com>`,
        ...(inReplyTo ? [`In-Reply-To: <${inReplyTo}@example.com>`] : []),
        ...(references.length ? [`References: ${references.map((r) => `<${r}@example.com>`).join(' ')}`] : []),
        'Date: Mon, 16 Jun 2025 10:00:00 +0000',
        '',
        `body of ${id}`,
        '',
    ];
    return Buffer.from(lines.join('\r\n'), 'utf8');
}

describe('WorkspaceMailIndex threads', () => {
    let rootPath;
    let mail;
    let relations;
    let inherited;
    let checksums; // key -> doc id (every checksumArray entry, like synapsd)
    let docs;

    beforeEach(async () => {
        rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-mail-threads-'));
        relations = [];
        inherited = [];
        checksums = new Map();
        docs = new Map();
        mail = new WorkspaceMailIndex({
            rootPath,
            workspaceId: 'test-workspace',
            logger: { warn(...a) { throw new Error(`unexpected warn: ${JSON.stringify(a)}`); }, debug() {} },
            getBackendsTreeSelector: (spec) => spec,
            getDb: () => ({
                getByChecksumString: async (checksum) => docs.get(checksums.get(checksum)) || null,
                checksumIndex: {
                    checksumStringToId: async (key) => checksums.get(key) || null,
                    list: async (prefix) => [...checksums.keys()].filter((k) => k.startsWith(prefix)),
                },
            }),
            assertRelation: async (fromId, p, toId) => { relations.push([fromId, p, toId]); return true; },
            inheritThreadMemberships: async (replyId, parentId) => { inherited.push([replyId, parentId]); return 1; },
            put: async (record) => {
                const id = record.id || docs.size + 1;
                docs.set(id, { ...record, id });
                for (const key of record.checksumArray || []) checksums.set(key, id);
                return id;
            },
            persistBlob: async (buffer) => {
                const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
                return { url: `stored://workspace:data/${checksum}`, key: checksum, checksum, size: buffer.length };
            },
        });
        await mail.start();
    });

    afterEach(async () => {
        await mail.stop();
        await fs.remove(rootPath);
    });

    const ingest = (raw, uid) => mail.ingestMessage({ raw, account: 'alice@example.com', folder: 'INBOX', uid });

    test('a reply carries both alias keys; a root only the Message-ID key', async () => {
        const rootId = await ingest(rawEmail({ id: 'r' }), 1);
        const replyId = await ingest(rawEmail({ id: 'a', inReplyTo: 'r' }), 2);

        assert.deepEqual(docs.get(rootId).checksumArray.slice(1), [WorkspaceMailIndex.messageIdKey('<r@example.com>')]);
        assert.deepEqual(docs.get(replyId).checksumArray.slice(1), [
            WorkspaceMailIndex.messageIdKey('a@example.com'),
            WorkspaceMailIndex.parentKey('<r@example.com>', '<a@example.com>'),
        ]);
    });

    test('parent first: the reply asserts replies-to and inherits the parent placement', async () => {
        const rootId = await ingest(rawEmail({ id: 'r' }), 1);
        const replyId = await ingest(rawEmail({ id: 'a', inReplyTo: 'r' }), 2);

        assert.deepEqual(relations, [[replyId, 'replies-to', rootId]]);
        assert.deepEqual(inherited, [[replyId, rootId]]);
    });

    test('reply first: the parent draws the edge when it lands, without inheriting from the reply', async () => {
        const replyId = await ingest(rawEmail({ id: 'a', inReplyTo: 'r' }), 1);
        assert.deepEqual(relations, []);

        const rootId = await ingest(rawEmail({ id: 'r' }), 2);
        assert.deepEqual(relations, [[replyId, 'replies-to', rootId]]);
        assert.deepEqual(inherited, []);
    });

    test('a chain links each reply to its immediate parent, not the root', async () => {
        const rootId = await ingest(rawEmail({ id: 'r' }), 1);
        const aId = await ingest(rawEmail({ id: 'a', inReplyTo: 'r', references: ['r'] }), 2);
        const bId = await ingest(rawEmail({ id: 'b', inReplyTo: 'a', references: ['r', 'a'] }), 3);

        assert.deepEqual(relations, [[aId, 'replies-to', rootId], [bId, 'replies-to', aId]]);
    });

    test('a missing direct parent falls back to the nearest indexed References ancestor', async () => {
        const rootId = await ingest(rawEmail({ id: 'r' }), 1);
        // 'x' (someone else's reply) never reaches this mailbox.
        const bId = await ingest(rawEmail({ id: 'b', inReplyTo: 'x', references: ['r', 'x'] }), 2);

        assert.deepEqual(relations, [[bId, 'replies-to', rootId]]);
    });

    test('batch ingest resolves a parent that lands in the same batch', async () => {
        const ids = await mail.ingestBatch([
            { kind: 'message', raw: rawEmail({ id: 'a', inReplyTo: 'r' }), account: 'alice@example.com', folder: 'INBOX', uid: 1 },
            { kind: 'message', raw: rawEmail({ id: 'r' }), account: 'alice@example.com', folder: 'INBOX', uid: 2 },
        ]);
        const [aId, rId] = ids;
        assert.deepEqual(relations, [[aId, 'replies-to', rId]]);
    });
});
