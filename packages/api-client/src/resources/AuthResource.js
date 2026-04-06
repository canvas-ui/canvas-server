/**
 * Auth, tokens, and device registration.
 */
export class AuthResource {
    /** @param {import('../HttpClient.js').HttpClient} http */
    constructor(http) {
        this.#http = http;
    }

    #http;

    /**
     * Get server auth configuration (enabled strategies, password policy).
     */
    config() {
        return this.#http.get('/auth/config');
    }

    /**
     * Login and receive a JWT token.
     *
     * @param {{ email: string, password: string, strategy?: string }} credentials
     * @returns {Promise<{ data: { token: string, user: object } }>}
     */
    login(credentials) {
        return this.#http.post('/auth/login', credentials);
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
     * Change the current user's password.
     * @param {{ currentPassword: string, newPassword: string }} payload
     */
    changePassword(payload) {
        return this.#http.post('/auth/me/password', payload);
    }

    tokens = {
        /**
         * List all API tokens for the current user.
         */
        list: () => this.#http.get('/auth/tokens'),

        /**
         * Create a new API or device token.
         * @param {{ name: string, type?: string, expiresAt?: string }} options
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
         * Register this device and receive a device token.
         * @param {{ name: string, type?: string }} info
         */
        register: (info) => this.#http.post('/auth/devices/register', info),

        /**
         * List all registered devices for the current user.
         */
        list: () => this.#http.get('/auth/devices'),
    };
}
