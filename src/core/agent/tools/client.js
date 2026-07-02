'use strict';

/*
 * CanvasApiClient — minimal REST client for agent canvas tools.
 *
 * Deliberately speaks the public REST API with the agent's own token instead
 * of importing core services: the exact same ACL middleware + binding clamp
 * that guard external clients guard agent tool calls, and under canvas-edge
 * the code runs unmodified against a remote server (CANVAS_URL flips).
 */

export class CanvasApiClient {
    #baseUrl;
    #token;

    /**
     * @param {Object} env - agent runtime env (see runtime-env.js)
     * @param {string} env.CANVAS_URL   - REST base url, e.g. http://127.0.0.1:8001/rest/v2
     * @param {string} env.CANVAS_TOKEN - canvas-agent-* token
     */
    constructor(env = {}) {
        if (!env.CANVAS_URL || !env.CANVAS_TOKEN) {
            throw new Error('CanvasApiClient requires CANVAS_URL and CANVAS_TOKEN');
        }
        this.#baseUrl = String(env.CANVAS_URL).replace(/\/+$/, '');
        this.#token = env.CANVAS_TOKEN;
    }

    /**
     * @param {string} method
     * @param {string} pathname - path under the REST base, e.g. /workspaces/<id>/documents
     * @param {Object} [options]
     * @param {Object} [options.query] - query params; array values repeat the key
     * @param {Object} [options.body]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<Object>} parsed ResponseObject envelope ({ status, statusCode, message, payload, count, totalCount })
     */
    async request(method, pathname, { query, body, signal } = {}) {
        const url = new URL(`${this.#baseUrl}${pathname}`);
        for (const [key, value] of Object.entries(query || {})) {
            if (value === undefined || value === null || value === '') continue;
            if (Array.isArray(value)) {
                for (const entry of value) url.searchParams.append(key, entry);
            } else {
                url.searchParams.set(key, value);
            }
        }

        const response = await fetch(url, {
            method,
            signal,
            headers: {
                Authorization: `Bearer ${this.#token}`,
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });

        let envelope = null;
        try {
            envelope = await response.json();
        } catch {
            // Non-JSON error body; fall through to the status check below.
        }

        if (!response.ok) {
            const message = envelope?.message || `HTTP ${response.status}`;
            const error = new Error(message);
            error.statusCode = response.status;
            error.payload = envelope?.payload;
            throw error;
        }

        return envelope || {};
    }

    get(pathname, options) { return this.request('GET', pathname, options); }
    post(pathname, options) { return this.request('POST', pathname, options); }
}
