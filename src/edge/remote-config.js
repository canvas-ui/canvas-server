'use strict';

import fs from 'node:fs';
import path from 'node:path';

/**
 * Remote registration config, stored in the workspace's own workspace.json —
 * a workspace is meant to be self-describing, and its remotes travel with it:
 *
 *   "remotes": [
 *     { "url": "https://my.cnvs.ai", "token": "canvas-…", "enabled": true }
 *   ]
 *
 * `token` is opaque to this module — today a user API token or device token
 * (both pass websocket auth); workspace-scoped share tokens can slot in later
 * without a config change. This module has no dependency on core/ on purpose:
 * the edge runtime reads workspace.json directly.
 */

export function workspaceConfigPath(dir) {
  return path.join(dir, 'workspace.json');
}

export function readWorkspaceConfig(dir) {
  const file = workspaceConfigPath(dir);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

export function listRemotes(config = {}) {
  const remotes = Array.isArray(config.remotes) ? config.remotes : [];
  return remotes
    .filter((remote) => remote && typeof remote.url === 'string' && typeof remote.token === 'string')
    .map((remote) => ({
      url: remote.url.replace(/\/+$/, ''),
      token: remote.token,
      enabled: remote.enabled !== false,
    }));
}

/** Add or update (matched by url) a remote entry, persisting workspace.json. */
export function saveRemote(dir, { url, token, enabled = true }) {
  if (!url || !token) throw new Error('remote requires url and token');
  const file = workspaceConfigPath(dir);
  const config = readWorkspaceConfig(dir);
  const normalizedUrl = url.replace(/\/+$/, '');
  const remotes = Array.isArray(config.remotes) ? config.remotes : [];
  const existing = remotes.find((remote) => remote?.url?.replace(/\/+$/, '') === normalizedUrl);
  if (existing) {
    existing.url = normalizedUrl;
    existing.token = token;
    existing.enabled = enabled;
  } else {
    remotes.push({ url: normalizedUrl, token, enabled });
  }
  config.remotes = remotes;
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return config;
}

export function removeRemote(dir, url) {
  const file = workspaceConfigPath(dir);
  const config = readWorkspaceConfig(dir);
  const normalizedUrl = url.replace(/\/+$/, '');
  const before = Array.isArray(config.remotes) ? config.remotes : [];
  config.remotes = before.filter((remote) => remote?.url?.replace(/\/+$/, '') !== normalizedUrl);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return before.length !== config.remotes.length;
}
