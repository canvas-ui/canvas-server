#!/usr/bin/env node
'use strict';
/* global process, console */

/*
 * One-shot, idempotent migration: bring legacy IMAP email documents onto the
 * unified storage URL scheme (see STORAGE-URL-SCHEME.md).
 *
 *   BEFORE  data.rawRef = {backend, key:'data/email/raw/<sha>.eml', checksum:'sha256:<hex>'}
 *           attachments[].storageRef = {backend, key:'data/email/attachments/<sha>/<csum>-<name>'}
 *           attachments[].checksum   = 'sha256:<hex>'
 *           locations = []   (email invisible to resolver/dedup)
 *
 *   AFTER   locations = [
 *             {url:'stored://fs:data:email/<account>/<folder>/<sha>.eml', metadata:{...,synced:true}},
 *             {url:'imap://<account>/<folder>;UID=<n>', metadata:{provenance:true}}   // if UID known
 *           ]
 *           checksumArray includes 'sha256/<hex>'
 *           attachments[] = {filename, contentType, size, contentId, isInline,
 *                            checksum:'sha256/<hex>', url:'stored://fs:data:email/<account>/<folder>/<sha>/<name>'}
 *           data.rawRef removed; attachments[].storageRef removed
 *
 * On-disk: data/email/raw/<sha>.eml  →  data/email/<account>/<folder>/<sha>.eml
 *          data/email/attachments/<sha>/<csum>-<name> → data/email/<account>/<folder>/<sha>/<name>
 *
 * Usage:
 *   node scripts/migrate-email-locations.mjs --db <synapsd-root> --data <workspace-data-dir> [--commit]
 *
 * Default is DRY-RUN (reports actions, mutates nothing). Pass --commit to write.
 * Always dry-run against a COPY of a real workspace first.
 */

import path from 'path';
import fs from 'fs/promises';

// ── args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const out = { commit: false, db: null, data: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--commit') out.commit = true;
        else if (a === '--db') out.db = argv[++i];
        else if (a === '--data') out.data = argv[++i];
        else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.db || !args.data) {
    console.log('Usage: node scripts/migrate-email-locations.mjs --db <synapsd-root> --data <workspace-data-dir> [--commit]');
    process.exit(args.help ? 0 : 1);
}

const EMAIL_BACKEND = 'fs:data:email';
const EMAIL_SCHEMA = 'data/abstraction/email';
const DRY = !args.commit;
const tag = DRY ? '[dry-run]' : '[commit]';

// ── helpers (mirror imap service) ─────────────────────────────────────────────
const safeAccount = (v) => String(v || 'unknown').replace(/[/\\]+/g, '_').trim() || 'unknown';
const encodeFolder = (v) => String(v || 'INBOX').split('/').map(encodeURIComponent).join('/') || 'INBOX';
const safeFileName = (name, fallback = 'attachment.bin') => {
    const s = String(name || fallback).trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return s || fallback;
};
const toSlashChecksum = (c) => (typeof c === 'string' ? c.replace(/^([a-z0-9]+):/i, '$1/') : c);
const shaFromChecksum = (c) => (typeof c === 'string' ? c.replace(/^sha256[:/]/i, '') : null);

// Legacy keys were stored as 'data/<rel>' but written to <dataPath>/<rel>.
const legacyPhysical = (dataDir, key) => path.join(dataDir, String(key || '').replace(/^data\//, ''));

function deriveAccount(doc) {
    return safeAccount(
        doc?.data?.platformMetadata?.accountId
        || doc?.metadata?.accountId
        || doc?.data?.to?.[0]?.address
        || doc?.data?.from?.address
        || 'unknown',
    );
}
function deriveFolder(doc) {
    return encodeFolder(doc?.data?.folder?.path || doc?.data?.folder?.name || 'INBOX');
}

async function pathExists(p) {
    try { await fs.access(p); return true; } catch { return false; }
}

// Move a file, creating parents. Idempotent: if src missing but dst exists, treat as done.
async function moveFile(src, dst, stats) {
    if (await pathExists(dst)) { stats.skippedExisting++; return true; }
    if (!await pathExists(src)) { stats.missingSrc++; return false; }
    if (DRY) { stats.wouldMove++; return true; }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst).catch(async (err) => {
        if (err.code === 'EXDEV') { await fs.copyFile(src, dst); await fs.unlink(src); }
        else throw err;
    });
    stats.moved++;
    return true;
}

// ── main ──────────────────────────────────────────────────────────────────────
const SynapsD = (await import(path.resolve('src/services/synapsd/src/index.js'))).default;

const db = new SynapsD({ rootPath: path.resolve(args.db) });
await db.start();

const stats = {
    scanned: 0, alreadyMigrated: 0, migrated: 0, errors: 0,
    moved: 0, wouldMove: 0, skippedExisting: 0, missingSrc: 0,
};

try {
    const result = await db.list({ options: { parse: true, limit: 0 } });
    const docs = Array.isArray(result?.data) ? result.data : (Array.isArray(result) ? result : []);
    console.log(`${tag} listed ${docs.length} documents from ${args.db}`);

    for (const doc of docs) {
        if (doc?.schema !== EMAIL_SCHEMA) continue;
        stats.scanned++;

        const hasLegacy = !!doc?.data?.rawRef
            || (Array.isArray(doc?.data?.attachments) && doc.data.attachments.some((a) => a?.storageRef));
        const alreadyDone = Array.isArray(doc?.locations)
            && doc.locations.some((l) => typeof l?.url === 'string' && l.url.startsWith(`stored://${EMAIL_BACKEND}/`));
        if (!hasLegacy && alreadyDone) { stats.alreadyMigrated++; continue; }
        if (!hasLegacy && !doc?.data?.rawRef) { stats.alreadyMigrated++; continue; }

        try {
            const account = deriveAccount(doc);
            const folder = deriveFolder(doc);

            const rawRef = doc.data.rawRef || {};
            const rawSha = shaFromChecksum(rawRef.checksum) || path.basename(String(rawRef.key || ''), '.eml');
            if (!rawSha) { console.warn(`${tag} ! ${doc.id}: no raw checksum, skipping`); stats.errors++; continue; }

            const rawKey = path.posix.join(account, folder, `${rawSha}.eml`);
            const rawSrc = legacyPhysical(args.data, rawRef.key || `data/email/raw/${rawSha}.eml`);
            const rawDst = path.join(args.data, 'email', account, folder, `${rawSha}.eml`);
            await moveFile(rawSrc, rawDst, stats);

            // attachments
            const newAttachments = [];
            for (const att of doc.data.attachments || []) {
                const csum = shaFromChecksum(att.checksum);
                const fileName = safeFileName(att.filename, csum ? `${csum}.bin` : 'attachment.bin');
                const attKey = path.posix.join(account, folder, rawSha, fileName);
                if (att.storageRef?.key) {
                    const attSrc = legacyPhysical(args.data, att.storageRef.key);
                    const attDst = path.join(args.data, 'email', account, folder, rawSha, fileName);
                    await moveFile(attSrc, attDst, stats);
                }
                newAttachments.push({
                    filename: att.filename || fileName,
                    contentType: att.contentType,
                    size: att.size,
                    contentId: att.contentId,
                    isInline: att.isInline ?? false,
                    checksum: toSlashChecksum(att.checksum),
                    url: `stored://${EMAIL_BACKEND}/${attKey}`,
                });
            }

            // rebuild doc fields
            const uid = Number(doc?.data?.platformMetadata?.uid) || null;
            const provenanceUrl = `imap://${account}/${folder}${uid ? `;UID=${uid}` : ''}`;
            const rawUrl = `stored://${EMAIL_BACKEND}/${rawKey}`;

            doc.locations = [
                { url: rawUrl, metadata: { backend: EMAIL_BACKEND, synced: true } },
                { url: provenanceUrl, metadata: { provenance: true } },
            ];
            // Re-key to the raw-blob hash as the sole, primary content checksum
            // (db.put's update path re-indexes checksums: delete old + insert new).
            doc.checksumArray = [`sha256/${rawSha}`];
            if (newAttachments.length) doc.data.attachments = newAttachments;
            delete doc.data.rawRef;

            if (DRY) {
                console.log(`${tag} would migrate ${doc.id} → ${rawUrl}`);
            } else {
                await db.put(doc); // id present → in-place update, refreshes indexes
                console.log(`${tag} migrated ${doc.id} → ${rawUrl}`);
            }
            stats.migrated++;
        } catch (err) {
            console.error(`${tag} ! error on ${doc?.id}: ${err.message}`);
            stats.errors++;
        }
    }
} finally {
    await db.stop();
}

console.log(`\n${tag} done.`, JSON.stringify(stats, null, 2));
if (DRY) console.log('Dry-run only — re-run with --commit to apply.');
