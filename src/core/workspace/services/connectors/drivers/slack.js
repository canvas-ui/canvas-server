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
 * Auth: `config.token` (xoxb-/xoxp-) with channels:read + channels:history
 * (+ groups:* for private channels).
 */

const API = 'https://slack.com/api';
const PAGE_LIMIT = 200;

export default class SlackDriver {
    static driver = 'slack';

    #address;
    #config;
    #logger;
    #teamId = null;

    constructor(address, config = {}, { logger } = {}) {
        this.#address = address;
        this.#config = config;
        this.#logger = logger || console;
    }

    async #call(method, params = {}) {
        if (!this.#config.token) throw new Error('Slack backend requires a token');
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) body.set(k, String(v));
        }
        const res = await fetch(`${API}/${method}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.#config.token}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.ok) {
            throw new Error(`Slack ${method}: ${json?.error || `HTTP ${res.status}`}`);
        }
        return json;
    }

    async test() {
        const auth = await this.#call('auth.test');
        this.#teamId = auth.team_id || null;
    }

    async #team() {
        if (!this.#teamId) await this.test();
        return this.#teamId || this.#address;
    }

    async listContainers() {
        const configured = (Array.isArray(this.#config.channels) ? this.#config.channels : [])
            .map((c) => String(c).trim()).filter(Boolean);

        const containers = [];
        let cursor;
        do {
            const page = await this.#call('conversations.list', {
                types: 'public_channel,private_channel',
                exclude_archived: true,
                limit: PAGE_LIMIT,
                cursor,
            });
            for (const channel of page.channels || []) {
                const wanted = configured.length === 0
                    ? channel.is_member
                    : (configured.includes(channel.name) || configured.includes(channel.id));
                if (wanted) containers.push({ id: channel.id, name: channel.name || channel.id });
            }
            cursor = page.response_metadata?.next_cursor || null;
        } while (cursor);
        return containers;
    }

    async fetchChanges(container, cursor) {
        const initialDays = Number(this.#config.initialSyncDays) || 30;
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
        }

        return { documents, nextCursor: maxTs, done: page.has_more !== true };
    }

    #toDocument(team, container, message) {
        return {
            schema: 'data/schema/message',
            data: {
                text: message.text || '',
                sender: { id: message.user, username: message.username },
                channel: { id: container.id, name: container.name, type: 'channel' },
                platform: 'slack',
                timestamp: new Date(parseFloat(message.ts) * 1000).toISOString(),
                threadId: message.thread_ts,
                reactions: message.reactions?.map((r) => ({ emoji: r.name, count: r.count })),
            },
            metadata: {
                remoteId: message.ts,
                remoteUpdatedAt: message.edited?.ts
                    ? new Date(parseFloat(message.edited.ts) * 1000).toISOString()
                    : undefined,
            },
            locations: [
                { url: `slack://${team}/${container.id}/${message.ts}`, metadata: { provenance: true } },
            ],
            containerSegment: container.name || container.id,
        };
    }
}
