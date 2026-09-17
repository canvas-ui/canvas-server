'use strict';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WORKSPACE_DIRECTORIES } from '../../lib/constants.js';
import { sanitizeSegment, joinKey, mimeForFilename } from './key-utils.js';
import { resolveKind, getFetcher } from '../fetchers/index.js';
import { listFiles } from '../fetchers/lib.js';

/**
 * The `download` rule action: fetch what a link (tab / bookmark / any document
 * with `data.url`) points at and file the result as a real file.
 *
 *   { "action": "download", "to": "workspace:home", "folder": "Downloads",
 *     "kind": "auto", "recursive": true, "insert": "/media/saved", "tags": [] }
 *
 * `kind` selects a fetcher driver (services/fetchers/drivers/*): 'auto'
 * classifies by URL shape, then by content type, then falls back to `page`.
 * The drivers own the how (yt-dlp, wget, plain HTTP); this action owns the
 * where: placement under a backend, the file document, and idempotency.
 *
 *   auto     — arXiv → PDF; YouTube & co. → video; image/video/PDF URLs → the
 *              file itself; anything else → the page.
 *   file     — the URL's bytes as-is (aliases: image, arxiv).
 *   video    — yt-dlp (best video+audio, merged). `format` overrides.
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

const DEFAULT_TIMEOUT_S = 600;
const MAX_TIMEOUT_S = 3600;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const LEDGER_FILE = 'download-ledger.json';

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
    const fetcher = getFetcher(kind);
    const fetchUrl = fetcher.resolveUrl(url);
    const timeoutMs = Math.min(Math.max(5, Number(action.timeout) || DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S) * 1000;
    const maxBytes = Math.max(1024, Number(action.maxBytes) || DEFAULT_MAX_BYTES);

    const eventId = scope.payload?.eventId || crypto.randomUUID();
    const handlerId = String(scope.rule?.id || 'rule').replace(/[^a-zA-Z0-9._-]+/g, '-');
    const workDir = path.join(workspace.rootPath, WORKSPACE_DIRECTORIES.varTmp || 'var/tmp', handlerId, `download-${eventId}`);
    fs.mkdirSync(workDir, { recursive: true });

    const title = String(doc?.data?.title || '').trim();
    const fallbackBase = sanitizeSegment(title, `download-${doc.id}`);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);

    // `fetchers[kind]` lets tests swap a driver's fetch() for a fake.
    const run = fetchers[kind] || ((u, ctx) => fetcher.fetch(u, ctx));
    let entry;
    try {
        logger.debug(`rule download: ${doc.id} ${kind} ${fetchUrl} → home/${destRel || '.'}`);
        entry = await run(fetchUrl, { workDir, timeoutMs, signal: controller.signal, maxBytes, fallbackBase, logger, action });
    } catch (err) {
        fs.rmSync(workDir, { recursive: true, force: true });
        throw new Error(`download of ${fetchUrl} failed: ${err.message}`, { cause: err });
    } finally {
        clearTimeout(abortTimer);
    }

    // Move what was fetched into place. A 'tree' layout (page/website mirror)
    // keeps its host/path tree below the destination folder; a single file
    // lands directly in it under a collision-free name.
    fs.mkdirSync(destDir, { recursive: true });
    let entryFinal;
    if (fetcher.layout === 'tree') {
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
