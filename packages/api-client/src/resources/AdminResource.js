/**
 * Admin-only operations: user management, system logs, all workspaces.
 */
export class AdminResource {
    /** @param {import('../HttpClient.js').HttpClient} http */
    constructor(http) {
        this.#http = http;
    }

    #http;

    users = {
        /** List all users (admin only). */
        list: (params) => this.#http.get('/admin/users', params),

        /**
         * Create a user (admin only).
         * @param {object} userData
         */
        create: (userData) => this.#http.post('/admin/users', userData),

        /**
         * @param {string} userId
         */
        get: (userId) => this.#http.get(`/admin/users/${userId}`),

        /**
         * @param {string} userId
         * @param {object} updates
         */
        update: (userId, updates) => this.#http.put(`/admin/users/${userId}`, updates),

        /**
         * @param {string} userId
         */
        delete: (userId) => this.#http.delete(`/admin/users/${userId}`),
    };

    workspaces = {
        /** List all workspaces on the server (admin only). */
        list: (params) => this.#http.get('/admin/workspaces', params),
    };

    logs = {
        /**
         * Get server logs (admin only).
         * @param {object} [params] - e.g. { level, limit, since }
         */
        get: (params) => this.#http.get('/admin/logs', params),
    };
}
