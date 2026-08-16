'use strict';

/**
 * GitHub issues driver — one backend per account label, `config.repos` is a
 * list of 'owner/repo' strings. Issues (not PRs) map to data/schema/task.
 *
 * Cursor per repo: the max `updated_at` seen (ISO). Incremental fetch uses
 * `since=<cursor>` sorted by updated ascending, so re-syncs are cheap and a
 * remotely edited issue comes back — and upserts via its identity checksum.
 *
 * Auth: optional `config.token` (PAT). Public repos work unauthenticated
 * (60 req/h budget — the service polls slowly in that case).
 */

const API = 'https://api.github.com';
const PER_PAGE = 100;

export default class GithubDriver {
    static driver = 'github';

    #address;
    #config;
    #logger;

    constructor(address, config = {}, { logger } = {}) {
        this.#address = address;
        this.#config = config;
        this.#logger = logger || console;
    }

    #headers() {
        const headers = {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'canvas-server-connector',
        };
        if (this.#config.token) headers['Authorization'] = `Bearer ${this.#config.token}`;
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
        if (this.#config.token) { await this.#get('/user'); return; }
        const [first] = this.#repos();
        if (first) await this.#get(`/repos/${first}`);
    }

    #repos() {
        return (Array.isArray(this.#config.repos) ? this.#config.repos : [])
            .map((r) => String(r).trim().replace(/^\/+|\/+$/g, ''))
            .filter((r) => /^[^/\s]+\/[^/\s]+$/.test(r));
    }

    async listContainers() {
        // Containers are the configured repos — deliberately not auto-discovery
        // of every repo a token can see.
        return this.#repos().map((repo) => ({ id: repo, name: repo }));
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

        return {
            schema: 'data/schema/task',
            data,
            metadata: {
                remoteId: issue.node_id,
                remoteUpdatedAt: issue.updated_at,
            },
            locations: [
                { url: `gh://${owner}/${name}/issues/${issue.number}`, metadata: { provenance: true } },
                { url: issue.html_url, metadata: {} },
            ],
            // /github/<address>/<owner>/<repo>, but when the address IS the
            // owner (the common case) the owner segment would just repeat —
            // collapse to /github/<owner>/<repo>.
            containerSegment: owner.toLowerCase() === this.#address.toLowerCase() ? name : repo,
        };
    }
}
