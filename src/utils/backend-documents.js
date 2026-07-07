'use strict';

/**
 * Backend-mirrored staging subtree of the directory tree.
 *
 * All backend-ingested documents are filed under a strict schema:
 *   /.backends/<driver>/<resource-address>/<resource-path>
 * e.g.
 *   /.backends/file/workspace:home/<source-dirs>
 *   /.backends/imap/me@idnc.sk/inbox
 *   /.backends/slack/<account>/<channel>
 *   /.backends/s3/<address>/<bucket>/<path>
 */

export const BACKENDS_ROOT_CONTEXT = '/.backends';
export const DIRECTORY_TREE_NAME = 'directory';

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

export function isBackendsContextSpec(contextSpec) {
  const normalized = normalizeContextSpec(contextSpec);
  return normalized === BACKENDS_ROOT_CONTEXT || normalized?.startsWith(`${BACKENDS_ROOT_CONTEXT}/`) || false;
}

export function shouldExcludeBackends(contextSpec, includeBackends = false) {
  if (includeBackends) { return false; }
  const normalized = normalizeContextSpec(contextSpec);
  return normalized === null || normalized === '/' || normalized === '';
}

/**
 * Normalize a path for use within the directory tree's /.backends folder.
 * Ensures the returned path is prefixed with /.backends.
 */
export function normalizeBackendsTreePath(pathOrContext) {
  const normalized = normalizeContextSpec(pathOrContext);
  if (normalized === null || normalized === '/') { return BACKENDS_ROOT_CONTEXT; }
  // Already prefixed — return as-is
  if (normalized === BACKENDS_ROOT_CONTEXT || normalized.startsWith(`${BACKENDS_ROOT_CONTEXT}/`)) {
    return normalized;
  }
  // Prefix with /.backends
  return `${BACKENDS_ROOT_CONTEXT}${normalized}`;
}

function buildBackendContext(driver, ...segments) {
  const normalizedSegments = segments
    .map((segment) => normalizeSegment(segment))
    .filter(Boolean);

  return `${BACKENDS_ROOT_CONTEXT}/${normalizeSegment(driver)}/${normalizedSegments.join('/')}`;
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
