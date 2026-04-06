/**
 * Workspace lifecycle, documents, trees, bitmaps, and services.
 */
export class WorkspacesResource {
    /** @param {import('../HttpClient.js').HttpClient} http */
    constructor(http) {
        this.#http = http;
    }

    #http;

    // ── Workspace CRUD ─────────────────────────────────────────────────────

    /** List all workspaces accessible to the current user. */
    list(params) {
        return this.#http.get('/workspaces', params);
    }

    /**
     * @param {string} id
     */
    get(id) {
        return this.#http.get(`/workspaces/${id}`);
    }

    /**
     * @param {{ name: string, label?: string, description?: string, color?: string, icon?: string }} data
     */
    create(data) {
        return this.#http.post('/workspaces', data);
    }

    /**
     * @param {string} id
     * @param {object} updates
     */
    update(id, updates) {
        return this.#http.put(`/workspaces/${id}`, updates);
    }

    /**
     * @param {string} id
     */
    delete(id) {
        return this.#http.delete(`/workspaces/${id}`);
    }

    /**
     * @param {string} id
     */
    getStatus(id) {
        return this.#http.get(`/workspaces/${id}/status`);
    }

    /**
     * @param {string} id
     */
    start(id) {
        return this.#http.post(`/workspaces/${id}/start`, {});
    }

    /**
     * @param {string} id
     */
    stop(id) {
        return this.#http.post(`/workspaces/${id}/stop`, {});
    }

    // ── Documents ──────────────────────────────────────────────────────────

    documents = {
        /**
         * Query documents in a workspace.
         * @param {string} workspaceId
         * @param {object} [query]
         */
        query: (workspaceId, query) =>
            this.#http.get(`/workspaces/${workspaceId}/documents`, query),

        /**
         * Insert documents into a workspace.
         * @param {string} workspaceId
         * @param {object|object[]} documents
         */
        insert: (workspaceId, documents) =>
            this.#http.post(`/workspaces/${workspaceId}/documents`, documents),

        /**
         * Get a single document by ID.
         * @param {string} workspaceId
         * @param {string} documentId
         */
        get: (workspaceId, documentId) =>
            this.#http.get(`/workspaces/${workspaceId}/documents/${documentId}`),

        /**
         * Delete a document.
         * @param {string} workspaceId
         * @param {string} documentId
         */
        delete: (workspaceId, documentId) =>
            this.#http.delete(`/workspaces/${workspaceId}/documents/${documentId}`),
    };

    // ── Trees ──────────────────────────────────────────────────────────────

    trees = {
        /**
         * @param {string} workspaceId
         */
        list: (workspaceId) => this.#http.get(`/workspaces/${workspaceId}/trees`),

        /**
         * @param {string} workspaceId
         * @param {object} data
         */
        create: (workspaceId, data) =>
            this.#http.post(`/workspaces/${workspaceId}/trees`, data),
    };

    // ── Bitmaps ────────────────────────────────────────────────────────────

    bitmaps = {
        /**
         * @param {string} workspaceId
         * @param {object} [params]
         */
        list: (workspaceId, params) =>
            this.#http.get(`/workspaces/${workspaceId}/bitmaps`, params),
    };

    // ── Services ───────────────────────────────────────────────────────────

    services = {
        /**
         * @param {string} workspaceId
         * @param {string} serviceName
         */
        getConfig: (workspaceId, serviceName) =>
            this.#http.get(`/workspaces/${workspaceId}/services/${serviceName}/config`),

        /**
         * @param {string} workspaceId
         * @param {string} serviceName
         * @param {object} config
         */
        setConfig: (workspaceId, serviceName, config) =>
            this.#http.put(`/workspaces/${workspaceId}/services/${serviceName}/config`, config),

        /**
         * @param {string} workspaceId
         * @param {string} serviceName
         */
        enable: (workspaceId, serviceName) =>
            this.#http.post(`/workspaces/${workspaceId}/services/${serviceName}/enable`, {}),

        /**
         * @param {string} workspaceId
         * @param {string} serviceName
         */
        disable: (workspaceId, serviceName) =>
            this.#http.post(`/workspaces/${workspaceId}/services/${serviceName}/disable`, {}),
    };

    // ── Tokens (workspace-scoped sharing) ─────────────────────────────────

    tokens = {
        /**
         * @param {string} workspaceId
         */
        list: (workspaceId) =>
            this.#http.get(`/workspaces/${workspaceId}/tokens`),

        /**
         * @param {string} workspaceId
         * @param {object} options
         */
        create: (workspaceId, options) =>
            this.#http.post(`/workspaces/${workspaceId}/tokens`, options),
    };
}
