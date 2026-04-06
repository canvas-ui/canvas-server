import { HttpClient } from './HttpClient.js';
import { SocketClient } from './SocketClient.js';
import { AuthResource } from './resources/AuthResource.js';
import { WorkspacesResource } from './resources/WorkspacesResource.js';
import { ContextsResource } from './resources/ContextsResource.js';
import { AgentsResource } from './resources/AgentsResource.js';
import { AdminResource } from './resources/AdminResource.js';

/**
 * Universal Canvas API client — REST + WebSocket in one coherent interface.
 *
 * Works in Node 18+, browsers, Electron, and browser extensions.
 *
 * @example
 * const client = new CanvasClient({ baseUrl: 'http://localhost:8001' });
 *
 * // Authenticate
 * const { data } = await client.auth.login({ email, password });
 * client.setToken(data.token);
 *
 * // REST
 * const { data: workspaces } = await client.workspaces.list();
 *
 * // WebSocket (connect lazily)
 * await client.socket.connect();
 * client.socket.subscribe('workspace:my-id');
 * client.socket.on('workspace.documents.inserted', handler);
 */
export class CanvasClient {
    /**
     * @param {object} options
     * @param {string} options.baseUrl        - Server URL, e.g. "http://localhost:8001"
     * @param {string} [options.restBasePath] - REST path prefix (default: "/rest/v2")
     * @param {string} [options.token]        - Initial auth token
     * @param {number} [options.timeout]      - Request timeout in ms (default: 30000)
     */
    constructor({ baseUrl, restBasePath = '/rest/v2', token, timeout } = {}) {
        if (!baseUrl) throw new Error('CanvasClient: baseUrl is required');

        this.#token = token ?? null;

        const restBaseUrl = `${baseUrl.replace(/\/$/, '')}${restBasePath}`;

        this.http = new HttpClient({
            baseUrl: restBaseUrl,
            getToken: () => this.#token,
            timeout,
        });

        this.socket = new SocketClient({
            baseUrl,
            getToken: () => this.#token,
        });

        // Resource namespaces
        this.auth = new AuthResource(this.http);
        this.workspaces = new WorkspacesResource(this.http);
        this.contexts = new ContextsResource(this.http);
        this.agents = new AgentsResource(this.http);
        this.admin = new AdminResource(this.http);
    }

    #token;

    // ── Token management ───────────────────────────────────────────────────

    /**
     * Set or replace the auth token used for all subsequent requests.
     * @param {string|null} token
     */
    setToken(token) {
        this.#token = token ?? null;
    }

    /** @returns {string|null} */
    getToken() {
        return this.#token;
    }

    // ── Convenience: login and auto-set token ──────────────────────────────

    /**
     * Login and automatically store the returned token.
     *
     * @param {{ email: string, password: string, strategy?: string }} credentials
     * @returns {Promise<object>} The user object from the server
     */
    async login(credentials) {
        const result = await this.auth.login(credentials);
        if (result.data?.token) {
            this.setToken(result.data.token);
        }
        return result;
    }

    /**
     * Revoke the current token and clear it locally.
     */
    async logout() {
        this.#token = null;
        this.socket.disconnect();
    }

    // ── Ping ───────────────────────────────────────────────────────────────

    /**
     * Health-check the server. Does not require authentication.
     */
    ping() {
        return this.http.get('/ping').catch(() =>
            // Fall back to root if /rest/v2/ping doesn't exist
            this.http.get(''),
        );
    }
}
