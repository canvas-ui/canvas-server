'use strict';

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertPublicUrl, guardedDispatcher } from '../../../utils/ssrf-guard.js';

/**
 * Workspace export/import — a workspace is a self-describing folder, so
 * portability is archiving and registration, nothing more.
 *
 * Exports land in the user's own directory (`<root>/<email>/Exports/`) as
 * tar.gz archives of the whole workspace folder. Archiving/extraction shells
 * out to tar and streams — workspaces grow into GBs, nothing may buffer in
 * memory. Import registers a folder in place (registerWorkspacePath) or
 * extracts an archive into the user's Workspaces dir first.
 */

const EXPORTS_DIRNAME = 'Exports';
const ARCHIVE_RE = /\.(tar\.gz|tgz)$/;
// mirrors the archive naming below; also our path-traversal guard for :name params
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(tar\.gz|tgz)$/;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

function fail(message, code, statusCode) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  return err;
}

export function exportsDir(manager, userEmail) {
  if (!userEmail) throw fail('user email required', 'BAD_REQUEST', 400);
  return path.join(manager.rootPath, userEmail, EXPORTS_DIRNAME);
}

export function exportFilePath(manager, userEmail, name) {
  if (!SAFE_NAME_RE.test(name || '')) throw fail(`Invalid export name: ${name}`, 'BAD_REQUEST', 400);
  return path.join(exportsDir(manager, userEmail), name);
}

async function getEntryOrThrow(manager, userId, workspaceId) {
  const entries = await manager.listWorkspaces(userId);
  const entry = entries.find((candidate) => candidate.id === workspaceId || candidate.name === workspaceId);
  if (!entry) throw fail(`Workspace not found: ${workspaceId}`, 'WORKSPACE_NOT_FOUND', 404);
  return entry;
}

/** Archive a stopped workspace's folder into the user's Exports dir. */
export async function exportWorkspace(manager, { userId, userEmail, workspaceId }) {
  const entry = await getEntryOrThrow(manager, userId, workspaceId);
  if (entry.owner && entry.owner !== userId) {
    throw fail('Only the workspace owner can export it', 'FORBIDDEN', 403);
  }
  if (entry.status === 'active' || entry.isActive) {
    throw fail(`Workspace ${entry.name} is active — stop it before exporting`, 'WORKSPACE_ACTIVE', 409);
  }
  if (!entry.rootPath || !fs.existsSync(entry.rootPath)) {
    throw fail(`Workspace directory not found: ${entry.rootPath}`, 'WORKSPACE_NOT_FOUND', 404);
  }

  const dir = exportsDir(manager, userEmail);
  await fsPromises.mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${entry.name || entry.id}-${stamp}.tar.gz`;
  const outFile = path.join(dir, name);

  await run('tar', ['-C', path.dirname(entry.rootPath), '-czf', outFile, path.basename(entry.rootPath)]);

  const stat = await fsPromises.stat(outFile);
  return { name, size: stat.size, createdAt: stat.mtime.toISOString(), workspaceId: entry.id };
}

/** List the user's export archives, newest first, with sizes. */
export async function listExports(manager, userEmail) {
  const dir = exportsDir(manager, userEmail);
  let names;
  try {
    names = await fsPromises.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const items = [];
  for (const name of names) {
    if (!ARCHIVE_RE.test(name)) continue;
    const stat = await fsPromises.stat(path.join(dir, name)).catch(() => null);
    if (stat?.isFile()) items.push({ name, size: stat.size, createdAt: stat.mtime.toISOString() });
  }
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteExport(manager, userEmail, name) {
  const file = exportFilePath(manager, userEmail, name);
  try {
    await fsPromises.unlink(file);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Pull a workspace from another canvas-server instance using a workspace
 * share token, then import it locally. The whole flow needs only {url, token}:
 *
 *   1. GET  /workspaces/token-info            → which workspace the token is bound to
 *   2. POST /workspaces/:id/export            → archive it (source must be stopped)
 *   3. GET  /workspaces/:id/exports/:name     → stream the archive down (GB-safe)
 *   4. best-effort DELETE of the remote archive
 *   5. importWorkspace() on the local copy (kept in the user's Exports dir)
 *
 * Returns the registered index entry.
 */
export async function importWorkspaceFromRemote(manager, { userId, userEmail, url, token, fetchImpl = fetch }) {
  // SSRF guard: the url is fully attacker-controlled, so validate it is a
  // public https host up front and pin every outbound request (redirects
  // included) to a DNS-lookup guard that refuses private/loopback addresses.
  let parsedUrl;
  try {
    parsedUrl = assertPublicUrl(url || '');
  } catch (err) {
    throw fail(`Invalid remote url: ${err.message}`, 'BAD_REQUEST', 400);
  }
  if (!token) throw fail('A workspace share token is required', 'BAD_REQUEST', 400);

  const base = parsedUrl.toString().replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${token}` };
  const guarded = { dispatcher: guardedDispatcher };
  const api = async (route, options = {}) => {
    let res;
    try {
      res = await fetchImpl(`${base}${route}`, { ...guarded, ...options, headers });
    } catch (err) {
      throw fail(`Remote unreachable: ${base} (${err.message})`, 'REMOTE_UNREACHABLE', 502);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw fail(`Remote error (${route}): ${body?.message || res.statusText}`, 'REMOTE_ERROR', res.status);
    }
    return body?.payload;
  };

  const info = await api('/rest/v2/workspaces/token-info');
  if (!info?.workspaceId) throw fail('Remote did not resolve the token to a workspace', 'REMOTE_ERROR', 502);

  const exported = await api(`/rest/v2/workspaces/${info.workspaceId}/export`, { method: 'POST' });
  if (!exported?.name) throw fail('Remote export did not return an archive name', 'REMOTE_ERROR', 502);

  const dir = exportsDir(manager, userEmail);
  await fsPromises.mkdir(dir, { recursive: true });
  const localArchive = exportFilePath(manager, userEmail, exported.name);
  const archiveRoute = `/rest/v2/workspaces/${info.workspaceId}/exports/${encodeURIComponent(exported.name)}`;

  let download;
  try {
    download = await fetchImpl(`${base}${archiveRoute}`, { ...guarded, headers });
  } catch (err) {
    throw fail(`Remote unreachable: ${base} (${err.message})`, 'REMOTE_UNREACHABLE', 502);
  }
  if (!download.ok || !download.body) {
    throw fail(`Archive download failed: ${download.status}`, 'REMOTE_ERROR', download.status || 502);
  }
  try {
    await pipeline(Readable.fromWeb(download.body), fs.createWriteStream(localArchive));
  } catch (err) {
    await fsPromises.rm(localArchive, { force: true }).catch(() => {});
    throw fail(`Archive download failed: ${err.message}`, 'REMOTE_ERROR', 502);
  }

  // the source keeps no leftovers; failure here is not fatal
  try { await fetchImpl(`${base}${archiveRoute}`, { ...guarded, method: 'DELETE', headers }); } catch { /* best-effort */ }

  return importWorkspace(manager, { userId, userEmail, source: localArchive });
}

/**
 * Import a workspace from a server-side source:
 *  - a folder containing workspace.json → registered in place
 *  - a .tar.gz/.tgz archive → extracted into the user's Workspaces dir, then registered
 * Returns the registered index entry.
 */
export async function importWorkspace(manager, { userId, userEmail, source }) {
  if (!source || !path.isAbsolute(source)) {
    throw fail('An absolute source path is required', 'BAD_REQUEST', 400);
  }
  const stat = await fsPromises.stat(source).catch(() => null);
  if (!stat) throw fail(`Source not found: ${source}`, 'SOURCE_NOT_FOUND', 404);

  if (stat.isDirectory()) {
    // In-place registration of an existing on-disk directory must NOT adopt:
    // rewriting a foreign workspace's owner here is a cross-tenant takeover.
    // A user may register a directory in place only if they already own it.
    // (Adoption of a genuinely imported workspace happens on the archive
    // branch below, where the folder is a fresh copy in the user's own dir.)
    return manager.registerWorkspacePath(userId, source, { adopt: false });
  }

  if (!ARCHIVE_RE.test(source)) {
    throw fail(`Unsupported source (need a folder or .tar.gz): ${source}`, 'BAD_REQUEST', 400);
  }

  // archives must contain exactly one top-level workspace folder
  const listing = await run('tar', ['-tzf', source]);
  const topLevel = new Set(listing.split('\n').filter(Boolean).map((line) => line.split('/')[0]));
  if (topLevel.size !== 1) {
    throw fail(`Archive must contain a single workspace folder, found: ${[...topLevel].join(', ')}`, 'BAD_ARCHIVE', 400);
  }
  const [folderName] = topLevel;
  if (folderName.startsWith('.') || folderName.includes('..')) {
    throw fail(`Unsafe archive folder name: ${folderName}`, 'BAD_ARCHIVE', 400);
  }

  // The user's configured workspaces root — an import lands where that user's
  // workspaces actually live, not where they lived by default.
  const workspacesDir = await manager.userWorkspacesPath(userId, userEmail);
  const target = path.join(workspacesDir, folderName);
  if (fs.existsSync(target)) {
    throw fail(`Target already exists: ${target}`, 'TARGET_EXISTS', 409);
  }

  await fsPromises.mkdir(workspacesDir, { recursive: true });
  await run('tar', ['-C', workspacesDir, '-xzf', source]);

  try {
    return await manager.registerWorkspacePath(userId, target);
  } catch (err) {
    // registration failed — do not leave an orphaned extraction behind
    await fsPromises.rm(target, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
