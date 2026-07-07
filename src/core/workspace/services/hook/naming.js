'use strict';

/**
 * Hook file naming conventions, shared by the dispatch engine, the rules
 * loader and the REST meta/generate endpoints.
 *
 * A hook or rules file is inactive when its basename starts with any of:
 *   `example-`  - shipped example, never auto-run, self-describing
 *   `disabled-` - user-disabled hook (the UI toggle adds/strips this)
 *   `_`         - legacy disable prefix, still honoured
 *
 * Enabling a file = stripping the prefix; disabling = prepending `disabled-`.
 */

export const DISABLED_PREFIXES = Object.freeze(['example-', 'disabled-', '_']);

export function isDisabledFile(name) {
    const base = String(name || '');
    return DISABLED_PREFIXES.some((prefix) => base.startsWith(prefix));
}

/** `example-youtube.js` / `disabled-youtube.js` / `_youtube.js` -> `youtube.js` */
export function enabledName(name) {
    let base = String(name || '');
    for (const prefix of DISABLED_PREFIXES) {
        if (base.startsWith(prefix)) { base = base.slice(prefix.length); break; }
    }
    return base;
}

/** `youtube.js` -> `disabled-youtube.js` (no-op when already inactive) */
export function disabledName(name) {
    const base = String(name || '');
    return isDisabledFile(base) ? base : `disabled-${base}`;
}
