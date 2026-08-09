#!/usr/bin/env node
'use strict';

/**
 * Import a Wikipedia JSONL dump into a Canvas workspace as Note documents.
 *
 * Each line of the dump is a JSON object of the shape produced by the enwiki
 * namespace-0 extractor:
 *   { id, url, title, abstract, date_created, text }
 *
 * Mapping to a Canvas Note (data/schema/note):
 *   data.title  <- title
 *   data.content <- text, with a "References: <url>" line appended at the end
 *   comment      <- abstract   (the note's user-facing abstract/comment field;
 *                               a top-level doc field, FTS'd, ticks
 *                               feature/has-comment)
 *
 * Docs are inserted at a context path (default ctx:/wikipedia) and stamped into
 * a dataset (default "wikipedia", i.e. the data/dataset/wikipedia bitmap) so the
 * whole import can be listed or dropped as one unit.
 *
 * Two write modes:
 *
 *   LOCAL (default) — open the workspace's SynapsD database directly on disk.
 *     No server needed, but LMDB is single-writer, so:
 *       >>> STOP canvas-server before running, restart it afterwards. <<<
 *
 *   REMOTE (--remote) — POST the documents to a RUNNING instance's REST API
 *     (POST /rest/v2/workspaces/<ws>/documents). No need to stop the server;
 *     requires a Bearer token (--token or $CANVAS_API_TOKEN).
 *
 * Usage:
 *   node scripts/import-wikipedia.js [options]
 *
 * Options:
 *   --file <path>       JSONL dump (default: ./enwiki_namespace_0_228.jsonl)
 *   --context <path>    Context path to insert at   (default: /wikipedia)
 *   --dataset <name>    Dataset name to stamp       (default: wikipedia)
 *   --batch-size <n>    Documents per batch          (default: 250)
 *   --limit <n>         Import at most N records     (default: all)
 *   --dry-run           Parse + map, but do not write anything
 *
 *   Local mode:
 *   --workspace <path>  Workspace root OR its db/ dir
 *                       (default: server/users/admin@canvas.local/workspaces/universe)
 *
 *   Remote mode:
 *   --remote <url>      Base URL of a running instance, e.g. http://127.0.0.1:8001
 *                       (the /rest/v2 API base is appended if not already present).
 *                       May also be set via $CANVAS_REMOTE.
 *   --token <token>     Bearer token for the REST API (or $CANVAS_API_TOKEN).
 *   --workspace-id <id> Workspace name or id to target remotely (default: universe).
 *
 *   -h, --help          Show this help
 */

import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const NOTE_SCHEMA = 'data/schema/note';
const NOTE_SCHEMA_VERSION = '2.0';
const DEFAULT_API_BASE = '/rest/v2';

function parseArgs(argv) {
    const opts = {
        file: path.join(REPO_ROOT, 'enwiki_namespace_0_228.jsonl'),
        workspace: path.join(REPO_ROOT, 'server', 'users', 'admin@canvas.local', 'workspaces', 'universe'),
        workspaceId: 'universe',
        remote: process.env.CANVAS_REMOTE || null,
        token: process.env.CANVAS_API_TOKEN || null,
        context: '/wikipedia',
        dataset: 'wikipedia',
        batchSize: 250,
        limit: Infinity,
        dryRun: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(`Missing value for ${a}`);
            return v;
        };
        switch (a) {
            case '--file': opts.file = path.resolve(next()); break;
            case '--workspace': opts.workspace = path.resolve(next()); break;
            case '--workspace-id': opts.workspaceId = next(); break;
            case '--remote': opts.remote = next(); break;
            case '--token': opts.token = next(); break;
            case '--context': opts.context = next(); break;
            case '--dataset': opts.dataset = next(); break;
            case '--batch-size': opts.batchSize = Math.max(1, parseInt(next(), 10)); break;
            case '--limit': opts.limit = Math.max(1, parseInt(next(), 10)); break;
            case '--dry-run': opts.dryRun = true; break;
            case '-h': case '--help': opts.help = true; break;
            default: throw new Error(`Unknown argument: ${a}`);
        }
    }
    return opts;
}

// Normalise a context path: "ctx:/foo" or "foo" -> "/foo".
function normalizeContext(spec) {
    let s = String(spec).trim();
    if (s.startsWith('ctx:')) s = s.slice(4);
    if (!s.startsWith('/')) s = '/' + s;
    return s;
}

// Resolve the on-disk db/ dir from either a workspace root or a db dir.
function resolveDbPath(workspace) {
    if (path.basename(workspace) === 'db') return workspace;
    return path.join(workspace, 'db');
}

// Turn one dump record into a Note document object. Returns null for records we
// can't make a sensible note out of (no title and no body).
function recordToNote(rec) {
    const title = (rec.title || '').trim();
    const body = (rec.text || rec.abstract || '').trim();
    if (!title && !body) return null;

    let content = body;
    if (rec.url) {
        content = `${content}\n\nReferences: ${rec.url}`;
    }

    const doc = {
        schema: NOTE_SCHEMA,
        schemaVersion: NOTE_SCHEMA_VERSION,
        data: {
            title: title || undefined,
            content,
        },
    };

    // The note's abstract lives in the top-level `comment` field.
    const abstract = (rec.abstract || '').trim();
    if (abstract) doc.comment = abstract;

    return doc;
}

// ── Writers ────────────────────────────────────────────────────────────────
// A writer exposes: describe(), open(), write(batch, {context, features}), close().

function makeDryRunWriter() {
    return {
        describe: () => 'DRY RUN (no writes)',
        async open() {},
        async write() {},
        async close() {},
    };
}

function makeLocalWriter(opts) {
    let db = null;
    const dbPath = resolveDbPath(opts.workspace);
    return {
        describe: () => `LOCAL db ${dbPath}`,
        async open() {
            if (!fs.existsSync(dbPath)) {
                throw new Error(`Workspace db not found: ${dbPath}\n` +
                    `Pass --workspace pointing at a workspace root (or its db/ dir).`);
            }
            const { default: Db } = await import('canvas-synapsd');
            console.log(`Opening SynapsD at ${dbPath} ...`);
            console.log('(Make sure canvas-server is STOPPED — LMDB is single-writer.)\n');
            db = new Db({ path: dbPath, backupOnOpen: false, backupOnClose: false });
            await db.start();
        },
        async write(batch, { context, features }) {
            await db.putMany(batch, { context: { path: context }, features });
        },
        async close() {
            if (db) await db.shutdown().catch(() => {});
        },
    };
}

function makeRemoteWriter(opts) {
    if (!opts.token) {
        throw new Error('Remote mode requires a Bearer token: pass --token or set $CANVAS_API_TOKEN.');
    }
    // Build the base URL: append the REST API base unless the caller already did.
    let base = String(opts.remote).replace(/\/+$/, '');
    if (!/\/rest\/v\d/.test(base)) base += DEFAULT_API_BASE;
    const endpoint = `${base}/workspaces/${encodeURIComponent(opts.workspaceId)}/documents`;

    return {
        describe: () => `REMOTE ${endpoint}`,
        async open() {
            // Surface a clear auth/connectivity error early rather than on the
            // first batch. /ping is unauthenticated; hitting the workspace with a
            // GET validates both reachability and the token.
            const res = await fetch(`${base}/workspaces/${encodeURIComponent(opts.workspaceId)}`, {
                headers: { Authorization: `Bearer ${opts.token}` },
            }).catch((e) => { throw new Error(`Cannot reach ${base}: ${e.message}`); });
            if (res.status === 401 || res.status === 403) {
                throw new Error(`Auth failed (${res.status}) — check --token / workspace access.`);
            }
            if (res.status === 404) {
                throw new Error(`Workspace "${opts.workspaceId}" not found on ${base}.`);
            }
            if (!res.ok) {
                throw new Error(`Preflight to ${base} failed: HTTP ${res.status}`);
            }
        },
        async write(batch, { context, features }) {
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${opts.token}`,
                },
                body: JSON.stringify({ context, features, documents: batch }),
            });
            if (!res.ok) {
                let detail = '';
                try { detail = JSON.stringify(await res.json()); } catch { /* non-JSON body */ }
                throw new Error(`Insert failed: HTTP ${res.status} ${detail}`);
            }
        },
        async close() {},
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log('Usage: node scripts/import-wikipedia.js [--file f]\n' +
            '  Local : [--workspace <path>]\n' +
            '  Remote: --remote <url> --token <token> [--workspace-id universe]\n' +
            '  Common: [--context /wikipedia] [--dataset wikipedia] [--batch-size 250]\n' +
            '          [--limit N] [--dry-run]');
        return;
    }

    const context = normalizeContext(opts.context);
    const datasetFeature = `data/dataset/${opts.dataset}`;

    if (!fs.existsSync(opts.file)) {
        throw new Error(`Dump file not found: ${opts.file}`);
    }

    const writer = opts.dryRun
        ? makeDryRunWriter()
        : opts.remote
            ? makeRemoteWriter(opts)
            : makeLocalWriter(opts);

    console.log(`Import dump : ${opts.file}`);
    console.log(`Target      : ${writer.describe()}`);
    console.log(`Context     : ctx:${context}`);
    console.log(`Dataset     : ${opts.dataset} (${datasetFeature})`);
    console.log(`Batch size  : ${opts.batchSize}${opts.limit !== Infinity ? `, limit ${opts.limit}` : ''}`);
    console.log('');

    await writer.open();

    const rl = readline.createInterface({
        input: fs.createReadStream(opts.file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });

    let read = 0;      // JSON lines seen
    let skipped = 0;   // unparseable / empty records
    let inserted = 0;  // docs written (dry-run: would-be)
    let batch = [];

    const flush = async () => {
        if (batch.length === 0) return;
        await writer.write(batch, { context, features: [datasetFeature] });
        inserted += batch.length;
        batch = [];
        process.stdout.write(`\r  inserted ${inserted} / read ${read} (skipped ${skipped})   `);
    };

    try {
        for await (const line of rl) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (read >= opts.limit) break;

            let rec;
            try {
                rec = JSON.parse(trimmed);
            } catch {
                skipped++;
                continue;
            }
            read++;

            const doc = recordToNote(rec);
            if (!doc) { skipped++; continue; }

            batch.push(doc);
            if (batch.length >= opts.batchSize) await flush();
        }
        await flush();
    } finally {
        rl.close();
        await writer.close();
    }

    process.stdout.write('\n');
    console.log(`\nDone. read=${read}, inserted=${inserted}, skipped=${skipped}`);
}

main().catch((err) => {
    console.error('\nImport failed:', err.message);
    process.exitCode = 1;
});
