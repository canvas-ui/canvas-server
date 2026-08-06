'use strict';

import VirtualNamedContextFS from './VirtualNamedContextFS.js';
import { httpError } from './vfs-shared.js';

/**
 * Virtual filesystem that exposes all contexts of a workspace as top-level folders.
 * Each context folder delegates to VirtualNamedContextFS for its content
 * (abstraction folders: Notes/, Files/, Tabs/, etc.).
 *
 * /Contexts/
 *   ├── default/
 *   │   ├── Notes/
 *   │   └── Files/
 *   ├── universe/
 *   │   └── ...
 */
export default class VirtualContextsFS {
    #workspace;
    #userId;
    #contextManager;

    constructor(workspace, userId, contextManager) {
        this.#workspace = workspace;
        this.#userId = userId;
        this.#contextManager = contextManager;
    }

    // ── Public API (same interface as TreeFS / VirtualNamedContextFS) ──

    async stat(vPath) {
        const parts = split(vPath);

        if (parts.length === 0) return { isDir: true, name: 'Contexts', size: 0 };

        const ctxMeta = this.#findContext(parts[0]);
        if (!ctxMeta) return null;
        if (parts.length === 1) return { isDir: true, name: parts[0], size: 0 };

        const vfs = await this.#contextVFS(parts[0]);
        return vfs ? vfs.stat('/' + parts.slice(1).join('/')) : null;
    }

    async readdir(vPath) {
        const parts = split(vPath);

        if (parts.length === 0) {
            return this.#contextManager
                .getContextsForWorkspace(this.#workspace.id)
                .map(c => ({ name: c.id, isDir: true, size: 0 }));
        }

        const vfs = await this.#contextVFS(parts[0]);
        return vfs ? vfs.readdir('/' + parts.slice(1).join('/')) : null;
    }

    async getContent(vPath, options = {}) {
        const parts = split(vPath);
        if (parts.length < 2) return null;

        const vfs = await this.#contextVFS(parts[0]);
        return vfs ? vfs.getContent('/' + parts.slice(1).join('/'), options) : null;
    }

    // ── Write + re-tag, delegated to the addressed context ───────────────────
    // Every verb needs at least `<context>/<name>`; the level above is the
    // context list itself, which is not a place anything is written.

    async #delegate(vPath, method, ...args) {
        const parts = split(vPath);
        if (parts.length < 2) { throw httpError(403, 'Address something inside a context, e.g. <context>/note.md'); }
        const vfs = await this.#contextVFS(parts[0]);
        if (!vfs || typeof vfs[method] !== 'function') { throw httpError(404, 'Context not found'); }
        return vfs[method]('/' + parts.slice(1).join('/'), ...args);
    }

    async put(vPath, body) { return this.#delegate(vPath, 'put', body); }
    async del(vPath, options = {}) { return this.#delegate(vPath, 'del', options); }
    async mkcol(vPath) { return this.#delegate(vPath, 'mkcol'); }
    async linkDoc(vPath, doc) { return this.#delegate(vPath, 'linkDoc', doc); }
    async unlinkDoc(vPath, doc, options = {}) { return this.#delegate(vPath, 'unlinkDoc', doc, options); }

    async docAt(vPath) {
        const parts = split(vPath);
        if (parts.length < 2) return null;
        const vfs = await this.#contextVFS(parts[0]);
        return vfs?.docAt ? vfs.docAt('/' + parts.slice(1).join('/')) : null;
    }

    // ── Private ─────────────────────────────────────────────────────────────

    #findContext(name) {
        return this.#contextManager
            .getContextsForWorkspace(this.#workspace.id)
            .find(c => c.id === name);
    }

    async #contextVFS(name) {
        try {
            const ctx = await this.#contextManager.getContext(this.#userId, name);
            if (!ctx || ctx.workspaceId !== this.#workspace.id) return null;
            return new VirtualNamedContextFS(ctx);
        } catch { return null; }
    }
}

function split(p) {
    if (!p || p === '/') return [];
    const n = p.startsWith('/') ? p.slice(1) : p;
    return n.endsWith('/') ? n.slice(0, -1).split('/') : n.split('/');
}
