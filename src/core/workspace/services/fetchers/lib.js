'use strict';

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { sanitizeSegment, MIME_EXTENSIONS } from '../hook/key-utils.js';

// Helpers shared by fetcher drivers. Nothing here knows about rules, documents
// or backends — plain "run a tool / walk a directory / name a file" utilities.

export const USER_AGENT = 'canvas-server download rule';

export function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

export function hostMatches(host, suffix) {
    return Boolean(host) && (host === suffix || host.endsWith(`.${suffix}`));
}

/** Content type of a URL via a HEAD request (10 s budget), null on failure. */
export async function headContentType(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
        const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
        return String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || null;
    } finally {
        clearTimeout(timer);
    }
}

/** A safe filename for a response: Content-Disposition, then the URL path, then `fallbackBase` + mime extension. */
export function filenameFromResponse(res, url, fallbackBase) {
    const disposition = res.headers.get('content-disposition') || '';
    const star = disposition.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
    const plain = disposition.match(/filename="?([^";]+)"?/i);
    let name = star ? decodeURIComponent(star[1].trim()) : plain ? plain[1].trim() : '';
    if (!name) {
        try { name = decodeURIComponent(path.posix.basename(new URL(url).pathname)); } catch { name = ''; }
    }
    const contentType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const hasExt = /\.[a-z0-9]{1,5}$/i.test(name);
    if (!hasExt) {
        name = `${sanitizeSegment(name || fallbackBase, fallbackBase)}${MIME_EXTENSIONS[contentType] || ''}`;
    }
    return sanitizeSegment(name, `${fallbackBase}${MIME_EXTENSIONS[contentType] || ''}`);
}

/** Spawn an external tool in its own process group; a timeout kills the whole group. */
export function runTool(cmd, args, { cwd, timeoutMs, logger, label }) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        let stderr = '';
        child.stderr.on('data', (chunk) => { if (stderr.length < 8192) { stderr += chunk.toString(); } });
        child.stdout.on('data', () => {});
        const timer = setTimeout(() => {
            logger?.warn(`fetch: ${label} timed out after ${timeoutMs}ms, killing`);
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
        }, timeoutMs);
        child.on('error', (err) => { clearTimeout(timer); reject(new Error(`${cmd} failed to start: ${err.message}`)); });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) { resolve(); }
            else { reject(new Error(`${cmd} exited with ${code}${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`)); }
        });
    });
}

/** Every regular file below `dir`, recursively, as absolute paths. */
export function listFiles(dir) {
    const out = [];
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.isFile()) { out.push(full); }
        }
    };
    walk(dir);
    return out;
}
