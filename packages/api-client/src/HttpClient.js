import { CanvasApiError } from './errors.js';

/**
 * Thin fetch wrapper around the Canvas REST API.
 *
 * Handles:
 *  - Auth headers (Bearer token)
 *  - JSON serialization / response unwrapping
 *  - SSE streaming (raw Response, caller reads the body)
 *  - Unified error throwing via CanvasApiError
 *
 * Universal: works in Node 18+, browsers, and Electron with no polyfills.
 */
export class HttpClient {
    /**
     * @param {object} options
     * @param {string} options.baseUrl - e.g. "http://localhost:8001/rest/v2"
     * @param {() => string|null} options.getToken - called per-request to get the current token
     * @param {number} [options.timeout=30000]
     */
    constructor({ baseUrl, getToken, timeout = 30_000 }) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.getToken = getToken;
        this.timeout = timeout;
    }

    // ── Public HTTP verbs ──────────────────────────────────────────────────

    get(path, params) {
        return this.#request('GET', path, { params });
    }

    post(path, body) {
        return this.#request('POST', path, { body });
    }

    put(path, body) {
        return this.#request('PUT', path, { body });
    }

    patch(path, body) {
        return this.#request('PATCH', path, { body });
    }

    delete(path) {
        return this.#request('DELETE', path);
    }

    /**
     * Returns the raw Response for SSE/streaming endpoints.
     * Caller is responsible for reading `response.body`.
     *
     * @param {string} path
     * @param {object} [body]
     * @returns {Promise<Response>}
     */
    async stream(path, body) {
        const url = this.#buildUrl(path);
        const headers = this.#buildHeaders({ hasBody: body !== undefined });

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(this.timeout),
        });

        if (!response.ok) {
            let errBody;
            try { errBody = await response.json(); } catch { /* ignore */ }
            throw new CanvasApiError(
                errBody?.message ?? response.statusText,
                response.status,
                errBody ?? null,
            );
        }

        return response;
    }

    // ── Private ────────────────────────────────────────────────────────────

    /**
     * @param {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} method
     * @param {string} path
     * @param {{ params?: object, body?: unknown }} [opts]
     * @returns {Promise<{ data: unknown, count: number|null, totalCount: number|null, message: string|null }>}
     */
    async #request(method, path, { params, body } = {}) {
        const url = this.#buildUrl(path, params);
        const hasBody = body !== undefined;
        const headers = this.#buildHeaders({ hasBody });

        const fetchOptions = {
            method,
            headers,
            signal: AbortSignal.timeout(this.timeout),
        };

        if (hasBody) {
            fetchOptions.body = JSON.stringify(body);
        }

        let response;
        try {
            response = await fetch(url, fetchOptions);
        } catch (err) {
            throw new CanvasApiError(err.message ?? 'Network error', 0, null);
        }

        let json;
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
            try { json = await response.json(); } catch { /* fall through */ }
        }

        if (!response.ok || json?.status === 'error') {
            throw new CanvasApiError(
                json?.message ?? response.statusText,
                json?.statusCode ?? response.status,
                json ?? null,
            );
        }

        return {
            data: json?.payload ?? json ?? null,
            count: json?.count ?? null,
            totalCount: json?.totalCount ?? null,
            message: json?.message ?? null,
        };
    }

    /**
     * @param {string} path
     * @param {object} [params]
     */
    #buildUrl(path, params) {
        const url = new URL(`${this.baseUrl}${path}`);
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                if (v !== undefined && v !== null) {
                    url.searchParams.set(k, String(v));
                }
            }
        }
        return url.toString();
    }

    /**
     * @param {{ hasBody: boolean }} options
     */
    #buildHeaders({ hasBody }) {
        const headers = { Accept: 'application/json' };

        const token = this.getToken();
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        if (hasBody) {
            headers['Content-Type'] = 'application/json';
        }

        return headers;
    }
}
