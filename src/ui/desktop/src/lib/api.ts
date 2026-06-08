// Minimal Canvas REST client. The server reflects any CORS origin, so the
// webview can fetch a user-configured server directly (no http plugin needed).
import type { Context, TreeNode } from './types'

export class ApiError extends Error {}

function base(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/rest/v2') ? trimmed : `${trimmed}/rest/v2`
}

export async function apiFetch<T>(
  serverUrl: string,
  token: string | undefined,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${base(serverUrl)}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(json?.message || `HTTP ${res.status}`)
  return (json?.payload ?? json) as T
}

// Reachability check (no auth) — returns the server version string.
export async function ping(serverUrl: string): Promise<string> {
  const res = await apiFetch<{ version?: string; appName?: string }>(serverUrl, undefined, '/ping')
  return res?.version ? `v${res.version}` : 'reachable'
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export async function login(serverUrl: string, email: string, password: string): Promise<string> {
  const payload = await apiFetch<{ token?: string; payload?: { token: string } }>(
    serverUrl, undefined, '/auth/login',
    { method: 'POST', body: JSON.stringify({ email, password, strategy: 'auto' }) },
  )
  const token = payload.token ?? payload.payload?.token
  if (!token) throw new ApiError('Login response missing token')
  return token
}

// Validates a token (password- or app-token) by hitting /auth/me.
export async function verifyToken(serverUrl: string, token: string): Promise<boolean> {
  try {
    await apiFetch(serverUrl, token, '/auth/me')
    return true
  } catch {
    return false
  }
}

// ── Contexts ───────────────────────────────────────────────────────────────

export function listContexts(serverUrl: string, token: string): Promise<Context[]> {
  return apiFetch<Context[]>(serverUrl, token, '/contexts')
}

export function getContext(serverUrl: string, token: string, id: string): Promise<Context> {
  return apiFetch<Context>(serverUrl, token, `/contexts/${id}`)
}

export function getContextTree(serverUrl: string, token: string, id: string): Promise<TreeNode> {
  return apiFetch<TreeNode>(serverUrl, token, `/contexts/${id}/tree`)
}

// ── Context tree path / layer operations (mirror web services/context.ts) ─────

type Ctx = { serverUrl: string; token: string; id: string }

export function insertContextPath(c: Ctx, path: string, autoCreateLayers = true): Promise<boolean> {
  return apiFetch(c.serverUrl, c.token, `/contexts/${c.id}/tree/paths`, { method: 'POST', body: JSON.stringify({ path, autoCreateLayers }) }).then((p) => (p ?? true) as boolean)
}

export function removeContextPath(c: Ctx, path: string, recursive = false): Promise<boolean> {
  const qs = new URLSearchParams({ path, recursive: String(recursive) })
  return apiFetch(c.serverUrl, c.token, `/contexts/${c.id}/tree/paths?${qs}`, { method: 'DELETE' }).then((p) => (p ?? true) as boolean)
}

export function updateContextPath(c: Ctx, path: string, updates: Record<string, unknown>): Promise<boolean> {
  return apiFetch(c.serverUrl, c.token, `/contexts/${c.id}/tree/paths`, { method: 'PATCH', body: JSON.stringify({ path, ...updates }) }).then((p) => (p ?? true) as boolean)
}

export function moveContextPath(c: Ctx, from: string, to: string, recursive = false): Promise<boolean> {
  return apiFetch(c.serverUrl, c.token, `/contexts/${c.id}/tree/paths/move`, { method: 'POST', body: JSON.stringify({ from, to, recursive }) }).then((p) => (p ?? true) as boolean)
}

export function copyContextPath(c: Ctx, from: string, to: string, recursive = false): Promise<boolean> {
  return apiFetch(c.serverUrl, c.token, `/contexts/${c.id}/tree/paths/copy`, { method: 'POST', body: JSON.stringify({ from, to, recursive }) }).then((p) => (p ?? true) as boolean)
}

export function mergeContextLayer(c: Ctx, layerId: string, targetLayers: string[]): Promise<unknown> {
  return apiFetch(c.serverUrl, c.token, `/contexts/${c.id}/tree/layers/merge`, { method: 'POST', body: JSON.stringify({ layerId, targetLayers }) })
}

export function subtractContextLayer(c: Ctx, layerId: string, targetLayers: string[]): Promise<unknown> {
  return apiFetch(c.serverUrl, c.token, `/contexts/${c.id}/tree/layers/subtract`, { method: 'POST', body: JSON.stringify({ layerId, targetLayers }) })
}

export function getContextUrl(serverUrl: string, token: string, id: string): Promise<{ url: string }> {
  return apiFetch<{ url: string }>(serverUrl, token, `/contexts/${id}/url`)
}

export function setContextUrl(serverUrl: string, token: string, id: string, url: string): Promise<{ url: string }> {
  return apiFetch<{ url: string }>(serverUrl, token, `/contexts/${id}/url`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}
