'use strict';

import path from 'path';
import BaseFetcher from '../../BaseFetcher.js';
import { listFiles, runTool, USER_AGENT } from '../../lib.js';

/**
 * page — one page with its images/CSS/JS (wget --page-requisites). The
 * fallback for anything that is not a direct file or a video. Output keeps
 * wget's host/path tree; the entry is the page's own HTML file.
 */

const MAX_DEPTH = 5;

/** Shared by page and website: run wget into workDir, return the entry HTML. */
export async function wgetInto(url, { workDir, timeoutMs, logger, recursive = false, depth = 2 }) {
    const level = Math.min(Math.max(1, Number(depth) || 2), MAX_DEPTH);
    const args = [
        '--quiet', '--no-verbose', '--adjust-extension', '--convert-links', '--page-requisites', '--no-parent',
        '--timeout=30', '--tries=2', `--user-agent=${USER_AGENT}`,
        '-e', 'robots=off',
        ...(recursive ? ['--recursive', `--level=${level}`] : []),
        '-P', workDir,
        url,
    ];
    // wget exits 8 on any 4xx/5xx among requisites even when the page itself
    // downloaded — judge by what landed on disk instead.
    await runTool('wget', args, { cwd: workDir, timeoutMs, logger, label: 'wget' }).catch((err) => {
        logger?.debug(`fetch: wget finished with ${err.message}`);
    });
    const html = listFiles(workDir).filter((f) => /\.html?$/i.test(f));
    if (!html.length) { throw new Error('wget produced no HTML page'); }
    const depthOf = (f) => f.split(path.sep).length;
    const wanted = (() => { try { return path.posix.basename(new URL(url).pathname); } catch { return ''; } })();
    return html.sort((a, b) => {
        const score = (f) => (path.basename(f).startsWith(wanted && wanted !== '/' ? wanted : 'index.html') ? 0 : 1);
        return score(a) - score(b) || depthOf(a) - depthOf(b);
    })[0];
}

class PageFetcher extends BaseFetcher {
    static kind = 'page';
    static layout = 'tree';
    static fallback = true;

    static async fetch(url, ctx) {
        return wgetInto(url, { ...ctx, recursive: false });
    }
}

export default PageFetcher;
