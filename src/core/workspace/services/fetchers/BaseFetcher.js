'use strict';

/**
 * BaseFetcher
 *
 * The contract every fetcher driver implements. A fetcher turns the URL a
 * document points at (tab, bookmark, anything with `data.url`) into files on
 * disk. Adding one is two steps and nothing else:
 *
 *   1. `drivers/<kind>/index.js` — a class extending BaseFetcher that declares
 *      its statics and implements `fetch()`.
 *   2. add it to the array in `drivers/index.js` (order = auto-classification
 *      priority; the driver flagged `fallback` catches whatever is left).
 *
 * Fetchers are stateless: everything is static, the registry never
 * instantiates them. The trigger (a `download` rule action), placement into a
 * backend, indexing and idempotency all live in hook/download.js — a driver
 * only knows how to get bytes for a URL into `workDir`.
 *
 * ── Statics ──
 *   kind        the rule `kind` value this driver answers to ('file', 'video', …)
 *   aliases     other `kind` spellings that resolve here ('image', 'arxiv' → file)
 *   layout      'file'  the returned entry is a single file, moved into the
 *                       destination folder under a collision-free name
 *               'tree'  everything below workDir is kept as-is (a site mirror)
 *   fallback    true on exactly one driver: the answer when nothing matches
 *   matches(url)              auto-classification by URL shape (no I/O)
 *   matchesContentType(type)  auto-classification by a HEAD probe's content type
 *   resolveUrl(url)           rewrite the URL before fetching (abs/ → pdf/)
 *
 * ── fetch(url, ctx) ──
 *   Produces files inside `ctx.workDir` and returns the absolute path of the
 *   entry file (the image, the video, the page's index.html). Throws on
 *   failure; the caller discards workDir either way.
 *
 *   ctx: { workDir, timeoutMs, signal, maxBytes, fallbackBase, logger, action }
 *   `action` is the raw rule action for driver-specific options (`format`,
 *   `depth`, …) — read what you need, ignore the rest.
 */
class BaseFetcher {
    static kind = null;
    static aliases = [];
    static layout = 'file';
    static fallback = false;

    static matches(_url) { return false; }
    static matchesContentType(_contentType) { return false; }
    static resolveUrl(url) { return url; }

    static async fetch(_url, _ctx) {
        throw new Error(`${this.kind || this.name}: fetch() not implemented`);
    }
}

export default BaseFetcher;
