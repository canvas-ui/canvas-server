'use strict';

import fs from 'fs';
import path from 'path';
import { isDisabledFile } from './naming.js';

/**
 * Collect every enabled JS handler for an event: the single `{event}.js` file
 * plus every `*.js` inside the `{event}/` directory. Files prefixed
 * `example-`, `disabled-` or `_` are inactive (the UI toggle renames them);
 * `lib/` holds shared modules and is never auto-run.
 *
 * Shared by HookService dispatch and the explain endpoint (which reports the
 * hook files an event would invoke without running them).
 */
export function resolveHookFiles(hooksRoot, eventName) {
    const files = [];

    const singleFile = path.join(hooksRoot, `${eventName}.js`);
    if (statFile(singleFile)) { files.push(singleFile); }

    const eventDir = path.join(hooksRoot, eventName);
    try {
        for (const entry of fs.readdirSync(eventDir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith('.js') && !isDisabledFile(entry.name)) {
                files.push(path.join(eventDir, entry.name));
            }
        }
    } catch { /* no directory for this event */ }

    return files;
}

export function statFile(filePath) {
    try {
        const stat = fs.statSync(filePath);
        return stat.isFile() ? stat : null;
    } catch {
        return null;
    }
}
