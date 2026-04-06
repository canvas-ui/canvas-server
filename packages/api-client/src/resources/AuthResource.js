/**
 * Auth, tokens, and device registration.
 *
 * The server supports four authentication strategies for password-based login:
 *  - 'auto'  — server picks based on the user's stored authMethod or domain config (default)
 *  - 'local' — password stored in Canvas Server
 *  - 'imap'  — delegated to an IMAP server (configured per email domain server-side)
 *  - 'ldap'  — delegated to an LDAP/AD server (configured server-side)
 *
 * The client does not need to know which backend handles authentication — just pass
 * the appropriate strategy and the server resolves it.
 */
export class AuthResource {
    /** @param {import('../HttpClient.js').HttpClient} http */
    constructor(http) {
        this.#http = http;
    }

    #http;

    /**
     * Get server auth configuration: enabled strategies, available IMAP domains,
     * password policy, and email verification requirements.
     *
     * Useful for adapting login UI to what the server actually supports.
     *
     * @returns {Promise<{
     *   data: {
     *     strategies: {
     *       local: { enabled: boolean, passwordPolicy: object, requireEmailVerification: boolean },
     *       imap:  { enabled: boolean, domains: string[] },
     *       ldap:  { enabled: boolean }
     *     }
     *   }
     * }>}
     */
    config() {
        return this.#http.get('/auth/config');
    }

    /**
     * Login with email + password. Returns a short-lived JWT token.
     *
     * For long-lived programmatic access, follow up with `tokens.create()` to
     * mint a persistent API token, then use that for subsequent sessions.
     *
     * @param {object} credentials
     * @param {string} credentials.email
     * @param {string} credentials.password
     * @param {'auto'|'local'|'imap'|'ldap'} [credentials.strategy='auto']
     *   Which backend to authenticate against. 'auto' lets the server decide
     *   based on the user's stored authMethod and domain configuration.
     *
     * @returns {Promise<{ data: { token: string, user: object } }>}
     */
    login({ email, password, strategy = 'auto' }) {
        return this.#http.post('/auth/login', { email, password, strategy });
    }

    /**
     * Get the current authenticated user's profile.
     */
    me() {
        return this.#http.get('/auth/me');
    }

    /**
     * Update the current user's profile.
     * @param {object} updates
     */
    updateProfile(updates) {
        return this.#http.put('/auth/me', updates);
    }

    /**
     * Change the current user's password (local auth only).
     * @param {{ currentPassword: string, newPassword: string }} payload
     */
    changePassword(payload) {
        return this.#http.post('/auth/me/password', payload);
    }

    tokens = {
        /**
         * List all API and device tokens for the current user.
         */
        list: () => this.#http.get('/auth/tokens'),

        /**
         * Create a persistent API token.
         *
         * Prefer API tokens over JWT for CLI and automation — they don't expire
         * by default and survive server restarts.
         *
         * @param {{ name: string, type?: 'api'|'device', expiresAt?: string }} options
         */
        create: (options) => this.#http.post('/auth/tokens', options),

        /**
         * Revoke a token by ID.
         * @param {string} tokenId
         */
        revoke: (tokenId) => this.#http.delete(`/auth/tokens/${tokenId}`),
    };

    devices = {
        /**
         * Register this device and receive a long-lived device token.
         * Device tokens are scoped to the registering device and appear in
         * the user's device list.
         *
         * @param {{ name: string, type?: string, platform?: string }} info
         */
        register: (info) => this.#http.post('/auth/devices/register', info),

        /**
         * List all registered devices for the current user.
         */
        list: () => this.#http.get('/auth/devices'),
    };
}
