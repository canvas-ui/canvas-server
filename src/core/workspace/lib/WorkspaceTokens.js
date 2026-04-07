'use strict';

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

/*
 * WorkspaceTokens — standalone token ACL for a workspace config store.
 * No dependency on Workspace or any DB. Usable in any bun/node runtime.
 */

export class WorkspaceTokens {
    #configStore;
    #workspaceId;

    constructor({ configStore, workspaceId }) {
        if (!configStore) throw new Error('configStore is required');
        this.#configStore = configStore;
        this.#workspaceId = workspaceId;
    }

    create(options = {}) {
        const tokenId = uuidv4();
        const name = options.name || 'Workspace token';
        const description = options.description || '';
        const permissions = options.permissions || ['read', 'write'];
        const expiresAt = options.expiresAt || null;

        const randomPart = crypto.randomBytes(24).toString('hex');
        const tokenValue = `canvas-workspace-${randomPart}`;
        const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');

        const token = { id: tokenId, name, description, permissions, createdAt: new Date().toISOString(), expiresAt };

        const acl = this.#configStore.get('acl') || { tokens: {} };
        if (!acl.tokens) acl.tokens = {};
        acl.tokens[`sha256:${tokenHash}`] = token;
        this.#configStore.set('acl', acl);

        return { ...token, value: tokenValue, hash: `sha256:${tokenHash}` };
    }

    list() {
        const acl = this.#configStore.get('acl') || { tokens: {} };
        return Object.entries(acl.tokens || {}).map(([hash, token]) => ({ ...token, hash }));
    }

    delete(hash) {
        const acl = this.#configStore.get('acl') || { tokens: {} };
        if (!acl.tokens || !acl.tokens[hash]) return false;
        delete acl.tokens[hash];
        this.#configStore.set('acl', acl);
        return true;
    }

    verify(tokenValue) {
        if (!tokenValue) return null;

        const tokenHash = crypto.createHash('sha256').update(tokenValue).digest('hex');
        const hashKey = `sha256:${tokenHash}`;

        const acl = this.#configStore.get('acl') || { tokens: {} };
        const token = acl.tokens?.[hashKey];
        if (!token) return null;
        if (token.expiresAt && new Date(token.expiresAt) < new Date()) return null;

        return { ...token, workspaceId: this.#workspaceId };
    }
}
