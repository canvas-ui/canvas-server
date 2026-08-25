'use strict';

/**
 * Google Calendar driver — one backend per Google account (address = account
 * email/label). `config.calendars` lists calendar ids ('primary', an email, or
 * a long group id); defaults to ['primary'].
 *
 * Cursor per calendar: Google's `nextSyncToken` — true incremental sync
 * (changed AND cancelled instances come back). A 410 GONE invalidates the
 * token; we restart from a `timeMin` window. Cancelled instances are skipped
 * (v1 keeps no tombstones — see docs/connectors.md).
 *
 * Auth: OAuth refresh-token grant — `config.clientId`, `config.clientSecret`,
 * `config.refreshToken` from an offline-access consent. Access token cached
 * until expiry. Plain fetch, no googleapis dependency.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';
const PAGE_SIZE = 250;

export default class GcalDriver {
    static driver = 'gcal';

    #address;
    #config;
    #logger;
    #accessToken = null;
    #tokenExpiresAt = 0;

    constructor(address, config = {}, { logger } = {}) {
        this.#address = address;
        this.#config = config;
        this.#logger = logger || console;
    }

    async #token() {
        if (this.#accessToken && Date.now() < this.#tokenExpiresAt - 60_000) return this.#accessToken;
        const { clientId, clientSecret, refreshToken } = this.#config;
        if (!clientId || !clientSecret || !refreshToken) {
            throw new Error('gcal backend requires clientId, clientSecret and refreshToken');
        }
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
            }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.access_token) {
            throw new Error(`gcal token refresh failed: ${json?.error_description || json?.error || `HTTP ${res.status}`}`);
        }
        this.#accessToken = json.access_token;
        this.#tokenExpiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
        return this.#accessToken;
    }

    async #get(pathname, params = {}) {
        const token = await this.#token();
        const url = new URL(`${API}${pathname}`);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
        if (res.status === 410) { const err = new Error('gcal sync token expired'); err.gone = true; throw err; }
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`gcal ${res.status} ${pathname}: ${body.slice(0, 200)}`);
        }
        return res.json();
    }

    async test() {
        await this.#get('/users/me/calendarList', { maxResults: 1 });
    }

    async listContainers() {
        const configured = (Array.isArray(this.#config.calendars) && this.#config.calendars.length)
            ? this.#config.calendars
            : ['primary'];
        return configured.map((id) => ({ id: String(id), name: String(id) }));
    }

    // Cursor shape: { syncToken } after the first full pass, or
    // { pageToken, syncToken: null } mid-initial-sync. Stored as JSON string.
    async fetchChanges(container, cursor) {
        const state = this.#parseCursor(cursor);
        const params = {
            maxResults: PAGE_SIZE,
            // Recurring series come back as single events with RRULE — the
            // Event schema's envelope model wants the series, not instances.
            singleEvents: false,
        };
        if (state.syncToken) params.syncToken = state.syncToken;
        else {
            const initialDays = Number(this.#config.initialSyncDays) || 365;
            params.timeMin = new Date(Date.now() - initialDays * 86_400_000).toISOString();
        }
        if (state.pageToken) params.pageToken = state.pageToken;

        let page;
        try {
            page = await this.#get(`/calendars/${encodeURIComponent(container.id)}/events`, params);
        } catch (err) {
            if (err.gone) {
                // Expired sync token — restart the incremental stream.
                return { documents: [], nextCursor: this.#cursor({ syncToken: null, pageToken: null }), done: false };
            }
            throw err;
        }

        const documents = [];
        for (const event of page.items || []) {
            if (event.status === 'cancelled') continue;
            const doc = this.#toDocument(container, event);
            if (doc) documents.push(doc);
        }

        const nextCursor = page.nextPageToken
            ? this.#cursor({ ...state, pageToken: page.nextPageToken })
            : this.#cursor({ syncToken: page.nextSyncToken || state.syncToken, pageToken: null });
        return { documents, nextCursor, done: !page.nextPageToken };
    }

    #parseCursor(cursor) {
        if (!cursor) return { syncToken: null, pageToken: null };
        try { return JSON.parse(cursor); } catch { return { syncToken: cursor, pageToken: null }; }
    }

    #cursor(state) { return JSON.stringify({ syncToken: state.syncToken || null, pageToken: state.pageToken || null }); }

    #toDocument(container, event) {
        const start = this.#when(event.start);
        if (!event.id || !start) return null; // an event without a position is not an event
        const rrule = (event.recurrence || []).find((r) => /^RRULE:/i.test(r));

        return {
            schema: 'data/schema/event/calendar',
            data: {
                title: event.summary || '(untitled)',
                description: event.description || undefined,
                start,
                end: this.#when(event.end) ?? undefined,
                allDay: Boolean(event.start?.date && !event.start?.dateTime) || undefined,
                location: event.location || undefined,
                recurrence: rrule ? rrule.replace(/^RRULE:/i, '') : undefined,
                // Connector extras (Event data schema is passthrough)
                calendarId: container.id,
                organizer: event.organizer?.email || undefined,
                attendees: event.attendees?.map((a) => a.email).filter(Boolean),
                htmlLink: event.htmlLink || undefined,
                eventStatus: event.status || undefined,
            },
            metadata: {
                remoteId: event.iCalUID || event.id,
                remoteUpdatedAt: event.updated,
            },
            locations: [
                { url: `gcal://${container.id}/${event.id}`, metadata: { provenance: true } },
                ...(event.htmlLink ? [{ url: event.htmlLink, metadata: {} }] : []),
            ],
            containerSegment: container.id,
        };
    }

    // Google gives {dateTime} for timed events and {date} for all-day ones;
    // the Event schema wants an ISO datetime, so all-day dates pin to midnight
    // UTC (approximation noted in docs/connectors.md).
    #when(when) {
        if (!when) return null;
        if (when.dateTime) return new Date(when.dateTime).toISOString();
        if (when.date) return `${when.date}T00:00:00.000Z`;
        return null;
    }
}
