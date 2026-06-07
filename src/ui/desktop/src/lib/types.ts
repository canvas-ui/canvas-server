// Opaque metadata blob; layer styling lives in metadata.ui = { icon, color }.
export type LayerMetadata = Record<string, unknown>

// Mirrors the web's TreeNode (src/ui/web/src/types/workspace.ts).
export interface TreeNode {
  id: string
  type: string
  name: string
  label: string
  description: string
  color: string | null
  locked?: boolean
  lockedBy?: string[]
  metadata?: LayerMetadata
  children: TreeNode[]
}

export interface Context {
  id: string
  url?: string
  path?: string
  baseUrl?: string
  workspaceName?: string
  color?: string | null
}
