'use strict';

import drivers from './drivers/index.js';
import { headContentType } from './lib.js';

export { default as BaseFetcher } from './BaseFetcher.js';
export { arxivPdfUrl } from './drivers/file/index.js';
export { isVideoUrl } from './drivers/video/index.js';
export { drivers };

/**
 * Fetcher registry. Everything is derived from the drivers' statics — see
 * BaseFetcher for the contract.
 */

const byKind = new Map();
for (const driver of drivers) {
    byKind.set(driver.kind, driver);
    for (const alias of driver.aliases || []) { byKind.set(alias, driver); }
}
const fallback = drivers.find((d) => d.fallback) || null;

export function listKinds() {
    return drivers.map((d) => d.kind);
}

/** The driver for a rule `kind` (or alias), null when unknown. */
export function getFetcher(kind) {
    return byKind.get(String(kind || '').toLowerCase()) || null;
}

/**
 * Decide how to fetch a URL. `explicit` is the rule's `kind`; 'auto' (or
 * absent) classifies by URL shape first and, for ambiguous links, by a HEAD
 * request's content type (`probe`, injectable for tests).
 * @returns {Promise<string>} a driver kind ('file' | 'video' | 'page' | 'website')
 */
export async function resolveKind(url, explicit = 'auto', probe = headContentType) {
    const wanted = String(explicit || 'auto').toLowerCase();
    if (wanted !== 'auto') {
        const driver = getFetcher(wanted);
        if (driver) { return driver.kind; }
    }
    for (const driver of drivers) {
        if (driver.matches(url)) { return driver.kind; }
    }
    const contentType = await probe(url).catch(() => null);
    if (contentType) {
        for (const driver of drivers) {
            if (driver.matchesContentType(contentType)) { return driver.kind; }
        }
    }
    return fallback ? fallback.kind : 'page';
}
