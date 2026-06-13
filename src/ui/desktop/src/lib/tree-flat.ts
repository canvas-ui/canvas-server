import type { TreeNode } from './types'

function buildPath(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

function nodeMatches(node: TreeNode, path: string, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return path.toLowerCase().includes(q) || (node.label || node.name || '').toLowerCase().includes(q)
}

function subtreeMatches(node: TreeNode, parentPath: string, query: string): boolean {
  const path = buildPath(parentPath, node.name)
  if (!query) return true
  if (nodeMatches(node, path, query)) return true
  return node.children?.some((c) => subtreeMatches(c, path, query)) ?? false
}

/** DFS list of navigable paths (respects search filter). */
export function flattenTree(root: TreeNode | null, searchQuery = ''): string[] {
  if (!root) return []
  const q = searchQuery.trim().toLowerCase()
  const paths: string[] = ['/']

  const walk = (nodes: TreeNode[], parentPath: string) => {
    for (const node of nodes) {
      const path = buildPath(parentPath, node.name)
      if (q && !subtreeMatches(node, parentPath, q)) continue
      paths.push(path)
      if (node.children?.length) walk(node.children, path)
    }
  }
  walk(root.children ?? [], '/')
  return paths
}

export function moveHighlight(paths: string[], current: string | null, delta: number): string | null {
  if (!paths.length) return null
  const idx = current ? paths.indexOf(current) : -1
  const next = idx < 0 ? (delta > 0 ? 0 : paths.length - 1) : Math.max(0, Math.min(paths.length - 1, idx + delta))
  return paths[next] ?? null
}
