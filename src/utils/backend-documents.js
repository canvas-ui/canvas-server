'use strict';

/**
 * Backend-mirror path helpers for the dedicated "backends" tree.
 *
 * All backend-ingested documents are filed in the per-workspace backends tree
 * (type directory, settings.linkContextRoot=false) under an anchor-first
 * schema — the first segment names what the data is anchored to:
 *   /workspace/<store>/<source-dirs>        workspace-anchored (workspace:home → /workspace/home)
 *   /device/<device>/<mount>/<source-dirs>  device-anchored fs mounts
 *   /<driver>/<resource-address>/<path>     connectors/remotes, e.g.
 *     /imap/me@idnc.sk/inbox
 *     /slack/<account>/<channel>
 *     /s3/<address>/<bucket>/<path>
 *
 * Historically these lived inside the default directory tree under /.backends;
 * LEGACY_BACKENDS_PATH exists only for the one-shot startup migration and for
 * normalizing old client-supplied paths.
 */

export const BACKENDS_TREE_NAME = 'backends';
export const DIRECTORY_TREE_NAME = 'directory';
export const LEGACY_BACKENDS_PATH = '/.backends';

export function normalizeSegment(value, fallback = 'unknown') {
  const segment = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9._/@:-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '');

  const parts = segment.split('/').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join('/') : fallback;
}

/**
 * Bitmap keys used to squash '@' and ':' to '_' before synapsd widened its
 * allowed charset (data/backend/imap/user@domain.tld ended up as
 * .../user_domain.tld). This reproduces the OLD normalization so services
 * that know a tag's true spelling can merge the legacy bitmap into the
 * canonical key via db.migrateBitmapKey(legacyBitmapKey(tag), tag) — a no-op
 * once migrated (synapsd skips identical keys / missing legacy bitmaps).
 */
export function legacyBitmapKey(key) {
  return String(key || '')
    .replace(/\\/g, '/')
    .replace(/\s+/g, '_')
    .toLowerCase()
    .replace(/[^a-z0-9_\-./]/g, '_')
    .replace(/_+/g, '_')
    .replace(/\/+/g, '/');
}

function normalizeContextSpec(contextSpec) {
  if (contextSpec === null || contextSpec === undefined) { return null; }
  const value = String(contextSpec).trim();
  if (!value || value === '/') { return '/'; }
  return `/${value.replace(/^\/+/, '').replace(/\/+/g, '/')}`.replace(/\/$/, '');
}

/** Old-style /.backends-prefixed path (pre backends-tree). */
export function isLegacyBackendsPath(pathOrContext) {
  const normalized = normalizeContextSpec(pathOrContext);
  return normalized === LEGACY_BACKENDS_PATH || normalized?.startsWith(`${LEGACY_BACKENDS_PATH}/`) || false;
}

/**
 * Normalize a path for use within the backends tree. Paths are tree-relative
 * (/<driver>/<address>/...); a legacy /.backends prefix from old clients is
 * stripped for compatibility.
 */
export function normalizeBackendsTreePath(pathOrContext) {
  const normalized = normalizeContextSpec(pathOrContext);
  if (normalized === null || normalized === '/') { return '/'; }
  if (normalized === LEGACY_BACKENDS_PATH) { return '/'; }
  if (normalized.startsWith(`${LEGACY_BACKENDS_PATH}/`)) {
    return normalized.slice(LEGACY_BACKENDS_PATH.length);
  }
  return normalized;
}

function buildBackendContext(driver, ...segments) {
  const normalizedSegments = segments
    .map((segment) => normalizeSegment(segment))
    .filter(Boolean);

  return `/${normalizeSegment(driver)}/${normalizedSegments.join('/')}`;
}

export function getBackendEmailContext(driver, accountId, folderName = 'inbox') {
  return buildBackendContext(driver, accountId, normalizeSegment(folderName, 'inbox'));
}

export function getBackendChannelContext(driver, accountId, channelName) {
  return buildBackendContext(driver, accountId, channelName);
}

export function getBackendFileContext(driver, address, containerName = null, objectPath = null) {
  const segments = [address];
  if (containerName != null) { segments.push(containerName); }
  if (objectPath != null) { segments.push(objectPath); }
  return buildBackendContext(driver, ...segments);
}

function filePathDirname(filePath) {
  if (!filePath) return null;
  const normalized = String(filePath).replace(/\\/g, '/').replace(/^\/+/, '');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : null;
}

export function getBackendFileContextFromStoredLocation(location = {}) {
  const source = location?.source || {};
  const dirPath = filePathDirname(source.path || location.key || null);
  return getBackendFileContext(
    location.driver || 'file',
    location.backend || source.provider || 'unknown',
    null,
    dirPath,
  );
}
