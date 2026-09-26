import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import { EventEmitter } from 'node:events';
import * as baileys from '@whiskeysockets/baileys';
import nodemailer from 'nodemailer';
import { normalizeSmtp, prepareEmail, deliverEmail } from '../../../src/core/workspace/services/messages/email.js';
import { sendOnce, readSendReceipt } from '../../../src/core/workspace/services/messages/outbox.js';
import { sendWorkspaceMessage } from '../../../src/core/workspace/services/messages/index.js';
import SlackConnector from '../../../src/core/workspace/services/connectors/drivers/slack/index.js';
import WhatsAppConnector from '../../../src/core/workspace/services/connectors/drivers/whatsapp/index.js';
import { openAuthState } from '../../../src/core/workspace/services/connectors/drivers/whatsapp/auth.js';

async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-messages-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}
const config = { smtp: normalizeSmtp({ enabled: true, host: 'smtp.example.test', from: 'Me <me@example.test>' }) };

test('email Reply all uses Reply-To, excludes self and Bcc, and preserves RFC thread headers', async () => {
    const parent = { data: { from: { address: 'sender@example.test' }, replyTo: [{ address: 'reply@example.test' }],
        to: [{ address: 'me@example.test' }, { address: 'colleague@example.test' }], cc: [{ address: 'cc@example.test' }],
        bcc: [{ address: 'secret@example.test' }], subject: 'Original', messageId: '<parent@example.test>', references: ['<root@example.test>'] } };
    const prepared = await prepareEmail(config, { text: 'My reply', replyAll: true }, parent);
    const parsed = await simpleParser(prepared.raw);
    assert.deepEqual(prepared.envelope.to, ['reply@example.test', 'colleague@example.test', 'cc@example.test']);
    assert.equal(parsed.inReplyTo, '<parent@example.test>');
    assert.deepEqual(parsed.references, ['<root@example.test>', '<parent@example.test>']);
    assert.equal(parsed.subject, 'Re: Original');
    assert.equal(parsed.text.trim(), 'My reply');
    assert.equal(parsed.bcc, undefined);
});

test('new email Bcc is in the envelope but not the archived MIME', async () => {
    const prepared = await prepareEmail(config, { to: ['A <a@example.test>, b@example.test'], bcc: ['hidden@example.test'], subject: 'Hello', text: 'Body' });
    assert.deepEqual(prepared.envelope.to, ['a@example.test', 'b@example.test', 'hidden@example.test']);
    assert.equal((await simpleParser(prepared.raw)).bcc, undefined);
    await assert.rejects(prepareEmail({ ...config, readOnly: true }, { text: 'No' }), /not enabled/);
    assert.equal(normalizeSmtp({ password: '' }, { password: 'kept' }).password, 'kept');
});

test('send fence survives retries and concurrent requests without duplicate delivery', async (t) => {
    const root = await temporary(t);
    let calls = 0, finish;
    const id = 'stable-request-000001', input = { text: 'Hello', principal: 'owner' };
    const pending = sendOnce(root, id, input, () => { calls++; return new Promise((resolve) => { finish = resolve; }); });
    // Wait for the callback, not a timing assumption about filesystem writes.
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await sendOnce(root, id, input, () => assert.fail('duplicate'))).status, 'unknown');
    finish({ status: 'accepted', providerMessageId: 'remote-1' });
    await pending;
    assert.equal((await sendOnce(root, id, input, () => assert.fail('duplicate'))).providerMessageId, 'remote-1');
    assert.equal(calls, 1);
    assert.equal((await readSendReceipt(root, id, 'owner')).status, 'accepted');
    await assert.rejects(readSendReceipt(root, id, 'other'), /not found/);
    await assert.rejects(sendOnce(root, id, { ...input, text: 'Different' }, () => {}), /different content/);
});

test('ambiguous provider failure is durable and never automatically retried', async (t) => {
    const root = await temporary(t);
    const id = 'stable-request-000002';
    assert.equal((await sendOnce(root, id, {}, () => { throw new Error('timeout'); })).status, 'unknown');
    assert.equal((await sendOnce(root, id, {}, () => assert.fail('duplicate'))).status, 'unknown');
});

test('agent sending needs account permission and a visible reply; mirror failure preserves acceptance', async (t) => {
    const varPath = await temporary(t);
    const parent = { id: 12, data: { platform: 'slack', channel: { id: 'C1' } }, metadata: { connector: 'slack:acme' } };
    const workspace = { varPath, get: async () => parent, list: async () => [] };
    const entry = { config: { allowAgentSend: false }, instance: {
        prepareMessage: async () => ({}), sendMessage: async () => ({ status: 'accepted', providerMessageId: 'p1' }),
    } };
    const connectors = { messageAccount: () => entry, storeSentMessage: async () => { throw new Error('index offline'); } };
    const input = { requestId: 'stable-request-000003', replyToDocumentId: 12, text: 'Hello' };
    await assert.rejects(sendWorkspaceMessage(workspace, null, connectors, input, { isAgent: true }), /not enabled/);
    entry.config.allowAgentSend = true;
    await assert.rejects(sendWorkspaceMessage(workspace, null, connectors, input, { isAgent: true, basePath: '/work' }), /outside/);
    workspace.list = async () => [12];
    const result = await sendWorkspaceMessage(workspace, null, connectors, input, { id: 'agent', isAgent: true, basePath: '/work' });
    assert.equal(result.status, 'accepted');
    assert.match(result.warnings[0], /local copy/);
    await assert.rejects(sendWorkspaceMessage(workspace, null, connectors, { ...input, target: 'C2' }), /change conversations/);
});

test('Slack sends through configured conversations, with replies anchored to the root', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        const params = Object.fromEntries(options.body);
        calls.push({ url, params });
        const payload = url.endsWith('conversations.list') ? { channels: [{ id: 'C1', name: 'general', is_member: true }] }
            : url.endsWith('auth.test') ? { team_id: 'T1' }
                : { ts: '123.45', message: { user: 'U1' } };
        return { ok: true, json: async () => ({ ok: true, ...payload }) };
    });
    const slack = new SlackConnector('acme', { token: 'test', readOnly: false, sendEnabled: true, channels: ['C1'] });
    const prepared = await slack.prepareMessage({ text: 'Reply' }, { data: { channel: { id: 'C1' }, threadId: '100.1' }, metadata: { remoteId: '102.2' } });
    const sent = await slack.sendMessage(prepared, 'stable-request-000004');
    assert.equal(calls.at(-1).params.thread_ts, '100.1');
    assert.equal(calls.at(-1).params.channel, 'C1');
    assert.equal(sent.document.parentProvenanceUrl, 'slack://T1/C1/100.1');
    await assert.rejects(slack.prepareMessage({ target: 'C2', text: 'No' }), /configured/);
});

test('WhatsApp pairs, ingests only selected chats, and sends quoted replies', { timeout: 10000 }, async (t) => {
    const rootPath = await temporary(t);
    const ev = new EventEmitter();
    let accept, lastSend;
    const received = new Promise((resolve) => { accept = resolve; });
    const socket = { ev, user: { id: 'me@s.whatsapp.net' }, end() {}, async sendMessage(jid, content, options) {
        lastSend = { jid, content, options };
        return { key: { id: 'out', remoteJid: jid, fromMe: true }, message: { conversation: content.text }, messageTimestamp: 1700000000 };
    } };
    const driver = new WhatsAppConnector('personal', { chats: ['chat@s.whatsapp.net'], readOnly: false, sendEnabled: true }, {
        rootPath, onDocument: async (container, document) => accept({ container, document }), library: { ...baileys, default: () => socket },
    });
    t.after(() => driver.stop());
    await driver.listContainers();
    ev.emit('connection.update', { connection: 'open' });
    ev.emit('messages.upsert', { messages: [{ key: { id: 'in', remoteJid: 'chat@s.whatsapp.net' }, message: { conversation: 'Incoming' }, messageTimestamp: 1700000000 }] });
    const { document } = await received;
    assert.equal(document.data.text, 'Incoming');
    const prepared = await driver.prepareMessage({ text: 'Answer' }, document);
    const sent = await driver.sendMessage(prepared);
    assert.equal(lastSend.options.quoted.key.id, 'in');
    assert.equal(sent.status, 'accepted');
    await assert.rejects(driver.prepareMessage({ target: 'unselected@s.whatsapp.net', text: 'No' }), /configured/);
});

test('WhatsApp credentials and Signal keys survive restart with restricted file permissions', async (t) => {
    const root = await temporary(t);
    const auth = await openAuthState(root, baileys);
    auth.state.creds.me = { id: 'me@s.whatsapp.net' };
    await Promise.all([auth.saveCreds(), auth.state.keys.set({ session: { peer: Buffer.from('key') } })]);
    const reloaded = await openAuthState(root, baileys);
    assert.equal(reloaded.state.creds.me.id, 'me@s.whatsapp.net');
    assert.deepEqual((await reloaded.state.keys.get('session', ['peer'])).peer, Buffer.from('key'));
    assert.equal((await fs.stat(path.join(root, 'session.json'))).mode & 0o777, 0o600);
});


test('SMTP requires TLS and reports partial acceptance without losing rejected recipients', async (t) => {
    let options, envelope, closed = false;
    t.mock.method(nodemailer, 'createTransport', (config) => {
        options = config;
        return { sendMail: async (mail) => { envelope = mail.envelope; return { accepted: ['a@example.test'], rejected: ['b@example.test'] }; }, close: () => { closed = true; } };
    });
    const prepared = { raw: Buffer.from('test'), messageId: '<id@example.test>', envelope: { from: 'me@example.test', to: ['a@example.test', 'b@example.test'] } };
    const result = await deliverEmail(config, prepared);
    assert.equal(options.requireTLS, true);
    assert.deepEqual(envelope, prepared.envelope);
    assert.deepEqual(result.rejected, ['b@example.test']);
    assert.equal(result.status, 'accepted');
    assert.equal(closed, true);
});
