'use strict';

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertPublicUrl, guardedDispatcher } from '../../../utils/ssrf-guard.js';
import { validateWorkspaceConfig, findWorkspaceConfigPath } from './scanner.js';

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
// Export always writes .tar.gz — gzip costs far less CPU than bzip2 on the
// GB-sized workspaces this has to handle. Import accepts bzip2 too, because
// archives also arrive from elsewhere (another server, a user's own tar).
const EXPORT_EXTENSION = 'tar.gz';
const ARCHIVE_RE = /\.(tar\.gz|tgz|tar\.bz2|tbz2?)$/;
// mirrors the archive naming below; also our path-traversal guard for :name params
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(tar\.gz|tgz|tar\.bz2|tbz2?)$/;

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

/**
 * Archive a workspace's folder into the user's Exports dir: stop, tar, publish.
 *
 * A workspace must be stopped to be archived — its index and databases are
 * only consistent on disk once it has flushed. `stop: true` does that for the
 * caller (the UI's export button, and the remote-pull flow, both need it);
 * without it an active workspace is refused rather than silently quiesced.
 * The workspace is left stopped: restarting it is the caller's decision, and
 * `stoppedWorkspace` in the result tells them whether there is one to restart.
 */
export async function exportWorkspace(manager, { userId, userEmail, workspaceId, stop = false }) {
  let entry = await getEntryOrThrow(manager, userId, workspaceId);
  if (entry.owner && entry.owner !== userId) {
    throw fail('Only the workspace owner can export it', 'FORBIDDEN', 403);
  }

  let stoppedWorkspace = false;
  if (entry.status === 'active' || entry.isActive) {
    if (!stop) {
      throw fail(`Workspace ${entry.name} is active — stop it before exporting`, 'WORKSPACE_ACTIVE', 409);
    }
    await manager.stopWorkspace(entry.id, userId);
    stoppedWorkspace = true;
    // re-read: rootPath and status come from the index, which stop() updates
    entry = await getEntryOrThrow(manager, userId, workspaceId);
  }
  if (!entry.rootPath || !fs.existsSync(entry.rootPath)) {
    throw fail(`Workspace directory not found: ${entry.rootPath}`, 'WORKSPACE_NOT_FOUND', 404);
  }

  const dir = exportsDir(manager, userEmail);
  await fsPromises.mkdir(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${entry.name || entry.id}-${stamp}.${EXPORT_EXTENSION}`;
  const outFile = path.join(dir, name);

  // A previous export of this same workspace lives in Exports/, not inside the
  // workspace, so there is nothing to exclude here — keep it that way.
  try {
    await run('tar', ['-C', path.dirname(entry.rootPath), '-czf', outFile, path.basename(entry.rootPath)]);
  } catch (err) {
    // never leave a truncated archive behind for the UI to offer as a download
    await fsPromises.rm(outFile, { force: true }).catch(() => {});
    throw fail(`Export failed: ${err.message}`, 'EXPORT_FAILED', 500);
  }

  const stat = await fsPromises.stat(outFile);
  return {
    name,
    size: stat.size,
    createdAt: stat.mtime.toISOString(),
    workspaceId: entry.id,
    stoppedWorkspace,
  };
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
export async function importWorkspaceFromRemote(manager, { userId, userEmail, url, token, fetchImpl = fetch, allowInsecure = false, report = null }) {
  // Phase/progress reporting is optional so direct callers (CLI, tests) can
  // ignore it; the REST layer passes a job reporter through.
  const phase = (name) => report?.phase?.(name);
  const progress = (received, total) => report?.progress?.(received, total);
  // SSRF guard: the url is fully attacker-controlled, so validate it is a
  // public https host up front and pin every outbound request (redirects
  // included) to a DNS-lookup guard that refuses private/loopback addresses.
  //
  // `allowInsecure` (env: CANVAS_ALLOW_INSECURE_REMOTE_IMPORT) relaxes both
  // halves for self-hosted deployments, where the peer canvas-server is
  // legitimately on http at a private address. It is off by default because on
  // a public instance it turns this into an internal-network probe.
  const { base, headers, guarded, api } = remoteApi({ url, token, allowInsecure, fetchImpl });

  phase('resolving');
  const info = await api('/rest/v2/workspaces/token-info');
  if (!info?.workspaceId) throw fail('Remote did not resolve the token to a workspace', 'REMOTE_ERROR', 502);

  // A workspace has to be stopped to be archived, and a shared workspace is
  // normally running — so ask the remote to stop it, but only when the token
  // carries write. With a read-only token the remote answers 409 and the user
  // learns the source has to be stopped on the far side.
  phase('exporting');
  const canStop = Array.isArray(info.permissions) && info.permissions.includes('write');
  const exported = await api(`/rest/v2/workspaces/${info.workspaceId}/export`, {
    method: 'POST',
    body: JSON.stringify({ stop: canStop }),
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
  if (!exported?.name) throw fail('Remote export did not return an archive name', 'REMOTE_ERROR', 502);

  const dir = exportsDir(manager, userEmail);
  await fsPromises.mkdir(dir, { recursive: true });
  const localArchive = exportFilePath(manager, userEmail, exported.name);
  const archiveRoute = `/rest/v2/workspaces/${info.workspaceId}/exports/${encodeURIComponent(exported.name)}`;

  phase('downloading');
  let download;
  try {
    download = await fetchImpl(`${base}${archiveRoute}`, { ...guarded, headers });
  } catch (err) {
    throw fail(`Remote unreachable: ${base} (${err.message})`, 'REMOTE_UNREACHABLE', 502);
  }
  if (!download.ok || !download.body) {
    throw fail(`Archive download failed: ${download.status}`, 'REMOTE_ERROR', download.status || 502);
  }
  // Download to a .part file and rename on success. A partial transfer must
  // never sit in Exports/ under the real name: it would be listed as a valid
  // archive and offered for download and import. The suffix also keeps the
  // in-flight file out of listExports(), which matches on archive extensions.
  const partFile = `${localArchive}.part`;
  // fetchImpl is pluggable, so do not assume a full Response object here
  const expected = Number(download.headers?.get?.('content-length')) || null;
  let received = 0;
  progress(0, expected);
  try {
    const body = Readable.fromWeb(download.body);
    body.on('data', (chunk) => {
      received += chunk.length;
      progress(received, expected);
    });
    await pipeline(body, fs.createWriteStream(partFile));
    await fsPromises.rename(partFile, localArchive);
  } catch (err) {
    await fsPromises.rm(partFile, { force: true }).catch(() => {});
    throw fail(`Archive download failed: ${err.message}`, 'REMOTE_ERROR', 502);
  }

  // the source keeps no leftovers; failure here is not fatal
  try { await fetchImpl(`${base}${archiveRoute}`, { ...guarded, method: 'DELETE', headers }); } catch { /* best-effort */ }

  return importWorkspace(manager, { userId, userEmail, source: localArchive, report });
}

/**
 * One authenticated client for a remote canvas-server, shared by the flows that
 * talk to one: the URL policy, the SSRF dispatcher pinning and the envelope
 * unwrapping must not drift apart between them.
 */
export function remoteApi({ url, token, allowInsecure = false, fetchImpl = fetch }) {
  let parsedUrl;
  try {
    parsedUrl = allowInsecure
      ? assertLoopbackOrPublicUrl(url || '')
      : assertPublicUrl(url || '');
  } catch (err) {
    throw fail(`Invalid remote url: ${err.message}`, 'BAD_REQUEST', 400);
  }
  if (!token) throw fail('A workspace share token is required', 'BAD_REQUEST', 400);

  const base = parsedUrl.toString().replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${token}` };
  // The DNS guard is what refuses private addresses at connect time, so it has
  // to come off too when private targets are deliberately permitted.
  const guarded = allowInsecure ? {} : { dispatcher: guardedDispatcher };

  const api = async (route, options = {}) => {
    let res;
    try {
      // auth headers always apply; a caller may add to them (e.g. Content-Type)
      res = await fetchImpl(`${base}${route}`, {
        ...guarded,
        ...options,
        headers: { ...headers, ...(options.headers || {}) },
      });
    } catch (err) {
      throw fail(`Remote unreachable: ${base} (${err.message})`, 'REMOTE_UNREACHABLE', 502);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw fail(`Remote error (${route}): ${body?.message || res.statusText}`, 'REMOTE_ERROR', res.status);
    }
    return body?.payload;
  };

  return { base, headers, guarded, api };
}

/**
 * Resolve {url, token} to the workspace the share token is bound to, without
 * transferring anything. Used to validate a remote reference before storing it.
 */
export async function resolveRemoteToken({ url, token, allowInsecure = false, fetchImpl = fetch }) {
  const { api } = remoteApi({ url, token, allowInsecure, fetchImpl });
  const info = await api('/rest/v2/workspaces/token-info');
  if (!info?.workspaceId) {
    throw fail('Remote did not resolve the token to a workspace', 'REMOTE_ERROR', 502);
  }
  return info;
}

/**
 * Relaxed URL check for self-hosted remote import: http is allowed and private
 * addresses are not rejected, but the checks that are about correctness rather
 * than network reach still apply — it must be a parseable http(s) URL with no
 * embedded credentials.
 */
function assertLoopbackOrPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http(s) URLs are allowed');
  }
  if (url.username || url.password) {
    throw new Error('Credentials in URL are not allowed');
  }
  return url;
}

/**
 * Import a workspace from a server-side source:
 *  - a folder containing workspace.json → registered in place
 *  - a .tar.gz/.tgz archive → extracted into the user's Workspaces dir, then registered
 * Returns the registered index entry.
 */
export async function importWorkspace(manager, { userId, userEmail, source, report = null }) {
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

  const folderName = await inspectArchive(source);

  // The user's configured workspaces root — an import lands where that user's
  // workspaces actually live, not where they lived by default.
  const workspacesDir = await manager.userWorkspacesPath(userId, userEmail);
  const target = path.join(workspacesDir, folderName);
  if (fs.existsSync(target)) {
    throw fail(`Target already exists: ${target}`, 'TARGET_EXISTS', 409);
  }

  // Extract -> validate -> load. Validation sits between the two so a bad
  // archive is rejected by its own contents, with the extraction cleaned up,
  // rather than surfacing as an opaque registration failure.
  await fsPromises.mkdir(workspacesDir, { recursive: true });
  try {
    report?.phase?.('extracting');
    await run('tar', ['-C', workspacesDir, '-xf', source]);
    await validateWorkspaceDir(target);
    report?.phase?.('loading');
    return await manager.registerWorkspacePath(userId, target);
  } catch (err) {
    // extraction/validation/registration failed — leave no orphan behind
    await fsPromises.rm(target, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Read an archive's table of contents and return its single top-level folder.
 *
 * tar is told to sniff the compression, so this doubles as the "is this really
 * an archive" check. Every entry is screened, not just the top-level name:
 * absolute paths and `..` segments anywhere would let a crafted archive write
 * outside the extraction dir, and archives now arrive from user uploads.
 */
export async function inspectArchive(source) {
  let listing;
  try {
    listing = await run('tar', ['-tf', source]);
  } catch (err) {
    throw fail(`Not a readable tar archive: ${err.message}`, 'BAD_ARCHIVE', 400);
  }

  const entries = listing.split('\n').filter(Boolean);
  if (entries.length === 0) throw fail('Archive is empty', 'BAD_ARCHIVE', 400);

  for (const entry of entries) {
    if (entry.startsWith('/') || entry.split('/').includes('..')) {
      throw fail(`Unsafe path in archive: ${entry}`, 'BAD_ARCHIVE', 400);
    }
  }

  const topLevel = new Set(entries.map((line) => line.split('/')[0]));
  if (topLevel.size !== 1) {
    throw fail(`Archive must contain a single workspace folder, found: ${[...topLevel].join(', ')}`, 'BAD_ARCHIVE', 400);
  }
  const [folderName] = topLevel;
  if (folderName.startsWith('.') || folderName.includes('..')) {
    throw fail(`Unsafe archive folder name: ${folderName}`, 'BAD_ARCHIVE', 400);
  }
  return folderName;
}

/**
 * Is this extracted folder actually a workspace? Uses the same config lookup
 * and validator registerWorkspacePath applies, so anything that passes here
 * fails registration only for reasons unrelated to the archive's contents.
 * Returns the parsed config.
 */
export async function validateWorkspaceDir(dir) {
  const configPath = findWorkspaceConfigPath(dir);
  if (!configPath) {
    throw fail('Archive contains no workspace.json — not a workspace export', 'BAD_ARCHIVE', 400);
  }
  let config;
  try {
    config = JSON.parse(await fsPromises.readFile(configPath, 'utf8'));
  } catch (err) {
    throw fail(`Unreadable workspace.json: ${err.message}`, 'BAD_ARCHIVE', 400);
  }
  const invalid = validateWorkspaceConfig(config);
  if (invalid) throw fail(`Invalid workspace.json: ${invalid}`, 'BAD_ARCHIVE', 400);
  return config;
}

/**
 * Stream an uploaded archive into the user's own Exports dir and return its
 * stored name. This is what scopes "import from local drive" to the user's
 * home: the browser hands us bytes, and they can only ever land under
 * `<root>/<email>/Exports/` — the client never names a filesystem path.
 *
 * The client-supplied filename is reduced to a basename and sanitised, then
 * uniquified, so an upload can neither traverse out of Exports nor overwrite
 * an existing archive.
 */
export async function saveUploadedArchive(manager, userEmail, filename, stream) {
  const base = path.basename(String(filename || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!ARCHIVE_RE.test(base)) {
    throw fail(`Unsupported upload (need .tar.gz, .tgz or .tar.bz2): ${base}`, 'BAD_REQUEST', 400);
  }
  const safe = /^[a-zA-Z0-9]/.test(base) ? base : `import-${base}`;

  const dir = exportsDir(manager, userEmail);
  await fsPromises.mkdir(dir, { recursive: true });

  // uniquify rather than clobber; the suffix goes before the archive extension
  const extMatch = safe.match(ARCHIVE_RE);
  const ext = extMatch[0];
  const stem = safe.slice(0, -ext.length);
  let name = safe;
  for (let i = 1; fs.existsSync(path.join(dir, name)); i += 1) {
    name = `${stem}-${i}${ext}`;
  }

  const target = path.join(dir, name);
  try {
    await pipeline(stream, fs.createWriteStream(target));
  } catch (err) {
    await fsPromises.rm(target, { force: true }).catch(() => {});
    throw fail(`Upload failed: ${err.message}`, 'UPLOAD_FAILED', 500);
  }
  const stat = await fsPromises.stat(target);
  return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
}
