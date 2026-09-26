'use strict';

/**
 * Slack channels driver — one backend per Slack workspace (address = team
 * label). `config.channels` lists channel names or ids; empty means every
 * public channel the token has joined.
 *
 * Cursor per channel: the latest message `ts` seen. `conversations.history`
 * with `oldest=<cursor>` (exclusive via inclusive:false default) returns only
 * newer messages. Edits move a message's content but not its ts — the
 * identity checksum (slack://team/channel/ts) upserts them when they surface
 * again (e.g. inside the initialSyncDays window of a resync).
 *
 * Threads: `conversations.history` returns thread ROOTS only (plus broadcast
 * replies, which carry a subtype and are skipped). For every root whose
 * `latest_reply` is newer than the cursor the driver pulls
 * `conversations.replies` and emits each reply with `parentProvenanceUrl`
 * pointing at the root (`thread_ts` IS the root's ts), so the runtime asserts
 * `replies-to`. Known gap: a reply to a root older than the cursor is not
 * seen, because the root no longer surfaces in history.
 *
 * Auth: `config.token` (xoxb-/xoxp-) with channels:read + channels:history
 * (+ groups:* for private channels).
 */

import crypto from 'node:crypto';
import BaseConnector from '../../BaseConnector.js';

const API = 'https://slack.com/api';
const PAGE_LIMIT = 200;

export default class SlackConnector extends BaseConnector {
    static driver = 'slack';
    static label = 'Slack';
    static icon = 'mdi:slack';
    static blurb = 'Messages from the channels you list.';
    static provenanceScheme = 'slack';
    static supports = { prune: false, create: false, update: false, delete: false };

    static configFields = [
        { key: 'address', label: 'Workspace label', placeholder: 'acme', required: true },
        { key: 'token', label: 'Bot / user token', placeholder: 'xoxb-…', secret: true, required: true },
        { key: 'channels', label: 'Channels (one per line)', placeholder: 'general', list: true, required: true },
        { key: 'initialSyncDays', label: 'Initial history (days)', type: 'number', placeholder: '30' },
    ];

    #teamId = null;


    async #call(method, params = {}) {
        if (!this.config.token) throw new Error('Slack backend requires a token');
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) body.set(k, String(v));
        }
        const res = await fetch(`${API}/${method}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.config.token}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
            signal: AbortSignal.timeout(20000),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok) {
            throw new Error(`Slack ${method}: ${json?.error || `HTTP ${res.status}`}`);
        }
        return json;
    }

    async prepareMessage(input, parent) {
        if (this.config.sendEnabled !== true || !this.canWrite) throw new Error('Sending is disabled for this Slack account');
        const target = parent?.data?.channel?.id || input.target;
        const containers = await this.listContainers();
        const container = containers.find((c) => c.id === target || c.name === target);
        if (!container) throw new Error('Select a configured Slack conversation');
        const team = await this.#team();
        const thread = parent ? (parent.data.threadId || parent.metadata?.remoteId) : undefined;
        if (parent && !thread) throw new Error('Reply target has no Slack thread identifier');
        return { container, team, thread, text: input.text };
    }

    async sendMessage(prepared, requestId) {
        const { container, team, thread, text } = prepared;
        const hex = crypto.createHash('sha256').update(requestId).digest('hex');
        const clientId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
        const response = await this.#call('chat.postMessage', {
            channel: container.id, text, thread_ts: thread, client_msg_id: clientId,
            unfurl_links: false, unfurl_media: false,
        });
        const message = { ...response.message, text, ts: response.ts, thread_ts: thread };
        return {
            status: 'accepted', providerMessageId: response.ts,
            document: this.#toDocument(team, container, message), container,
        };
    }

    containerIdFromProvenance(url) {
        const match = String(url).match(/^slack:\/\/[^/]+\/([^/]+)\//);
        return match?.[1] || null;
    }

    async test() {
        const auth = await this.#call('auth.test');
        this.#teamId = auth.team_id || null;
    }

    async #team() {
        if (!this.#teamId) await this.test();
        return this.#teamId || this.address;
    }

    async listContainers() {
        const configured = (Array.isArray(this.config.channels) ? this.config.channels : [])
            .map((c) => String(c).trim()).filter(Boolean);

        const containers = [];
        let cursor;
        do {
            const page = await this.#call('conversations.list', {
                types: this.config.directMessages === true ? 'public_channel,private_channel,im,mpim' : 'public_channel,private_channel',
                exclude_archived: true,
                limit: PAGE_LIMIT,
                cursor,
            });
            for (const channel of page.channels || []) {
                const wanted = configured.length === 0
                    ? (channel.is_member || (this.config.directMessages === true && (channel.is_im || channel.is_mpim)))
                    : (configured.includes(channel.name) || configured.includes(channel.id));
                if (wanted) containers.push({ id: channel.id, name: channel.name || channel.id });
            }
            cursor = page.response_metadata?.next_cursor || null;
        } while (cursor);
        return containers;
    }

    async fetchChanges(container, cursor) {
        const initialDays = Number(this.config.initialSyncDays) || 30;
        const oldest = cursor || String((Date.now() - initialDays * 86_400_000) / 1000);

        const page = await this.#call('conversations.history', {
            channel: container.id,
            oldest,
            inclusive: false,
            limit: PAGE_LIMIT,
        });

        const team = await this.#team();
        const documents = [];
        let maxTs = cursor || null;
        // history returns newest-first; ingest oldest-first so a mid-page
        // failure leaves the cursor at the last landed message.
        for (const message of (page.messages || []).reverse()) {
            if (message.type !== 'message' || message.subtype) continue;
            documents.push(this.#toDocument(team, container, message));
            if (!maxTs || parseFloat(message.ts) > parseFloat(maxTs)) maxTs = message.ts;

            // Root first, then its replies: the runtime resolves the parent by
            // checksum at ingest, so order within the page is what makes the
            // `replies-to` edge land on the first pass.
            if (this.#hasNewReplies(message, cursor)) {
                documents.push(...await this.#fetchReplies(team, container, message));
            }
        }

        return { documents, nextCursor: maxTs, done: page.has_more !== true };
    }

    #hasNewReplies(message, cursor) {
        if (!(message.reply_count > 0)) return false;
        if (!cursor) return true;
        return parseFloat(message.latest_reply || '0') > parseFloat(cursor);
    }

    async #fetchReplies(team, container, root) {
        const documents = [];
        let cursor;
        do {
            const page = await this.#call('conversations.replies', {
                channel: container.id,
                ts: root.ts,
                limit: PAGE_LIMIT,
                cursor,
            });
            for (const reply of page.messages || []) {
                // The root itself comes back as the first element.
                if (reply.ts === root.ts || reply.type !== 'message') continue;
                if (reply.subtype && reply.subtype !== 'thread_broadcast') continue;
                documents.push(this.#toDocument(team, container, reply, { root }));
            }
            cursor = page.response_metadata?.next_cursor || null;
        } while (cursor);
        return documents;
    }

    #toDocument(team, container, message, { root = null } = {}) {
        // A reply's thread_ts is the ROOT's ts (Slack threads are one level).
        const isReply = Boolean(message.thread_ts && message.thread_ts !== message.ts);
        return this.document({
            schema: 'data/schema/message',
            data: {
                text: message.text || '',
                sender: { id: message.user, username: message.username },
                channel: { id: container.id, name: container.name, type: isReply ? 'thread' : 'channel' },
                platform: 'slack',
                timestamp: new Date(parseFloat(message.ts) * 1000).toISOString(),
                threadId: message.thread_ts,
                parentMessageId: isReply ? message.thread_ts : undefined,
                replyCount: message.reply_count ?? undefined,
                reactions: message.reactions?.map((r) => ({ emoji: r.name, count: r.count })),
            },
            metadata: {
                remoteId: message.ts,
                remoteUpdatedAt: message.edited?.ts
                    ? new Date(parseFloat(message.edited.ts) * 1000).toISOString()
                    : undefined,
            },
            provenanceUrl: this.provenance(team, container.id, message.ts),
            parentProvenanceUrl: isReply ? this.provenance(team, container.id, root?.ts || message.thread_ts) : null,
            containerSegment: container.name || container.id,
        });
    }
}
