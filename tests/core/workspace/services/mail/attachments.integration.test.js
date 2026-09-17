import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';

import Workspace from '../../../../../src/core/workspace/Workspace.js';
import {
    WORKSPACE_LAYOUTS,
    workspaceInternals,
    workspaceServices,
} from '../../../../../src/core/workspace/lib/constants.js';

/**
 * Email attachments against a REAL workspace (synapsd + stored), not the seam
 * fakes in index.test.js: the unit test proves the mail service calls put/link/
 * assertRelation with the right arguments, this one proves the edge actually
 * lands in the edge plane and reads back as the object card's Synapses tab
 * reads it (`listDocumentRelations`).
 */

const rawEmail = ({ id = 'm1', attachments = [] } = {}) => {
    const lines = [
        'From: alice@example.com',
        'To: bob@example.com',
        `Subject: attachment test ${id}`,
        `Message-ID: <${id}@example.com>`,
        'Date: Mon, 16 Jun 2025 10:00:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="B"',
        '', '--B',
        'Content-Type: text/plain', '', 'body text', '',
    ];
    for (const { filename, payload, mime = 'application/octet-stream' } of attachments) {
        lines.push(
            '--B',
            `Content-Type: ${mime}; name="${filename}"`,
            `Content-Disposition: attachment; filename="${filename}"`,
            'Content-Transfer-Encoding: base64', '',
            Buffer.from(payload).toString('base64'),
        );
    }
    lines.push('--B--', '');
    return Buffer.from(lines.join('\r\n'), 'utf8');
};

describe('email attachments as File docs + includes edges', () => {
    let root;
    let store;
    let ws;

    before(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-mail-attach-'));
        store = {
            id: 'ws-mail-1',
            name: 'ws-mail',
            owner: 'user-1',
            layout: WORKSPACE_LAYOUTS.FULL,
            internals: { ...workspaceInternals(WORKSPACE_LAYOUTS.FULL) },
            services: workspaceServices(WORKSPACE_LAYOUTS.FULL),
        };
        ws = new Workspace({
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
    });

    after(async () => {
        await ws?.stop().catch(() => {});
        if (root) { await fs.remove(root); }
    });

    test('one message with two attachments → two File docs, two includes edges', async () => {
        const emailId = await ws.ingestEmailMessage({
            kind: 'message',
            raw: rawEmail({ id: 'a1', attachments: [
                { filename: 'report.pdf', payload: 'pdf-bytes-a1', mime: 'application/pdf' },
                { filename: 'logo.png', payload: 'png-bytes-a1', mime: 'image/png' },
            ] }),
            account: 'alice@example.com', folder: 'INBOX', uid: 1,
        });
        assert.ok(emailId, 'email document was written');

        const { outgoing } = ws.listDocumentRelations(emailId);
        const includes = outgoing.filter((edge) => edge.p === 'includes');
        assert.equal(includes.length, 2, `expected two includes edges, got ${JSON.stringify(outgoing)}`);

        const files = await Promise.all(includes.map((edge) => ws.get(edge.to)));
        assert.ok(files.every((doc) => doc?.schema === 'data/schema/file'), 'every includes target is a File doc');
        const names = files.map((doc) => doc.locations[0]?.metadata?.filename).sort();
        assert.deepEqual(names, ['logo.png', 'report.pdf']);
        // provenance is the edge, never an imap:// location (which would make a
        // destroy of the attachment EXPUNGE the whole message)
        assert.ok(files.every((doc) => doc.locations.every((l) => !String(l.url).startsWith('imap://'))));

        // filed under the mailbox folder's attachments node
        for (const doc of files) {
            const paths = await ws.listDocumentPlacements(doc.id).catch(() => []);
            const flat = JSON.stringify(paths);
            assert.ok(flat.includes('/imap/alice@example.com/inbox/attachments'), `expected attachments placement, got ${flat}`);
        }

        // and the reverse axis answers "which messages carried this blob"
        const { incoming } = ws.listDocumentRelations(files[0].id);
        assert.ok(incoming.some((edge) => edge.p === 'includes' && edge.from === emailId));
    });

    test('the same blob in a second message dedupes to one File doc with two incoming edges', async () => {
        const shared = { filename: 'shared.pdf', payload: 'identical-bytes', mime: 'application/pdf' };

        const firstId = await ws.ingestEmailMessage({
            kind: 'message',
            raw: rawEmail({ id: 'd1', attachments: [shared] }),
            account: 'alice@example.com', folder: 'INBOX', uid: 2,
        });
        const secondId = await ws.ingestEmailMessage({
            kind: 'message',
            raw: rawEmail({ id: 'd2', attachments: [shared] }),
            account: 'alice@example.com', folder: 'Archive', uid: 3,
        });
        assert.notEqual(firstId, secondId);

        const first = ws.listDocumentRelations(firstId).outgoing.filter((e) => e.p === 'includes');
        const second = ws.listDocumentRelations(secondId).outgoing.filter((e) => e.p === 'includes');
        assert.equal(first.length, 1);
        assert.equal(second.length, 1);
        // content addressing: one document for one blob
        assert.equal(first[0].to, second[0].to);

        const { incoming } = ws.listDocumentRelations(first[0].to);
        const senders = incoming.filter((e) => e.p === 'includes').map((e) => e.from).sort();
        assert.deepEqual(senders, [firstId, secondId].sort());

        // and it is reachable from BOTH mailbox folders
        const placements = JSON.stringify(await ws.listDocumentPlacements(first[0].to));
        assert.ok(placements.includes('/imap/alice@example.com/inbox/attachments'), placements);
        assert.ok(placements.includes('/imap/alice@example.com/archive/attachments'), placements);
    });

    test('re-ingesting the same message is idempotent (no duplicate edges)', async () => {
        const raw = rawEmail({ id: 'i1', attachments: [{ filename: 'once.txt', payload: 'once-bytes' }] });
        const payload = { kind: 'message', raw, account: 'alice@example.com', folder: 'INBOX', uid: 4 };

        const firstId = await ws.ingestEmailMessage(payload);
        const secondId = await ws.ingestEmailMessage(payload);
        assert.equal(firstId, secondId, 'checksum dedup resolves to the same email doc');

        const includes = ws.listDocumentRelations(firstId).outgoing.filter((e) => e.p === 'includes');
        assert.equal(includes.length, 1);
    });
});
