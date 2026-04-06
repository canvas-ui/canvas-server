import { HttpClient } from './HttpClient.js';
import { SocketClient } from './SocketClient.js';
import { CanvasApiError } from './errors.js';
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
 * ## Auth modes
 *
 * **Token (preferred for CLI / automation):**
 * ```js
 * const client = new CanvasClient({ baseUrl, token: 'canvas-abc123' });
 * ```
 *
 * **Username + password (interactive login):**
 * ```js
 * const client = new CanvasClient({ baseUrl });
 * await client.authenticate({ email, password });              // local / auto-detect
 * await client.authenticate({ email, password, strategy: 'ldap' });  // explicit backend
 * ```
 *
 * **Pre-configured strategy (LDAP-only deployment):**
 * ```js
 * const client = new CanvasClient({ baseUrl, defaultStrategy: 'ldap' });
 * await client.authenticate({ email, password });   // always uses LDAP
 * ```
 *
 * After `authenticate()` resolves the client holds the resulting token and
 * uses it for all subsequent requests including WebSocket connections.
 */
export class CanvasClient {
    /**
     * @param {object} options
     * @param {string}  options.baseUrl           - Server URL, e.g. "http://localhost:8001"
     * @param {string}  [options.restBasePath]    - REST path prefix (default: "/rest/v2")
     * @param {string}  [options.token]           - Pre-set auth token (skips login)
     * @param {'auto'|'local'|'imap'|'ldap'} [options.defaultStrategy='auto']
     *   Default auth strategy used by `authenticate()` when none is specified.
     *   Useful for deployments where only one backend is available.
     * @param {number}  [options.timeout]         - Request timeout ms (default: 30000)
     */
    constructor({
        baseUrl,
        restBasePath = '/rest/v2',
        token,
        defaultStrategy = 'auto',
        timeout,
    } = {}) {
        if (!baseUrl) throw new Error('CanvasClient: baseUrl is required');

        this.#token = token ?? null;
        this.#defaultStrategy = defaultStrategy;

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
    #defaultStrategy;

    // ── Token management ───────────────────────────────────────────────────

    /**
     * Set or replace the auth token used for all subsequent requests.
     * Call this after receiving a token from an external login flow.
     *
     * @param {string|null} token
     */
    setToken(token) {
        this.#token = token ?? null;
    }

    /** @returns {string|null} */
    getToken() {
        return this.#token;
    }

    // ── Unified authentication entry point ─────────────────────────────────

    /**
     * Authenticate the client. Accepts either a pre-existing token or credentials.
     *
     * Token mode — no network request, token is used immediately:
     * ```js
     * await client.authenticate({ token: 'canvas-abc123' });
     * ```
     *
     * Credential mode — calls POST /auth/login, auto-stores the returned token:
     * ```js
     * await client.authenticate({ email: 'alice@example.com', password: 'secret' });
     * await client.authenticate({ email, password, strategy: 'ldap' });
     * ```
     *
     * If no `strategy` is provided the client's `defaultStrategy` is used
     * (constructor option, default: `'auto'`).
     *
     * @param {object} options
     * @param {string}  [options.token]     - Pre-existing API/JWT/device token
     * @param {string}  [options.email]     - Required for credential auth
     * @param {string}  [options.password]  - Required for credential auth
     * @param {'auto'|'local'|'imap'|'ldap'} [options.strategy]
     *   Overrides the client's defaultStrategy for this call only.
     *
     * @returns {Promise<void>}
     */
    async authenticate({ token, email, password, strategy } = {}) {
        if (token) {
            this.setToken(token);
            return;
        }

        if (email && password) {
            await this.#loginWithCredentials({ email, password, strategy });
            return;
        }

        throw new CanvasApiError(
            'authenticate() requires either { token } or { email, password }',
            0,
            null,
        );
    }

    /**
     * Low-level login. Calls POST /auth/login and auto-stores the returned token.
     * Prefer `authenticate()` for most use cases.
     *
     * @param {{ email: string, password: string, strategy?: 'auto'|'local'|'imap'|'ldap' }} credentials
     * @returns {Promise<{ data: { token: string, user: object } }>}
     */
    async login(credentials) {
        return this.#loginWithCredentials(credentials);
    }

    /**
     * Clear the stored token and disconnect the socket.
     * Does NOT revoke the token server-side — call `auth.tokens.revoke(id)` for that.
     */
    logout() {
        this.#token = null;
        this.socket.disconnect();
    }

    // ── Ping ───────────────────────────────────────────────────────────────

    /**
     * Health-check the server. Does not require authentication.
     */
    ping() {
        return this.http.get('/ping').catch(() =>
            this.http.get(''),
        );
    }

    // ── Private ────────────────────────────────────────────────────────────

    async #loginWithCredentials({ email, password, strategy }) {
        const result = await this.auth.login({
            email,
            password,
            strategy: strategy ?? this.#defaultStrategy,
        });

        if (result.data?.token) {
            this.setToken(result.data.token);
        }

        return result;
    }
}
