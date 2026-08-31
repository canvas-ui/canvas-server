'use strict';

/**
 * Generic CalDAV driver — any RFC 4791 endpoint (GroupOffice, Nextcloud,
 * Radicale, SOGo, …). One backend per account (address = account label).
 *
 * Config: `url` (calendar-home or a single calendar collection), `username`,
 * `password` (basic auth), optional `calendars` (collection names/hrefs to
 * sync; empty = every calendar found), `readOnly` (default TRUE — set false
 * to enable write-back), `initialSyncDays`.
 *
 * Sync: RFC 6578 sync-collection REPORT with the server's sync-token as the
 * cursor (changed hrefs → calendar-multiget for the ICS payloads). An invalid
 * token (DAV 403/409/507 responses vary — anything non-207) falls back to a
 * full calendar-query REPORT over the initialSyncDays window, then re-arms
 * the token. Servers without sync-token just re-run the window query each
 * poll — the identity-checksum upsert makes that harmless.
 *
 * Write-back: `createEvent(container, data)` PUTs a minimal VEVENT
 * (If-None-Match: * so it can never overwrite). Only when readOnly === false.
 *
 * ICS parsing is a deliberate minimal built-in (unfold + VEVENT master
 * properties) — no new dependencies, mirroring the other drivers' plain-fetch
 * stance. Recurrence overrides (RECURRENCE-ID) are skipped in v1; the master
 * VEVENT carries the RRULE and synapsd ≥3.4 expands multi-position timelines
 * from it.
 */

import BaseConnector from '../../BaseConnector.js';

const DAV_NS_HINT = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"';

export default class CaldavConnector extends BaseConnector {
    static driver = 'caldav';
    static label = 'CalDAV';
    static icon = 'mdi:calendar-sync';
    static blurb = 'Any RFC 4791 calendar server — Nextcloud, Radicale, SOGo, GroupOffice.';
    static provenanceScheme = 'caldav';
    static supports = { prune: false, create: true, update: false, delete: true };

    static configFields = [
        { key: 'address', label: 'Account label', placeholder: 'nextcloud', required: true },
        { key: 'url', label: 'CalDAV URL (calendar home or one calendar)', placeholder: 'https://host/caldav/user', required: true },
        { key: 'username', label: 'Username' },
        { key: 'password', label: 'Password', secret: true },
        { key: 'calendars', label: 'Calendar names (one per line, blank = all)', list: true },
        { key: 'writeBack', label: 'Allow Canvas to create/delete events', type: 'boolean' },
    ];




    #base() {
        const url = String(this.config.url || '').trim();
        if (!url) throw new Error('caldav backend requires a url');
        return url.replace(/\/+$/, '');
    }

    #origin() { return new URL(this.#base()).origin; }

    #headers(extra = {}) {
        const headers = { ...extra };
        if (this.config.username) {
            headers['Authorization'] = 'Basic ' +
                Buffer.from(`${this.config.username}:${this.config.password || ''}`).toString('base64');
        }
        return headers;
    }

    async #dav(method, url, { depth, body, headers = {} } = {}) {
        const res = await fetch(url, {
            method,
            headers: this.#headers({
                'Content-Type': 'application/xml; charset=utf-8',
                ...(depth !== undefined ? { 'Depth': String(depth) } : {}),
                ...headers,
            }),
            body,
        });
        const text = await res.text().catch(() => '');
        return { status: res.status, ok: res.status >= 200 && res.status < 300 || res.status === 207, text, headers: res.headers };
    }

    async test() {
        const { status } = await this.#dav('PROPFIND', this.#base(), {
            depth: 0,
            body: `<?xml version="1.0"?><d:propfind ${DAV_NS_HINT}><d:prop><d:resourcetype/></d:prop></d:propfind>`,
        });
        if (status === 401 || status === 403) throw new Error(`caldav auth failed (${status})`);
        if (status !== 207) throw new Error(`caldav endpoint did not answer PROPFIND (${status})`);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Discovery
    // ─────────────────────────────────────────────────────────────────────────

    async listContainers() {
        const base = this.#base();
        const { status, text } = await this.#dav('PROPFIND', base, {
            depth: 1,
            body: `<?xml version="1.0"?><d:propfind ${DAV_NS_HINT}><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>`,
        });
        if (status !== 207) throw new Error(`caldav PROPFIND failed (${status})`);

        const calendars = [];
        for (const response of this.#responses(text)) {
            if (!/<[^>]*\bcalendar\b[^>]*\/>/i.test(response.propXml) &&
                !/<[^:>]*:calendar\s*\/>/i.test(response.propXml)) continue;
            const name = decodeURIComponent(response.href.replace(/\/+$/, '').split('/').pop() || '');
            calendars.push({
                id: name,
                name: this.#tagText(response.propXml, 'displayname') || name,
                href: new URL(response.href, this.#origin()).toString(),
                writable: this.canWrite,
            });
        }

        // The configured url may itself BE a calendar collection (no children
        // matched) — treat it as the single container.
        if (calendars.length === 0) {
            const name = decodeURIComponent(base.replace(/\/+$/, '').split('/').pop() || 'calendar');
            calendars.push({ id: name, name, href: `${base}/`, writable: this.canWrite });
        }

        const wanted = (Array.isArray(this.config.calendars) ? this.config.calendars : [])
            .map((c) => String(c).trim()).filter(Boolean);
        return wanted.length
            ? calendars.filter((c) => wanted.includes(c.id) || wanted.includes(c.name))
            : calendars;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Sync
    // ─────────────────────────────────────────────────────────────────────────

    async fetchChanges(container, cursor) {
        if (cursor) {
            const incremental = await this.#syncCollection(container, cursor);
            if (incremental) return incremental;
            // Token rejected — fall through to a full window query.
        }
        return this.#fullQuery(container);
    }

    async #syncCollection(container, token) {
        const { status, text } = await this.#dav('REPORT', container.href, {
            depth: undefined,
            body: `<?xml version="1.0"?><d:sync-collection ${DAV_NS_HINT}><d:sync-token>${this.#xmlEscape(token)}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
        });
        if (status !== 207) return null;

        const hrefs = this.#responses(text)
            .filter((r) => !/404/.test(r.statusLine || ''))
            .map((r) => r.href)
            .filter((h) => /\.ics$/i.test(h));
        const nextToken = this.#tagText(text, 'sync-token') || token;
        const documents = hrefs.length ? await this.#multiget(container, hrefs) : [];
        return { documents, nextCursor: nextToken, done: true };
    }

    async #fullQuery(container) {
        const initialDays = Number(this.config.initialSyncDays) || 365;
        const start = new Date(Date.now() - initialDays * 86_400_000)
            .toISOString().replace(/[-:]|\.\d{3}/g, '');
        const { status, text } = await this.#dav('REPORT', container.href, {
            depth: 1,
            body: `<?xml version="1.0"?><c:calendar-query ${DAV_NS_HINT}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${start}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
        });
        if (status !== 207) throw new Error(`caldav calendar-query failed (${status})`);

        const documents = [];
        for (const response of this.#responses(text)) {
            const ics = this.#calendarData(response.propXml);
            if (!ics) continue;
            const doc = this.#toDocument(container, response.href, ics);
            if (doc) documents.push(doc);
        }

        // Re-arm incremental sync where the server supports it.
        const token = await this.#fetchSyncToken(container);
        return { documents, nextCursor: token, done: true };
    }

    async #fetchSyncToken(container) {
        const { status, text } = await this.#dav('PROPFIND', container.href, {
            depth: 0,
            body: `<?xml version="1.0"?><d:propfind ${DAV_NS_HINT}><d:prop><d:sync-token/></d:prop></d:propfind>`,
        });
        if (status !== 207) return null;
        return this.#tagText(text, 'sync-token') || null;
    }

    async #multiget(container, hrefs) {
        const hrefXml = hrefs.map((h) => `<d:href>${this.#xmlEscape(h)}</d:href>`).join('');
        const { status, text } = await this.#dav('REPORT', container.href, {
            depth: 1,
            body: `<?xml version="1.0"?><c:calendar-multiget ${DAV_NS_HINT}><d:prop><d:getetag/><c:calendar-data/></d:prop>${hrefXml}</c:calendar-multiget>`,
        });
        if (status !== 207) throw new Error(`caldav multiget failed (${status})`);
        const documents = [];
        for (const response of this.#responses(text)) {
            const ics = this.#calendarData(response.propXml);
            if (!ics) continue;
            const doc = this.#toDocument(container, response.href, ics);
            if (doc) documents.push(doc);
        }
        return documents;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Write-back
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Create a VEVENT in a calendar. `data` follows the Event schema shape
     * ({title, start, end?, description?, location?, recurrence?, allDay?}).
     * Returns { uid, href, document } — the caller ingests the mirror.
     */
    async createDocument(container, data = {}) {
        if (!this.canWrite) throw new Error(`caldav backend ${this.address} is read-only`);
        if (!data.title || !data.start) throw new Error('event requires title and start');

        const uid = `canvas-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@canvas`;
        const ics = this.#buildIcs(uid, data);
        const href = `${container.href.replace(/\/+$/, '')}/${uid}.ics`;

        const res = await fetch(href, {
            method: 'PUT',
            headers: this.#headers({
                'Content-Type': 'text/calendar; charset=utf-8',
                // Create-only: never overwrite an existing resource.
                'If-None-Match': '*',
            }),
            body: ics,
        });
        if (res.status !== 201 && res.status !== 204) {
            const body = await res.text().catch(() => '');
            throw new Error(`caldav PUT failed (${res.status}): ${body.slice(0, 200)}`);
        }
        return { uid, href, document: this.#toDocument(container, href, ics) };
    }

    /**
     * Delete the VEVENT behind a caldav:// provenance URL
     * (caldav://<address>/<calendar>/<uid>): resolve the resource href from
     * the uid and DELETE it. Returns { removedRemote: true } — no terminal
     * mirror remains, the caller drops the local document.
     */
    /** caldav://<address>/<calendar>/<uid> → container id <calendar>. */
    containerIdFromProvenance(provenanceUrl) {
        const m = /^caldav:\/\/[^/]+\/([^/]+)\//.exec(String(provenanceUrl || ''));
        return m ? m[1] : null;
    }

    async deleteDocument(container, provenanceUrl) {
        if (!this.canWrite) throw new Error(`caldav backend ${this.address} is read-only`);
        const uid = String(provenanceUrl || '').split('/').filter(Boolean).pop();
        if (!uid) throw new Error(`Cannot resolve event uid from ${provenanceUrl}`);

        // Resource name and UID are independent — resolve the href by UID.
        const { status, text } = await this.#dav('REPORT', container.href, {
            depth: 1,
            body: `<?xml version="1.0"?><c:calendar-query ${DAV_NS_HINT}><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:prop-filter name="UID"><c:text-match>${this.#xmlEscape(uid)}</c:text-match></c:prop-filter></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`,
        });
        if (status !== 207) throw new Error(`caldav UID lookup failed (${status})`);
        const hit = this.#responses(text).find((r) => /\.ics$/i.test(r.href));
        // Already gone remotely — report removed so the local mirror clears.
        if (!hit) return { removedRemote: true };

        const href = new URL(hit.href, this.#origin()).toString();
        const res = await fetch(href, { method: 'DELETE', headers: this.#headers() });
        if (!(res.status === 200 || res.status === 204 || res.status === 404)) {
            throw new Error(`caldav DELETE failed (${res.status})`);
        }
        return { removedRemote: true };
    }

    #buildIcs(uid, data) {
        const stamp = this.#icsDate(new Date().toISOString());
        const lines = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Canvas//connector//EN',
            'BEGIN:VEVENT',
            `UID:${uid}`,
            `DTSTAMP:${stamp}`,
            data.allDay
                ? `DTSTART;VALUE=DATE:${String(data.start).slice(0, 10).replace(/-/g, '')}`
                : `DTSTART:${this.#icsDate(data.start)}`,
            ...(data.end
                ? [data.allDay
                    ? `DTEND;VALUE=DATE:${String(data.end).slice(0, 10).replace(/-/g, '')}`
                    : `DTEND:${this.#icsDate(data.end)}`]
                : []),
            `SUMMARY:${this.#icsEscape(data.title)}`,
            ...(data.description ? [`DESCRIPTION:${this.#icsEscape(data.description)}`] : []),
            ...(data.location ? [`LOCATION:${this.#icsEscape(data.location)}`] : []),
            ...(data.recurrence ? [`RRULE:${data.recurrence}`] : []),
            'END:VEVENT',
            'END:VCALENDAR',
            '',
        ];
        return lines.join('\r\n');
    }

    #icsDate(iso) { return new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, ''); }
    #icsEscape(v) { return String(v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
    #xmlEscape(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

    // ─────────────────────────────────────────────────────────────────────────
    // ICS → Event document
    // ─────────────────────────────────────────────────────────────────────────

    #toDocument(container, href, ics) {
        const event = this.#parseVevent(ics);
        if (!event || !event.DTSTART) return null;

        const start = this.#fromIcsDate(event.DTSTART);
        if (!start) return null;
        const allDay = /VALUE=DATE\b/.test(event.DTSTART_PARAMS || '') || /^\d{8}$/.test(event.DTSTART);
        const uid = event.UID || href;
        const absHref = new URL(href, this.#origin()).toString();

        return this.document({
            schema: 'data/schema/event/calendar',
            data: {
                title: this.#unescapeIcs(event.SUMMARY) || '(untitled)',
                description: this.#unescapeIcs(event.DESCRIPTION) || undefined,
                start,
                end: this.#fromIcsDate(event.DTEND) ?? undefined,
                allDay: allDay || undefined,
                location: this.#unescapeIcs(event.LOCATION) || undefined,
                recurrence: event.RRULE || undefined,
                calendarId: container.id,
                eventStatus: event.STATUS ? event.STATUS.toLowerCase() : undefined,
            },
            metadata: {
                remoteId: uid,
                remoteUpdatedAt: this.#fromIcsDate(event['LAST-MODIFIED']) || undefined,
            },
            provenanceUrl: this.provenance(this.address, container.id, uid),
            links: [absHref],
            containerSegment: container.id,
        });
    }

    // Minimal VEVENT reader: unfold (CRLF + space/tab continuation), take the
    // FIRST VEVENT without a RECURRENCE-ID (the series master), collect its
    // top-level properties. Parameters are kept beside the value for the few
    // we inspect (VALUE=DATE).
    #parseVevent(ics) {
        const unfolded = String(ics).replace(/\r?\n[ \t]/g, '');
        const lines = unfolded.split(/\r?\n/);
        let inEvent = false;
        let current = null;
        for (const line of lines) {
            if (/^BEGIN:VEVENT/i.test(line)) { inEvent = true; current = {}; continue; }
            if (/^END:VEVENT/i.test(line)) {
                if (current && !current['RECURRENCE-ID']) return current;
                inEvent = false; current = null; continue;
            }
            if (!inEvent || !current) continue;
            const idx = line.indexOf(':');
            if (idx < 1) continue;
            const [nameAndParams, value] = [line.slice(0, idx), line.slice(idx + 1)];
            const [name, ...params] = nameAndParams.split(';');
            const key = name.toUpperCase();
            if (current[key] === undefined) {
                current[key] = value;
                if (params.length) current[`${key}_PARAMS`] = params.join(';');
            }
        }
        return null;
    }

    // 19980118T230000Z | 19980118T230000 (floating — treated as UTC, v1
    // approximation) | 19980118 (all-day).
    #fromIcsDate(value) {
        if (!value) return null;
        const m = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
        if (!m) return null;
        const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
        const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
        return Number.isNaN(Date.parse(iso)) ? null : iso;
    }

    #unescapeIcs(v) {
        if (!v) return v;
        return String(v).replace(/\\n/gi, '\n').replace(/\\([\\;,])/g, '$1');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Multistatus parsing (namespace-prefix agnostic, regex on localnames)
    // ─────────────────────────────────────────────────────────────────────────

    #responses(xml) {
        const out = [];
        const re = /<(?:\w+:)?response[\s>]([\s\S]*?)<\/(?:\w+:)?response>/gi;
        let m;
        while ((m = re.exec(xml))) {
            const block = m[1];
            const href = this.#tagText(block, 'href');
            if (!href) continue;
            const statusLine = this.#tagText(block, 'status') || '';
            out.push({ href, propXml: block, statusLine });
        }
        return out;
    }

    #tagText(xml, localName) {
        const m = new RegExp(`<(?:\\w+:)?${localName}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${localName}>`, 'i').exec(xml);
        return m ? m[1].trim() : null;
    }

    #calendarData(xml) {
        const raw = this.#tagText(xml, 'calendar-data');
        if (!raw) return null;
        // XML-unescape the ICS payload.
        return raw
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#13;/g, '\r').replace(/&amp;/g, '&');
    }
}
