import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { MenuTreeView } from './MenuTreeView'
import type { Context, TreeNode, LayerMetadata } from '../../lib/types'
import {
  getContext, getContextTree, setContextUrl,
  insertContextPath, removeContextPath, updateContextPath,
  moveContextPath, copyContextPath, mergeContextLayer, subtractContextLayer,
} from '../../lib/api'

interface BoundContextTreeProps {
  serverUrl: string
  token: string
  contextId: string
}

// Desktop twin of the web ContextM2Detail: click a node to stage a path, then
// commit it as the context URL (workspace://path).
export function BoundContextTree({ serverUrl, token, contextId }: BoundContextTreeProps) {
  const [context, setContext] = useState<Context | null>(null)
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [url, setUrl] = useState('')
  const [selectedPath, setSelectedPath] = useState('/')
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [isLoadingTree, setIsLoadingTree] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const c = useMemo(() => ({ serverUrl, token, id: contextId }), [serverUrl, token, contextId])

  const loadTree = useCallback(async () => {
    setIsLoadingTree(true)
    try { setTree(await getContextTree(serverUrl, token, contextId)) }
    catch { /* tree unavailable — workspace may be inactive */ }
    finally { setIsLoadingTree(false) }
  }, [serverUrl, token, contextId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const ctx = await getContext(serverUrl, token, contextId)
        if (cancelled) return
        setContext(ctx)
        setUrl(ctx.url || '')
        setSelectedPath(ctx.path || '/')
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load context')
      }
      await loadTree()
    })()
    return () => { cancelled = true }
  }, [serverUrl, token, contextId, loadTree])

  const commitUrl = useCallback(async (newUrl: string, path?: string) => {
    setIsSaving(true); setError(null)
    try {
      const res = await setContextUrl(serverUrl, token, contextId, newUrl)
      setUrl(res?.url ?? newUrl)
      if (path) setSelectedPath(path)
      setPendingPath(null)
      await loadTree()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }, [serverUrl, token, contextId, loadTree])

  const handleConfirmPending = () => {
    if (!pendingPath) return
    const newUrl = context?.workspaceName
      ? `${context.workspaceName}://${pendingPath.replace(/^\//, '')}`
      : pendingPath
    commitUrl(newUrl, pendingPath)
  }

  // Context-tree operations (lock/destroy/createCanvas are workspace-only, so
  // they're intentionally absent — matching the web ContextM2Detail).
  const ops = useMemo(() => ({
    onInsertPath: async (path: string, auto = true) => { const r = await insertContextPath(c, path, auto); loadTree(); return r },
    onRemovePath: async (path: string, recursive = false) => { const r = await removeContextPath(c, path, recursive); loadTree(); return r },
    onRenamePath: async (from: string, newName: string) => {
      const parts = from.split('/'); parts[parts.length - 1] = newName
      const r = await moveContextPath(c, from, parts.join('/'), false); loadTree(); return r
    },
    onMovePath: async (from: string, to: string, recursive = false) => { const r = await moveContextPath(c, from, to, recursive); loadTree(); return r },
    onCopyPath: async (from: string, to: string, recursive = false) => { const r = await copyContextPath(c, from, to, recursive); loadTree(); return r },
    onUpdateNode: async (path: string, updates: { metadata?: LayerMetadata }) => updateContextPath(c, path, updates),
    onMergeLayer: async (layerId: string, targets: string[]) => { const r = await mergeContextLayer(c, layerId, targets); loadTree(); return r },
    onSubtractLayer: async (layerId: string, targets: string[]) => { const r = await subtractContextLayer(c, layerId, targets); loadTree(); return r },
  }), [c, loadTree])

  return (
    <div className="flex h-full flex-col">
      {/* URL editor */}
      <div className="shrink-0 border-b border-border p-2">
        <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Context URL</div>
        <div className="flex gap-2">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} className="h-7 font-mono text-xs" placeholder="workspace://path" />
          <Button size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={() => commitUrl(url)} disabled={isSaving}>{isSaving ? '…' : 'Set'}</Button>
        </div>
      </div>

      {/* Pending path confirmation */}
      {pendingPath && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-2 py-2">
          <span className="flex-1 truncate font-mono text-xs text-amber-700 dark:text-amber-400">{pendingPath}</span>
          <button type="button" onClick={handleConfirmPending} disabled={isSaving} className="flex shrink-0 items-center gap-1 rounded bg-amber-500 px-2 py-1 text-xs text-white hover:bg-amber-600 disabled:opacity-50">
            <Check className="h-3 w-3" /> Set
          </button>
          <button type="button" onClick={() => setPendingPath(null)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {context?.workspaceName || 'Workspace'} · context tree
        </div>
        <MenuTreeView
          root={tree}
          selectedPath={selectedPath}
          pendingPath={pendingPath}
          onSelect={setPendingPath}
          isLoading={isLoadingTree}
          rootLabel={context?.workspaceName}
          {...ops}
        />
      </div>

      {error && <div className="shrink-0 bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
    </div>
  )
}
