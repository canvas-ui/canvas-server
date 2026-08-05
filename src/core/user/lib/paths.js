'use strict';

import path from 'path';
import os from 'os';

/**
 * Per-user module roots.
 *
 * Three top-level modules are scoped per user and get the same treatment in
 * the (canvas-edge) frontend: workspaces, roles and agents. Each one lives in
 * its own directory under the user's home, and each is independently
 * relocatable — a personal instance points them at `$HOME/Workspaces`,
 * `$HOME/Roles`, `$HOME/Agents` instead of burying them in the server's data
 * dir, without moving anything else.
 *
 * Resolution order per module (first hit wins):
 *   1. the user's own override        — `paths.<module>` in the user record
 *   2. the server-wide default        — env.user.paths.<module> (a template)
 *   3. the built-in default           — <userHome>/{Workspaces,Roles,Agents}
 *
 * Nothing is resolved once and frozen: the paths are computed on read, so
 * changing the server default (or a user's override) takes effect without
 * rewriting stored records. Existing workspaces/agents are unaffected either
 * way — they are indexed by absolute path; only discovery and newly created
 * entries follow these roots.
 *
 * Values may be absolute, `~`-prefixed, or use `{USER_HOME}` (this user's home
 * dir) / `{HOME}` (the OS home dir of the account running the server).
 * A relative value resolves against the user's home.
 */

export const USER_MODULE_DIRS = Object.freeze({
    workspaces: 'Workspaces',
    roles: 'Roles',
    agents: 'Agents',
});

export const USER_MODULES = Object.freeze(Object.keys(USER_MODULE_DIRS));

/** Expand `~`, `{USER_HOME}` and `{HOME}`, then make the value absolute. */
export function expandUserPath(value, homePath) {
    if (typeof value !== 'string' || !value.trim()) { return null; }
    let expanded = value.trim();
    if (homePath) { expanded = expanded.replaceAll('{USER_HOME}', homePath); }
    expanded = expanded.replaceAll('{HOME}', os.homedir());
    if (expanded === '~') { expanded = os.homedir(); }
    else if (expanded.startsWith('~/')) { expanded = path.join(os.homedir(), expanded.slice(2)); }
    if (!path.isAbsolute(expanded)) {
        if (!homePath) { return null; }
        expanded = path.join(homePath, expanded);
    }
    return path.resolve(expanded);
}

/**
 * Resolve all three module roots for one user.
 * @param {object} params
 * @param {string} params.homePath - the user's home dir (index `homePath`)
 * @param {object} [params.overrides] - the user record's `paths` map
 * @param {object} [params.defaults] - server-wide defaults (env.user.paths)
 * @returns {{workspaces: string, roles: string, agents: string}}
 */
export function resolveUserPaths({ homePath, overrides = {}, defaults = {} } = {}) {
    if (!homePath) { throw new Error('homePath is required to resolve user paths'); }
    const home = path.resolve(homePath);
    const resolved = {};
    for (const [module, dirname] of Object.entries(USER_MODULE_DIRS)) {
        resolved[module] = expandUserPath(overrides?.[module], home)
            ?? expandUserPath(defaults?.[module], home)
            ?? path.join(home, dirname);
    }
    return resolved;
}

/**
 * Normalize a `paths` patch coming from an API caller: unknown keys are
 * dropped, `null`/empty means "clear the override, fall back to the default",
 * and every kept value is expanded to an absolute path (so what is stored is
 * what will be used — no surprise re-resolution against a different home).
 * Throws on a value that cannot be made absolute.
 */
export function normalizeUserPathOverrides(patch = {}, homePath) {
    const out = {};
    for (const module of USER_MODULES) {
        if (!(module in patch)) { continue; }
        const value = patch[module];
        if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
            out[module] = null;
            continue;
        }
        if (typeof value !== 'string') {
            throw new Error(`Invalid path for "${module}": expected a string`);
        }
        const expanded = expandUserPath(value, homePath);
        if (!expanded) { throw new Error(`Invalid path for "${module}": ${value}`); }
        out[module] = expanded;
    }
    return out;
}

/**
 * Merge a `paths` patch onto a user's existing overrides. `null` in the patch
 * removes an override (the module falls back to the server default), so the
 * stored map only ever holds deliberate relocations.
 */
export function applyPathOverrides(existing = {}, patch = {}, homePath) {
    const normalized = normalizeUserPathOverrides(patch, homePath);
    const out = { ...existing };
    for (const [module, value] of Object.entries(normalized)) {
        if (value === null) { delete out[module]; } else { out[module] = value; }
    }
    return out;
}

export default resolveUserPaths;
