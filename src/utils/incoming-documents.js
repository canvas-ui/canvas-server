'use strict';

export const INCOMING_ROOT_CONTEXT = '/.incoming';
export const DIRECTORY_TREE_NAME = 'directory';

function normalizeSegment(value, fallback = 'unknown') {
  const segment = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^-+|-+$/g, '');

  const parts = segment.split('/').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join('/') : fallback;
}

function normalizeContextSpec(contextSpec) {
  if (contextSpec === null || contextSpec === undefined) { return null; }
  const value = String(contextSpec).trim();
  if (!value || value === '/') { return '/'; }
  return `/${value.replace(/^\/+/, '').replace(/\/+/g, '/')}`.replace(/\/$/, '');
}

export function isIncomingContextSpec(contextSpec) {
  const normalized = normalizeContextSpec(contextSpec);
  return normalized === INCOMING_ROOT_CONTEXT || normalized?.startsWith(`${INCOMING_ROOT_CONTEXT}/`) || false;
}

export function shouldExcludeIncoming(contextSpec, includeIncoming = false) {
  if (includeIncoming) { return false; }
  const normalized = normalizeContextSpec(contextSpec);
  return normalized === null || normalized === '/' || normalized === '';
}

/**
 * Normalize a path for use within the directory tree's /.incoming folder.
 * Ensures the returned path is prefixed with /.incoming.
 */
export function normalizeIncomingTreePath(pathOrContext) {
  const normalized = normalizeContextSpec(pathOrContext);
  if (normalized === null || normalized === '/') { return INCOMING_ROOT_CONTEXT; }
  // Already prefixed — return as-is
  if (normalized === INCOMING_ROOT_CONTEXT || normalized.startsWith(`${INCOMING_ROOT_CONTEXT}/`)) {
    return normalized;
  }
  // Prefix with /.incoming
  return `${INCOMING_ROOT_CONTEXT}${normalized}`;
}

function buildIncomingContext(kind, ...segments) {
  const normalizedSegments = segments
    .map((segment) => normalizeSegment(segment))
    .filter(Boolean);

  return `${INCOMING_ROOT_CONTEXT}/${kind}/${normalizedSegments.join('/')}`;
}

export function getIncomingEmailContext(provider, accountId, folderName = 'inbox') {
  return buildIncomingContext('email', provider, accountId, folderName);
}

export function getIncomingMessageContext(provider, accountId, channelName) {
  return buildIncomingContext('message', provider, accountId, channelName);
}

export function getIncomingFileContext(provider, accountId, containerName = null, objectPath = null) {
  const segments = [provider, accountId];
  if (containerName != null) { segments.push(containerName); }
  if (objectPath != null) { segments.push(objectPath); }
  return buildIncomingContext('file', ...segments);
}

function filePathDirname(filePath) {
  if (!filePath) return null;
  const normalized = String(filePath).replace(/\\/g, '/').replace(/^\/+/, '');
  const lastSlash = normalized.lastIndexOf('/');
  return lastSlash > 0 ? normalized.slice(0, lastSlash) : null;
}

export function getIncomingFileContextFromStoredLocation(location = {}) {
  const source = location?.source || {};
  const dirPath = filePathDirname(source.path || location.key || null);
  return getIncomingFileContext(
    source.provider || location.driver || location.backend || 'unknown',
    source.account || location.backend || 'default',
    source.container || null,
    dirPath,
  );
}
