'use strict';

import { normalizeEmail, normalizePermissions } from './access.js';

/*
 * WorkspaceMembers — user (e-mail) and group grants on a workspace config
 * store (`acl.users` / `acl.groups`). Sibling of WorkspaceTokens; no
 * dependency on Workspace or any DB.
 *
 * A "member" is the public shape of a grant:
 *   { type: 'user'|'group', principal, permissions, description, grantedAt, grantedBy, updatedAt }
 */

const KIND_KEY = { user: 'users', group: 'groups' };

export class WorkspaceMembers {
    #configStore;

    constructor({ configStore }) {
        if (!configStore) throw new Error('configStore is required');
        this.#configStore = configStore;
    }

    #acl() {
        const acl = this.#configStore.get('acl') || {};
        if (!acl.tokens) acl.tokens = {};
        if (!acl.users) acl.users = {};
        if (!acl.groups) acl.groups = {};
        return acl;
    }

    static normalizePrincipal(type, principal) {
        if (type === 'user') {
            const email = normalizeEmail(principal);
            if (!email || !email.includes('@')) throw new Error(`Invalid user e-mail: ${principal}`);
            return email;
        }
        if (type === 'group') {
            const name = String(principal || '').trim();
            if (!name) throw new Error('Group name is required');
            return name;
        }
        throw new Error(`Unknown principal type: ${type}`);
    }

    /** Find the stored key for a principal (users: case-insensitive e-mail; groups: case-insensitive name). */
    #findKey(type, principal) {
        const map = this.#acl()[KIND_KEY[type]];
        const wanted = String(principal || '').trim().toLowerCase();
        return Object.keys(map).find((k) => k.trim().toLowerCase() === wanted) || null;
    }

    list() {
        const acl = this.#acl();
        const out = [];
        for (const [principal, grant] of Object.entries(acl.users)) {
            if (grant) out.push({ type: 'user', principal, ...grant, permissions: normalizePermissions(grant.permissions) });
        }
        for (const [principal, grant] of Object.entries(acl.groups)) {
            if (grant) out.push({ type: 'group', principal, ...grant, permissions: normalizePermissions(grant.permissions) });
        }
        return out;
    }

    get(type, principal) {
        const key = this.#findKey(type, principal);
        if (!key) return null;
        const grant = this.#acl()[KIND_KEY[type]][key];
        return { type, principal: key, ...grant, permissions: normalizePermissions(grant.permissions) };
    }

    /**
     * Grant (or replace) a member's access.
     * @param {'user'|'group'} type
     * @param {string} principal - e-mail or group name/DN
     * @param {{ permissions?: string[], description?: string, grantedBy?: string }} options
     */
    grant(type, principal, options = {}) {
        const key = WorkspaceMembers.normalizePrincipal(type, principal);
        const permissions = normalizePermissions(options.permissions || ['read']);
        if (!permissions.length) throw new Error('At least one valid permission (read, write, admin) is required');

        const acl = this.#acl();
        const map = acl[KIND_KEY[type]];
        const existingKey = this.#findKey(type, key);
        const existing = existingKey ? map[existingKey] : null;
        if (existingKey && existingKey !== key) delete map[existingKey];

        const now = new Date().toISOString();
        const grant = {
            permissions,
            description: options.description ?? existing?.description ?? '',
            grantedAt: existing?.grantedAt || now,
            grantedBy: existing?.grantedBy || options.grantedBy || null,
            updatedAt: now,
            ...(existing && options.grantedBy ? { updatedBy: options.grantedBy } : {}),
        };
        map[key] = grant;
        this.#configStore.set('acl', acl);
        return { type, principal: key, ...grant };
    }

    revoke(type, principal) {
        const key = this.#findKey(type, principal);
        if (!key) return false;
        const acl = this.#acl();
        delete acl[KIND_KEY[type]][key];
        this.#configStore.set('acl', acl);
        return true;
    }
}

export default WorkspaceMembers;
