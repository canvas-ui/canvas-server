/**
 * Per-layer visual styling (icon + color), stored entirely in
 * `metadata.ui = { icon, color }`. Icon is an Iconify name string
 * (e.g. "ph:folder-fill"). Icon SVGs are fetched on-demand by <Icon/> from
 * the Iconify API; the picker's name list is fetched once and cached below.
 */
import type { LayerMetadata } from './types'

// Lazily fetch Phosphor's full icon catalog (~9k names), keeping only the
// fill weight. Cached after the first call so the picker pays the cost once.
let fillIconsPromise: Promise<string[]> | null = null
export function loadPhosphorFillIcons(): Promise<string[]> {
  if (!fillIconsPromise) {
    fillIconsPromise = fetch('https://api.iconify.design/collection?prefix=ph')
      .then((r) => r.json())
      .then((data: { uncategorized?: string[]; categories?: Record<string, string[]> }) => {
        const names = [
          ...(data.uncategorized ?? []),
          ...Object.values(data.categories ?? {}).flat(),
        ]
        return names.filter((n) => n.endsWith('-fill')).map((n) => `ph:${n}`)
      })
      .catch(() => {
        fillIconsPromise = null // allow retry on next open after a failed fetch
        return []
      })
  }
  return fillIconsPromise
}

// Search the whole Iconify catalog (all collections) on demand. Keeps the
// bundle slim — only matching names are fetched, SVGs still lazy-load.
export async function searchIcons(query: string, limit = 120): Promise<string[]> {
  const q = query.trim()
  if (!q) return []
  try {
    const r = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=${limit}`)
    const data: { icons?: string[] } = await r.json()
    return Array.isArray(data.icons) ? data.icons : []
  } catch {
    return []
  }
}

export const DEFAULT_FOLDER_ICON = 'ph:folder-fill'
export const DEFAULT_CANVAS_ICON = 'ph:squares-four-fill'
export const DEFAULT_WORKSPACE_ICON = 'ph:stack-fill'

// A small, friendly swatch palette for layer colors.
export const LAYER_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#3b82f6', '#6366f1', '#8b5cf6', '#a855f7',
  '#ec4899', '#f43f5e', '#64748b', '#78716c',
]

export interface LayerStyle {
  icon?: string
  color?: string
}

type StyledNode = { metadata?: LayerMetadata; color?: string | null }

/** Read the effective icon/color for a node (color field is a legacy fallback). */
export function getLayerStyle(node: StyledNode): LayerStyle {
  const ui = (node.metadata?.ui ?? {}) as LayerStyle
  return {
    icon: typeof ui.icon === 'string' ? ui.icon : undefined,
    color: typeof ui.color === 'string' ? ui.color : (node.color ?? undefined),
  }
}

/**
 * Merge a style change into existing metadata and return the FULL metadata
 * object — the backend replaces `metadata` wholesale (Object.assign), so we
 * must send everything we want to keep.
 */
export function mergeLayerStyle(metadata: LayerMetadata | undefined, change: LayerStyle): LayerMetadata {
  const md = { ...(metadata ?? {}) } as Record<string, unknown>
  const ui = { ...((md.ui as Record<string, unknown>) ?? {}) }
  if ('icon' in change) { if (change.icon) ui.icon = change.icon; else delete ui.icon }
  if ('color' in change) { if (change.color) ui.color = change.color; else delete ui.color }
  md.ui = ui
  return md as LayerMetadata
}
