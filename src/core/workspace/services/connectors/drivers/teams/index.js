'use strict';

/**
 * MS Teams channel-messages driver (Microsoft Graph) — one backend per tenant
 * (address = tenant label). `config.teams` lists team ids; their channels are
 * discovered. Messages map to data/schema/message (platform 'teams').
 *
 * Cursor per team/channel: max `lastModifiedDateTime` seen; incremental fetch
 * filters on it (Graph channel messages support $filter on
 * lastModifiedDateTime with $orderby asc). Edits bump the timestamp, come
 * back, and upsert via the identity checksum.
 *
 * Auth: app-only client-credentials grant (`tenantId`, `clientId`,
 * `clientSecret`) against graph.microsoft.com/.default — requires
 * admin-consented ChannelMessage.Read.All + Team.ReadBasic.All +
 * Channel.ReadBasic.All. Plain fetch, no Graph SDK.
 */

import BaseConnector from '../../BaseConnector.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const PAGE_SIZE = 50;

export default class TeamsConnector extends BaseConnector {
    static driver = 'teams';
    static label = 'Microsoft Teams';
    static icon = 'mdi:microsoft-teams';
    static blurb = 'Channel messages via Microsoft Graph (app-only).';
    static provenanceScheme = 'msteams';
    static supports = { prune: false, create: false, update: false, delete: false };

    static configFields = [
        { key: 'address', label: 'Tenant label', placeholder: 'acme', required: true },
        { key: 'tenantId', label: 'Tenant id', required: true },
        { key: 'clientId', label: 'Application (client) id', required: true },
        { key: 'clientSecret', label: 'Client secret', secret: true, required: true },
        { key: 'teams', label: 'Team ids (one per line)', list: true, required: true },
        { key: 'initialSyncDays', label: 'Initial history (days)', type: 'number', placeholder: '30' },
    ];

    #accessToken = null;
    #tokenExpiresAt = 0;


    async #token() {
        if (this.#accessToken && Date.now() < this.#tokenExpiresAt - 60_000) return this.#accessToken;
        const { tenantId, clientId, clientSecret } = this.config;
        if (!tenantId || !clientId || !clientSecret) {
            throw new Error('teams backend requires tenantId, clientId and clientSecret');
        }
        const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                scope: 'https://graph.microsoft.com/.default',
                grant_type: 'client_credentials',
            }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.access_token) {
            throw new Error(`teams token failed: ${json?.error_description?.split('\n')[0] || json?.error || `HTTP ${res.status}`}`);
        }
        this.#accessToken = json.access_token;
        this.#tokenExpiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
        return this.#accessToken;
    }

    async #get(url) {
        const token = await this.#token();
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`graph ${res.status}: ${body.slice(0, 200)}`);
        }
        return res.json();
    }

    async test() {
        await this.#token();
        const teams = this.#teams();
        if (teams.length) await this.#get(`${GRAPH}/teams/${encodeURIComponent(teams[0])}`);
    }

    #teams() {
        return (Array.isArray(this.config.teams) ? this.config.teams : [])
            .map((t) => String(t).trim()).filter(Boolean);
    }

    // Containers are team/channel pairs, discovered per configured team.
    async listContainers() {
        const containers = [];
        for (const teamId of this.#teams()) {
            const team = await this.#get(`${GRAPH}/teams/${encodeURIComponent(teamId)}`).catch(() => null);
            const teamName = team?.displayName || teamId;
            const page = await this.#get(`${GRAPH}/teams/${encodeURIComponent(teamId)}/channels`);
            for (const channel of page.value || []) {
                containers.push({
                    id: `${teamId}/${channel.id}`,
                    name: `${teamName}/${channel.displayName || channel.id}`,
                    teamId,
                    channelId: channel.id,
                    teamName,
                    channelName: channel.displayName || channel.id,
                });
            }
        }
        return containers;
    }

    async fetchChanges(container, cursor) {
        const { teamId, channelId } = container;
        const initialDays = Number(this.config.initialSyncDays) || 30;
        const floor = cursor || new Date(Date.now() - initialDays * 86_400_000).toISOString();

        const url = new URL(`${GRAPH}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages`);
        url.searchParams.set('$top', String(PAGE_SIZE));
        // Graph supports lastModifiedDateTime filtering on channel messages.
        url.searchParams.set('$filter', `lastModifiedDateTime gt ${floor}`);
        url.searchParams.set('$orderby', 'lastModifiedDateTime asc');

        const page = await this.#get(url.toString());

        const documents = [];
        let maxModified = cursor || null;
        for (const message of page.value || []) {
            if (message.messageType && message.messageType !== 'message') continue;
            if (message.deletedDateTime) continue;
            documents.push(this.#toDocument(container, message));
            const modified = message.lastModifiedDateTime || message.createdDateTime;
            if (modified && (!maxModified || modified > maxModified)) maxModified = modified;
        }

        return { documents, nextCursor: maxModified, done: !page['@odata.nextLink'] };
    }

    #toDocument(container, message) {
        const isHtml = message.body?.contentType === 'html';
        return this.document({
            schema: 'data/schema/message',
            data: {
                text: isHtml ? this.#stripHtml(message.body?.content) : (message.body?.content || ''),
                html: isHtml ? message.body?.content : undefined,
                sender: {
                    id: message.from?.user?.id,
                    displayName: message.from?.user?.displayName,
                },
                channel: { id: container.channelId, name: container.channelName, type: 'channel' },
                platform: 'teams',
                timestamp: message.createdDateTime || new Date().toISOString(),
                editedAt: message.lastEditedDateTime || undefined,
                threadId: message.replyToId || undefined,
                mentions: message.mentions?.map((m) => ({
                    id: m.mentioned?.user?.id,
                    name: m.mentioned?.user?.displayName,
                })),
            },
            metadata: {
                remoteId: message.id,
                remoteUpdatedAt: message.lastModifiedDateTime,
            },
            provenanceUrl: this.provenance(container.teamId, container.channelId, message.id),
            links: [message.webUrl],
            containerSegment: `${container.teamName}/${container.channelName}`,
        });
    }

    // Teams bodies are HTML; the Message schema's text field wants plain text.
    #stripHtml(html) {
        return String(html || '')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<br\s*\/?>(\n)?/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .trim();
    }
}
