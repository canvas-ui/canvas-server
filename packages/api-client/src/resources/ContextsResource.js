/**
 * Context navigation, documents, and tree path operations.
 */
export class ContextsResource {
    /** @param {import('../HttpClient.js').HttpClient} http */
    constructor(http) {
        this.#http = http;
    }

    #http;

    // ── Context CRUD ───────────────────────────────────────────────────────

    /** List all contexts for the current user. */
    list(params) {
        return this.#http.get('/contexts', params);
    }

    /** @param {string} id */
    get(id) {
        return this.#http.get(`/contexts/${id}`);
    }

    /**
     * @param {{ workspaceId: string, treeId: string, url?: string, label?: string }} data
     */
    create(data) {
        return this.#http.post('/contexts', data);
    }

    /**
     * @param {string} id
     * @param {object} updates
     */
    update(id, updates) {
        return this.#http.put(`/contexts/${id}`, updates);
    }

    /** @param {string} id */
    delete(id) {
        return this.#http.delete(`/contexts/${id}`);
    }

    /**
     * Navigate a context to a new URL.
     * Equivalent to `update(id, { url })`.
     *
     * @param {string} id
     * @param {string} url - e.g. "universe://music/concerts"
     */
    navigate(id, url) {
        return this.#http.put(`/contexts/${id}`, { url });
    }

    /** @param {string} id */
    lock(id) {
        return this.#http.post(`/contexts/${id}/lock`, {});
    }

    /** @param {string} id */
    unlock(id) {
        return this.#http.post(`/contexts/${id}/unlock`, {});
    }

    // ── Documents ──────────────────────────────────────────────────────────

    documents = {
        /**
         * Query documents at the context's current URL.
         * @param {string} contextId
         * @param {object} [query]
         */
        query: (contextId, query) =>
            this.#http.get(`/contexts/${contextId}/documents`, query),

        /**
         * Insert documents at the context's current URL.
         * @param {string} contextId
         * @param {object|object[]} documents
         */
        insert: (contextId, documents) =>
            this.#http.post(`/contexts/${contextId}/documents`, documents),

        /**
         * @param {string} contextId
         * @param {string} documentId
         */
        remove: (contextId, documentId) =>
            this.#http.delete(`/contexts/${contextId}/documents/${documentId}`),
    };

    // ── Tree ───────────────────────────────────────────────────────────────

    tree = {
        /**
         * Get the context tree bound to this context.
         * @param {string} contextId
         */
        get: (contextId) => this.#http.get(`/contexts/${contextId}/tree`),

        paths: {
            /**
             * Add a path to the tree.
             * @param {string} contextId
             * @param {object} pathData
             */
            insert: (contextId, pathData) =>
                this.#http.post(`/contexts/${contextId}/tree/paths`, pathData),

            /**
             * Remove a path from the tree.
             * @param {string} contextId
             * @param {object} pathData
             */
            remove: (contextId, pathData) =>
                this.#http.delete(`/contexts/${contextId}/tree/paths`),
        },
    };
}
