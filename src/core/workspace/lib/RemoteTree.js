'use strict';

/**
 * In-memory view of one tree of a remote workspace, backed by the remote's
 * `GET /trees/:tree` JSON (the same shape the web renders). Exposes the subset
 * of synapsd's ContextTree/DirectoryTree surface that contexts and the routes
 * read synchronously (`getLayerForPath`, `buildJsonTree`, `paths`) and the
 * mutations they perform (`insertPath`, `lockPath`, `unlockPath`), each of
 * which round-trips to the remote and then re-reads the tree. Refreshed by the
 * workspace on `tree.*` events, so path lookups stay current without polling.
 */
export default class RemoteTree {
    #workspace;
    #meta;
    #json = null;
    #loading = null;

    constructor(workspace, meta) {
        if (!workspace || !meta?.id) throw new Error('RemoteTree needs a workspace and tree meta');
        this.#workspace = workspace;
        this.#meta = { ...meta };
    }

    get id() { return this.#meta.id; }
    get name() { return this.#meta.name; }
    get type() { return this.#meta.type; }
    get settings() { return this.#meta.settings || {}; }
    get isLoaded() { return this.#json !== null; }
    get root() { return this.#json; }
    get rootLayer() { return this.#json ? this.#layerFromNode(this.#json) : null; }

    #route(suffix = '') {
        return `/trees/${encodeURIComponent(this.#meta.id)}${suffix}`;
    }

    /** (Re)load the JSON tree from the remote; concurrent callers share one request. */
    async refresh() {
        if (this.#loading) return this.#loading;
        this.#loading = (async () => {
            try {
                const json = await this.#workspace.api(this.#route());
                if (json && typeof json === 'object') this.#json = json;
                return this.#json;
            } finally {
                this.#loading = null;
            }
        })();
        return this.#loading;
    }

    updateMeta(meta) {
        this.#meta = { ...this.#meta, ...meta, id: this.#meta.id };
    }

    buildJsonTree() { return this.#json; }

    static #normalizePath(path) {
        const raw = typeof path === 'string' ? path.trim() : '/';
        const parts = raw.split('/').map((s) => s.trim()).filter(Boolean);
        return parts.length ? `/${parts.join('/')}` : '/';
    }

    static #segments(path) {
        return RemoteTree.#normalizePath(path).split('/').filter(Boolean);
    }

    #nodesForPath(path) {
        if (!this.#json) return null;
        const nodes = [this.#json];
        let current = this.#json;
        for (const segment of RemoteTree.#segments(path)) {
            const next = (current.children || []).find((child) => child?.name === segment);
            if (!next) return null;
            nodes.push(next);
            current = next;
        }
        return nodes;
    }

    #layerFromNode(node) {
        if (!node) return null;
        const { children: _children, ...layer } = node;
        return {
            ...layer,
            isLocked: node.locked === true,
            lockedBy: Array.isArray(node.lockedBy) ? node.lockedBy : [],
            toJSON() { return { ...layer }; },
        };
    }

    /** Layer at `path`, or null when the path does not exist (mirrors synapsd). */
    getLayerForPath(path) {
        const nodes = this.#nodesForPath(path);
        return nodes ? this.#layerFromNode(nodes[nodes.length - 1]) : null;
    }

    getLayerById(id) {
        const walk = (node) => {
            if (!node) return null;
            if (node.id === id) return this.#layerFromNode(node);
            for (const child of node.children || []) {
                const hit = walk(child);
                if (hit) return hit;
            }
            return null;
        };
        return walk(this.#json);
    }

    getNodeIdsForPath(path) {
        const nodes = this.#nodesForPath(path);
        return nodes ? nodes.map((n) => n.id) : null;
    }

    pathExists(path) { return this.#nodesForPath(path) !== null; }

    /** Every path in the tree, root first (same order the tree JSON yields). */
    get paths() {
        const out = [];
        const walk = (node, prefix) => {
            if (!node) return;
            const here = prefix === '' ? '/' : prefix;
            out.push(here);
            for (const child of node.children || []) {
                walk(child, `${prefix}/${child.name}`);
            }
        };
        walk(this.#json, '');
        return out;
    }

    get layers() {
        const out = [];
        const walk = (node) => {
            if (!node) return;
            out.push(this.#layerFromNode(node));
            for (const child of node.children || []) walk(child);
        };
        walk(this.#json);
        return out;
    }

    /**
     * Ensure `path` exists on the remote. A path that already exists is a
     * no-op (a read-only share token can still bind a context to an existing
     * path); creating one needs write permission on the remote.
     */
    async insertPath(path = '/') {
        const normalized = RemoteTree.#normalizePath(path);
        if (!this.pathExists(normalized)) {
            await this.#workspace.api(this.#route(`/path${normalized === '/' ? '' : normalized}`), { method: 'PUT', body: {} });
            await this.refresh();
        }
        const ids = (this.getNodeIdsForPath(normalized) || []).slice(1); // root is not a layer op
        return { data: ids, count: ids.length, error: null };
    }

    async #lockOp(op, path, lockBy) {
        const nodes = this.#nodesForPath(path);
        if (!nodes) return { data: [], count: 0, layerIds: [], error: `Path not found: ${path}` };
        const layerIds = [];
        for (const node of nodes.slice(1)) {
            try {
                await this.#workspace.api(this.#route(`/layers/${encodeURIComponent(node.id)}/${op}`), { method: 'POST', body: { lockBy } });
                layerIds.push(node.id);
            } catch (err) {
                // Locks are advisory: a read-only share token cannot place them,
                // and that must not stop a context from binding to the path.
                if (err?.statusCode !== 403) throw err;
            }
        }
        if (layerIds.length) await this.refresh();
        return { data: layerIds, count: layerIds.length, layerIds, error: null };
    }

    lockPath(path, lockBy) { return this.#lockOp('lock', path, lockBy); }
    unlockPath(path, lockBy) { return this.#lockOp('unlock', path, lockBy); }

    toJSON() {
        return { id: this.id, name: this.name, type: this.type, settings: this.settings };
    }
}
