'use strict';

/**
 * GitHub issues connector — one backend per account label, `config.repos` is a
 * list of 'owner/repo' strings. Issues (not PRs) map to data/schema/task.
 *
 * Cursor per repo: the max `updated_at` seen (ISO). Incremental fetch uses
 * `since=<cursor>` sorted by updated ascending, so re-syncs are cheap and a
 * remotely edited issue comes back — and upserts via its identity checksum.
 *
 * Auth: optional `config.token` (PAT). Public repos work unauthenticated
 * (60 req/h budget — the service polls slowly in that case).
 */

import BaseConnector from '../../BaseConnector.js';

const API = 'https://api.github.com';
const PER_PAGE = 100;

export default class GithubConnector extends BaseConnector {
    static driver = 'github';
    static label = 'GitHub';
    static icon = 'mdi:github';
    static blurb = 'Issues from the repositories you list, as tasks.';
    static provenanceScheme = 'gh';
    static supports = { prune: true, create: true, update: true, delete: true };

    static configFields = [
        { key: 'address', label: 'Account label', placeholder: 'my-org', required: true },
        { key: 'token', label: 'Personal access token', secret: true,
          hint: 'Optional for public repos (60 req/h); required for write-back.' },
        { key: 'repos', label: 'Repositories (one per line)', placeholder: 'owner/repo', list: true, required: true },
        { key: 'writeBack', label: 'Allow Canvas to edit issues', type: 'boolean' },
    ];

    // Write-back needs BOTH the flag and a token (the PAT's scopes decide
    // what GitHub actually permits; errors surface per call).
    get canWrite() { return this.config.readOnly === false && Boolean(this.config.token); }

    #headers() {
        const headers = {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'canvas-server-connector',
        };
        if (this.config.token) headers['Authorization'] = `Bearer ${this.config.token}`;
        return headers;
    }

    async #get(pathname, params = {}) {
        const url = new URL(`${API}${pathname}`);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
        const res = await fetch(url, { headers: this.#headers() });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`GitHub ${res.status} ${pathname}: ${body.slice(0, 200)}`);
        }
        return res.json();
    }

    async test() {
        // With a token verify it; without, verify the first repo is reachable.
        if (this.config.token) { await this.#get('/user'); return; }
        const [first] = this.#repos();
        if (first) await this.#get(`/repos/${first}`);
    }

    #repos() {
        return (Array.isArray(this.config.repos) ? this.config.repos : [])
            .map((r) => String(r).trim().replace(/^\/+|\/+$/g, ''))
            .filter((r) => /^[^/\s]+\/[^/\s]+$/.test(r));
    }

    async listContainers() {
        // Containers are the configured repos — deliberately not auto-discovery
        // of every repo a token can see.
        return this.#repos().map((repo) => ({ id: repo, name: repo, writable: this.canWrite }));
    }

    async fetchChanges(container, cursor) {
        const repo = container.id;
        const issues = await this.#get(`/repos/${repo}/issues`, {
            state: 'all',
            sort: 'updated',
            direction: 'asc',
            per_page: PER_PAGE,
            since: cursor || undefined,
        });

        const documents = [];
        let maxUpdated = cursor || null;
        for (const issue of issues) {
            if (issue.pull_request) continue; // issues API returns PRs too
            documents.push(this.#toDocument(repo, issue));
            if (!maxUpdated || issue.updated_at > maxUpdated) maxUpdated = issue.updated_at;
        }

        // `since` is inclusive: a full page means more may follow; a page that
        // only re-returns the cursor boundary is done.
        const done = issues.length < PER_PAGE || maxUpdated === cursor;
        return { documents, nextCursor: maxUpdated, done };
    }

    /**
     * Full traversal of the repo's CURRENT issue provenance URLs — the
     * deletion-sync (pruneRemoved) baseline. Includes closed issues (closed ≠
     * deleted). Throws on any API error, so a partial listing can never
     * masquerade as complete.
     */
    async listIdentities(container) {
        const urls = [];
        for (let page = 1; page <= 100; page++) {
            const issues = await this.#get(`/repos/${container.id}/issues`, {
                state: 'all', per_page: PER_PAGE, page,
            });
            for (const issue of issues) {
                if (issue.pull_request) continue;
                urls.push(this.provenance(container.id, 'issues', issue.number));
            }
            if (issues.length < PER_PAGE) break;
        }
        return urls;
    }

    async #send(method, pathname, body) {
        const res = await fetch(`${API}${pathname}`, {
            method,
            headers: { ...this.#headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
            throw new Error(`GitHub ${res.status} ${method} ${pathname}: ${json?.message || ''}`);
        }
        return json;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Write-back (readOnly: false + PAT). Task-shaped payloads/patches.
    // ─────────────────────────────────────────────────────────────────────────

    /** Create an issue from a task payload ({title, description?, labels?}). */
    async createDocument(container, payload = {}) {
        if (!payload.title) throw new Error('issue requires a title');
        const issue = await this.#send('POST', `/repos/${container.id}/issues`, {
            title: payload.title,
            body: payload.description || undefined,
            labels: Array.isArray(payload.labels) && payload.labels.length ? payload.labels : undefined,
        });
        return { uid: issue.node_id, href: issue.html_url, document: this.#toDocument(container.id, issue) };
    }

    /** gh://owner/repo/issues/N → container id "owner/repo". */
    containerIdFromProvenance(provenanceUrl) {
        const m = /^gh:\/\/([^/]+\/[^/]+)\/issues\/\d+$/.exec(String(provenanceUrl || ''));
        return m ? m[1] : null;
    }

    #issueNumber(provenanceUrl) {
        const m = /^gh:\/\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(String(provenanceUrl || ''));
        if (!m) throw new Error(`Not a GitHub issue provenance URL: ${provenanceUrl}`);
        return Number(m[1]);
    }

    /**
     * Update the issue behind a gh:// provenance URL. Task-status semantics:
     * completed → closed, cancelled → closed/not_planned, pending or
     * in-progress → (re)open. Title/description patch through.
     */
    async updateDocument(container, provenanceUrl, patch = {}) {
        const number = this.#issueNumber(provenanceUrl);
        const body = {};
        if (patch.title !== undefined) body.title = patch.title;
        if (patch.description !== undefined) body.body = patch.description;
        if (patch.status !== undefined) {
            if (patch.status === 'completed') { body.state = 'closed'; body.state_reason = 'completed'; }
            else if (patch.status === 'cancelled') { body.state = 'closed'; body.state_reason = 'not_planned'; }
            else { body.state = 'open'; }
        }
        if (Array.isArray(patch.labels)) body.labels = patch.labels;
        if (!Object.keys(body).length) throw new Error('empty issue patch');
        const issue = await this.#send('PATCH', `/repos/${container.id}/issues/${number}`, body);
        return { remote: { number, state: issue.state }, document: this.#toDocument(container.id, issue) };
    }

    /**
     * GitHub's REST API cannot delete issues — the closest terminal state is
     * closed as not_planned, which is what this does. The re-ingested mirror
     * keeps the local document (status: cancelled) as the archive.
     */
    async deleteDocument(container, provenanceUrl) {
        const number = this.#issueNumber(provenanceUrl);
        const issue = await this.#send('PATCH', `/repos/${container.id}/issues/${number}`, {
            state: 'closed', state_reason: 'not_planned',
        });
        return { removedRemote: false, document: this.#toDocument(container.id, issue) };
    }

    #toDocument(repo, issue) {
        const [owner, name] = repo.split('/');
        const status = issue.state === 'closed'
            ? (issue.state_reason === 'not_planned' ? 'cancelled' : 'completed')
            : ((issue.assignees?.length || issue.assignee) ? 'in-progress' : 'pending');

        const data = {
            title: issue.title || `Issue #${issue.number}`,
            description: issue.body || undefined,
            status,
            completedAt: issue.closed_at || undefined,
            dueDate: issue.milestone?.due_on || undefined,
            // Connector extras (Task data schema is passthrough)
            repo,
            number: issue.number,
            labels: (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
            author: issue.user?.login || undefined,
            assignees: (issue.assignees || []).map((a) => a.login).filter(Boolean),
            htmlUrl: issue.html_url,
            milestone: issue.milestone?.title || undefined,
            commentCount: issue.comments ?? undefined,
        };

        return this.document({
            schema: 'data/schema/task',
            data,
            metadata: { remoteId: issue.node_id, remoteUpdatedAt: issue.updated_at },
            provenanceUrl: this.provenance(owner, name, 'issues', issue.number),
            links: [issue.html_url],
            // /github/<address>/<owner>/<repo>, but when the address IS the
            // owner (the common case) the owner segment would just repeat —
            // collapse to /github/<owner>/<repo>.
            containerSegment: owner.toLowerCase() === this.address.toLowerCase() ? name : repo,
        });
    }
}
