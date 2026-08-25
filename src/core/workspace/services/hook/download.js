'use strict';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { WORKSPACE_DIRECTORIES } from '../../lib/constants.js';
import { sanitizeSegment, joinKey, MIME_EXTENSIONS, mimeForFilename } from './key-utils.js';

/**
 * The `download` rule action: fetch what a link (tab / bookmark / any document
 * with `data.url`) points at and file the result as a real file.
 *
 *   { "action": "download", "to": "workspace:home", "folder": "Downloads",
 *     "kind": "auto", "recursive": true, "insert": "/media/saved", "tags": [] }
 *
 * `kind`:
 *   auto     — arXiv → PDF; YouTube & co. → video; image/video/PDF URLs → the
 *              file itself; anything else → the page.
 *   image    — the URL's bytes as-is (works for any direct file link).
 *   video    — yt-dlp (best video+audio, merged). `format` overrides.
 *   arxiv    — the paper PDF (abs/ and pdf/ URLs both work).
 *   page     — the page with its images/CSS/JS (wget --page-requisites).
 *   website  — recursive mirror, `depth` levels deep (default 2, max 5).
 *
 * Files land under `folder` (plus the sub-path below the matched `when.path`
 * with `recursive: true`) in the workspace home folder, then move on to `to`
 * when that is another backend. The entry file (image, video, PDF, page's
 * index.html) is indexed as a file document filed exactly where the link is
 * (or at `insert` paths) and tagged with `tags`. A ledger in var/ makes the
 * action idempotent: the same rule never downloads the same URL twice while
 * the file still exists.
 *
 * Downloads are awaited (`timeout` seconds, default 600, max 3600) so the run
 * log carries the outcome; a timeout kills the whole process group.
 */

const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com', 'twitch.tv', 'dailymotion.com', 'rumble.com', 'odysee.com'];
const FILE_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'application/pdf', 'application/zip', 'application/octet-stream'];
const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 3600;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const LEDGER_FILE = 'download-ledger.json';

// ── URL classification ───────────────────────────────────────────────────────

export function arxivPdfUrl(url) {
    const match = String(url || '').match(/arxiv\.org\/(?:abs|pdf)\/([\w.-]+?)(?:\.pdf)?(?:[?#].*)?$/i);
    return match ? `https://arxiv.org/pdf/${match[1]}.pdf` : null;
}

function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

function hostMatches(host, suffix) {
    return Boolean(host) && (host === suffix || host.endsWith(`.${suffix}`));
}

export function isVideoUrl(url) {
    const host = hostOf(url);
    return VIDEO_HOSTS.some((h) => hostMatches(host, h));
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|heic|tiff?)(?:[?#].*)?$/i;
const FILE_EXT_RE = /\.(pdf|zip|mp4|mkv|webm|mov|mp3|m4a|flac|wav|ogg)(?:[?#].*)?$/i;

/**
 * Decide how to fetch a URL. `explicit` is the rule's `kind`; 'auto' (or
 * absent) classifies by URL shape first and, for ambiguous links, by a HEAD
 * request's content type (`probe`, injectable for tests).
 * @returns {Promise<'file'|'video'|'page'|'website'>}
 */
export async function resolveKind(url, explicit = 'auto', probe = headContentType) {
    const kind = String(explicit || 'auto').toLowerCase();
    if (kind === 'image' || kind === 'file' || kind === 'arxiv') { return 'file'; }
    if (kind === 'video' || kind === 'page' || kind === 'website') { return kind; }
    if (arxivPdfUrl(url)) { return 'file'; }
    if (isVideoUrl(url)) { return 'video'; }
    if (IMAGE_EXT_RE.test(url) || FILE_EXT_RE.test(url)) { return 'file'; }
    const contentType = await probe(url).catch(() => null);
    if (contentType && FILE_MIME_PREFIXES.some((p) => contentType.startsWith(p))) { return 'file'; }
    return 'page';
}

async function headContentType(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
        const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
        return String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || null;
    } finally {
        clearTimeout(timer);
    }
}

// ── Fetchers (all produce files inside workDir, return the entry file) ───────

function filenameFromResponse(res, url, fallbackBase) {
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

async function fetchFile(url, { workDir, fallbackBase, maxBytes, signal }) {
    const res = await fetch(url, { redirect: 'follow', signal, headers: { 'user-agent': 'canvas-server download rule' } });
    if (!res.ok || !res.body) { throw new Error(`HTTP ${res.status} for ${url}`); }
    const filename = filenameFromResponse(res, url, fallbackBase);
    const target = path.join(workDir, filename);
    let size = 0;
    const cap = async function* (source) {
        for await (const chunk of source) {
            size += chunk.length;
            if (size > maxBytes) { throw new Error(`download exceeds ${maxBytes} bytes`); }
            yield chunk;
        }
    };
    await pipeline(Readable.fromWeb(res.body), cap, fs.createWriteStream(target));
    return target;
}

function runTool(cmd, args, { cwd, timeoutMs, logger, label }) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
        let stderr = '';
        child.stderr.on('data', (chunk) => { if (stderr.length < 8192) { stderr += chunk.toString(); } });
        child.stdout.on('data', () => {});
        const timer = setTimeout(() => {
            logger?.warn(`rule download: ${label} timed out after ${timeoutMs}ms, killing`);
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

function listFiles(dir) {
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

async function fetchVideo(url, { workDir, timeoutMs, format, logger }) {
    const args = [
        '--no-playlist', '--no-progress', '--restrict-filenames', '--no-part', '--no-mtime',
        '-o', '%(title).120B [%(id)s].%(ext)s',
        ...(format ? ['-f', String(format)] : []),
        url,
    ];
    await runTool('yt-dlp', args, { cwd: workDir, timeoutMs, logger, label: 'yt-dlp' });
    const files = listFiles(workDir).filter((f) => !/\.(part|ytdl)$/i.test(f));
    if (!files.length) { throw new Error('yt-dlp produced no file'); }
    // The merged output is the largest file (fragments, if any, are smaller).
    return files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
}

async function fetchSite(url, { workDir, timeoutMs, depth, mirror, logger }) {
    const args = [
        '--quiet', '--no-verbose', '--adjust-extension', '--convert-links', '--page-requisites', '--no-parent',
        '--timeout=30', '--tries=2', '--user-agent=canvas-server download rule',
        '-e', 'robots=off',
        ...(mirror ? ['--recursive', `--level=${depth}`] : []),
        '-P', workDir,
        url,
    ];
    // wget exits 8 on any 4xx/5xx among requisites even when the page itself
    // downloaded — judge by what landed on disk instead.
    await runTool('wget', args, { cwd: workDir, timeoutMs, logger, label: 'wget' }).catch((err) => {
        logger?.debug(`rule download: wget finished with ${err.message}`);
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

// ── Placement ────────────────────────────────────────────────────────────────

function uniquePath(target) {
    if (!fs.existsSync(target)) { return target; }
    const ext = path.extname(target);
    const base = target.slice(0, -ext.length || undefined);
    for (let i = 1; i < 10_000; i++) {
        const candidate = `${base}-${i}${ext}`;
        if (!fs.existsSync(candidate)) { return candidate; }
    }
    throw new Error(`no free name for ${target}`);
}

function moveTree(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
        fs.renameSync(src, dest);
    } catch (err) {
        if (err.code === 'EXDEV' || err.code === 'ENOTEMPTY' || err.code === 'EEXIST') {
            fs.cpSync(src, dest, { recursive: true, force: true });
            fs.rmSync(src, { recursive: true, force: true });
        } else { throw err; }
    }
}

function readLedger(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function writeLedger(file, ledger) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(ledger, null, 2));
    } catch { /* best effort */ }
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ── The action ───────────────────────────────────────────────────────────────

export async function download(action, { workspace, doc, context, scope, logger, provenance, helpers, fetchers = {} }) {
    const { interpolate, expandKeyTemplate, parseLinkTarget, directorySelector } = helpers;
    if (!doc?.id) { logger.debug('rule download: event carries no document, skipping'); return; }
    const url = typeof doc?.data?.url === 'string' ? doc.data.url.trim() : '';
    if (!/^https?:\/\//i.test(url)) { logger.debug(`rule download: ${doc.id} has no http(s) url, skipping`); return; }

    const to = String(action.to || 'workspace:home').trim();
    const render = (template) => interpolate(expandKeyTemplate(String(template), { doc, sourceKey: '' }), scope);
    const folder = action.folder != null && String(action.folder).trim() !== '' ? render(action.folder) : '';
    const rel = action.recursive === true ? String(scope.match?.rel || '') : '';
    const destRel = joinKey(folder, rel);
    const homeRoot = path.resolve(workspace.homePath || path.join(workspace.rootPath, 'home'));
    const destDir = path.resolve(homeRoot, destRel || '.');
    if (destDir !== homeRoot && !destDir.startsWith(`${homeRoot}${path.sep}`)) {
        logger.warn(`rule download: refusing folder outside home/: ${destRel}`);
        return;
    }

    // Idempotency: same rule + same URL only once while the file still exists.
    const ledgerFile = path.join(workspace.rootPath, WORKSPACE_DIRECTORIES.var || 'var', LEDGER_FILE);
    const ledger = readLedger(ledgerFile);
    const ledgerKey = `${scope.rule?.id || 'rule'}|${url}`;
    const previous = ledger[ledgerKey];
    if (previous?.file && fs.existsSync(path.resolve(homeRoot, previous.file))) {
        logger.debug(`rule download: ${url} already downloaded to home/${previous.file}, skipping`);
        return { status: 'skipped', reason: 'already downloaded' };
    }

    const kind = await resolveKind(url, action.kind, fetchers.probe);
    const fetchUrl = kind === 'file' ? (arxivPdfUrl(url) || url) : url;
    const timeoutMs = Math.min(Math.max(5, Number(action.timeout) || DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S) * 1000;
    const maxBytes = Math.max(1024, Number(action.maxBytes) || DEFAULT_MAX_BYTES);
    const depth = Math.min(Math.max(1, Number(action.depth) || 2), 5);

    const eventId = scope.payload?.eventId || crypto.randomUUID();
    const handlerId = String(scope.rule?.id || 'rule').replace(/[^a-zA-Z0-9._-]+/g, '-');
    const workDir = path.join(workspace.rootPath, WORKSPACE_DIRECTORIES.varTmp || 'var/tmp', handlerId, `download-${eventId}`);
    fs.mkdirSync(workDir, { recursive: true });

    const title = String(doc?.data?.title || '').trim();
    const fallbackBase = sanitizeSegment(title, `download-${doc.id}`);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);

    let entry;
    try {
        logger.debug(`rule download: ${doc.id} ${kind} ${fetchUrl} → home/${destRel || '.'}`);
        if (kind === 'file') {
            entry = await (fetchers.file || fetchFile)(fetchUrl, { workDir, fallbackBase, maxBytes, signal: controller.signal });
        } else if (kind === 'video') {
            entry = await (fetchers.video || fetchVideo)(fetchUrl, { workDir, timeoutMs, format: action.format, logger });
        } else {
            entry = await (fetchers.site || fetchSite)(fetchUrl, { workDir, timeoutMs, depth, mirror: kind === 'website', logger });
        }
    } catch (err) {
        fs.rmSync(workDir, { recursive: true, force: true });
        throw new Error(`download of ${fetchUrl} failed: ${err.message}`, { cause: err });
    } finally {
        clearTimeout(abortTimer);
    }

    // Move what was fetched into place. A page/website mirror keeps its
    // host/path tree (wget's layout) below the destination folder; a single
    // file lands directly in it under a collision-free name.
    fs.mkdirSync(destDir, { recursive: true });
    let entryFinal;
    if (kind === 'page' || kind === 'website') {
        const topLevel = fs.readdirSync(workDir);
        for (const name of topLevel) {
            const src = path.join(workDir, name);
            const dest = path.join(destDir, name);
            if (fs.existsSync(dest) && fs.statSync(dest).isDirectory() && fs.statSync(src).isDirectory()) {
                fs.cpSync(src, dest, { recursive: true, force: true });
                fs.rmSync(src, { recursive: true, force: true });
            } else {
                moveTree(src, fs.existsSync(dest) ? uniquePath(dest) : dest);
            }
        }
        entryFinal = path.join(destDir, path.relative(workDir, entry));
        if (!fs.existsSync(entryFinal)) { entryFinal = listFiles(destDir).find((f) => /\.html?$/i.test(f)) || entryFinal; }
    } else {
        const name = action.key ? sanitizeSegment(render(action.key).replace(/\{\{\s*ext\s*\}\}/g, path.extname(entry)), path.basename(entry)) : path.basename(entry);
        entryFinal = uniquePath(path.join(destDir, name));
        moveTree(entry, entryFinal);
    }
    fs.rmSync(workDir, { recursive: true, force: true });

    // Index the entry file exactly where the link is filed (or at `insert`).
    const relFile = path.relative(homeRoot, entryFinal).split(path.sep).join('/');
    const stat = fs.statSync(entryFinal);
    const checksum = sha256(entryFinal);
    const contentType = mimeForFilename(entryFinal);
    const targets = action.insert
        ? (Array.isArray(action.insert) ? action.insert : [action.insert]).map((p) => parseLinkTarget(interpolate(String(p), scope)))
        : [];
    if (!targets.length) {
        const c = typeof context?.classify === 'function' ? context.classify() : null;
        for (const [tree, paths] of Object.entries(c?.treePaths || {})) {
            if (tree === 'backends') { continue; }
            for (const p of paths) { targets.push({ tree, path: p }); }
        }
    }
    const fileDoc = {
        schema: 'data/schema/file',
        checksumArray: [`sha256/${checksum}`],
        locations: [{ url: `file://{WORKSPACE_ROOT}/home/${relFile}` }],
        metadata: { contentType, size: stat.size, filename: path.basename(entryFinal), sourceUrl: url, sourceDocumentId: doc.id },
        data: { title: title || path.basename(entryFinal), url },
    };
    const first = targets[0];
    const selector = !first
        ? {}
        : first.tree !== 'context' ? { context: null, directory: directorySelector(first) } : { context: first.path };
    const inserted = await context.insert(fileDoc, selector);
    const newId = inserted?.id ?? inserted;
    for (const target of targets.slice(1)) {
        await workspace.link(newId, {
            ...(target.tree !== 'context' ? { directory: directorySelector(target) } : { context: workspace.getContextTreeSelector(target.path) }),
            features: action.tags || [],
            emitEvent: false,
            provenance,
        }).catch((err) => logger.debug(`rule download: link ${newId} → ${target.tree}:${target.path} failed: ${err.message}`));
    }
    if (first && Array.isArray(action.tags) && action.tags.length && typeof workspace.link === 'function') {
        await workspace.link(newId, {
            ...(first.tree !== 'context' ? { directory: directorySelector(first) } : { context: workspace.getContextTreeSelector(first.path) }),
            features: action.tags, emitEvent: false, provenance,
        }).catch(() => {});
    }

    ledger[ledgerKey] = { file: relFile, documentId: newId, at: new Date().toISOString() };
    writeLedger(ledgerFile, ledger);

    // Another backend than home: hand the bytes over (the index entry follows).
    if (to && to !== 'workspace:home' && typeof workspace.transferDocumentBytes === 'function') {
        const moved = await workspace.transferDocumentBytes({ ...fileDoc, id: newId }, {
            to, mode: 'move', key: relFile, onConflict: action.onConflict || 'rename',
            from: { backend: 'workspace:home', key: relFile },
        }).catch((err) => { logger.warn(`rule download: moving ${relFile} to ${to} failed: ${err.message}`); return null; });
        if (moved) { logger.debug(`rule download: ${relFile} moved on to ${to}`); }
    }

    logger.debug(`rule download: ${doc.id} ${kind} ${fetchUrl} → home/${relFile} (doc ${newId}, filed at ${targets.map((t) => `${t.tree}:${t.path}`).join(', ') || 'nowhere'})`);
    return { status: 'ok', file: relFile, documentId: newId };
}
