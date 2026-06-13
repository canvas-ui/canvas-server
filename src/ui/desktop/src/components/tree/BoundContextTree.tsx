import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { Input } from '../ui/input'
import { MenuTreeView } from './MenuTreeView'
import type { Context, TreeNode } from '../../lib/types'
import { contextUrlToPath, pathToContextUrl } from '../../lib/context-url'
import { flattenTree, moveHighlight } from '../../lib/tree-flat'
import { getContext, getContextTree, setContextUrl } from '../../lib/api'

interface BoundContextTreeProps {
  serverUrl: string
  token: string
  contextId: string
  focusSignal?: number
}

export function BoundContextTree({ serverUrl, token, contextId, focusSignal = 0 }: BoundContextTreeProps) {
  const [context, setContext] = useState<Context | null>(null)
  const [tree, setTree] = useState<TreeNode | null>(null)
  const [selectedPath, setSelectedPath] = useState('/')
  const [highlightPath, setHighlightPath] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [isLoadingTree, setIsLoadingTree] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const flatPaths = useMemo(() => flattenTree(tree, search), [tree, search])

  const loadTree = useCallback(async () => {
    setIsLoadingTree(true)
    try { setTree(await getContextTree(serverUrl, token, contextId)) }
    catch { setTree(null) }
    finally { setIsLoadingTree(false) }
  }, [serverUrl, token, contextId])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const ctx = await getContext(serverUrl, token, contextId)
        if (cancelled) return
        setContext(ctx)
        const path = contextUrlToPath(ctx.url || '', ctx.workspaceName)
        setSelectedPath(path)
        setHighlightPath(path)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load context')
      }
      await loadTree()
    })()
    return () => { cancelled = true }
  }, [serverUrl, token, contextId, loadTree])

  useEffect(() => {
    if (focusSignal > 0) searchRef.current?.focus()
  }, [focusSignal])

  const switchPath = useCallback(async (path: string) => {
    if (!context || path === selectedPath || isSaving) return
    const newUrl = pathToContextUrl(path, context.workspaceName)
    setIsSaving(true)
    setError(null)
    try {
      const res = await setContextUrl(serverUrl, token, contextId, newUrl)
      const active = contextUrlToPath(res?.url ?? newUrl, context.workspaceName)
      setSelectedPath(active)
      setHighlightPath(active)
      setContext((c) => (c ? { ...c, url: res?.url ?? newUrl, path: active } : c))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to switch context path')
    } finally {
      setIsSaving(false)
    }
  }, [context, contextId, isSaving, selectedPath, serverUrl, token])

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightPath((h) => moveHighlight(flatPaths, h, 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightPath((h) => moveHighlight(flatPaths, h, -1))
    } else if (e.key === 'Enter' && highlightPath) {
      e.preventDefault()
      switchPath(highlightPath)
    }
  }

  // Stable identity so memoized tree nodes don't re-render on every keystroke.
  const onSelect = useCallback((path: string) => {
    setHighlightPath(path)
    switchPath(path)
  }, [switchPath])

  const header = useMemo(() => {
    const ws = context?.workspaceName || 'workspace'
    return `${contextId} · ${ws}`
  }, [context?.workspaceName, contextId])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <div className="truncate text-sm font-semibold" title={header}>{header}</div>
        <div className="truncate font-mono text-xs text-muted-foreground" title={selectedPath}>
          {isSaving ? (
            <span className="inline-flex items-center gap-1.5 text-secondary">
              <Loader2 className="h-3 w-3 animate-spin" /> Switching…
            </span>
          ) : selectedPath}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setHighlightPath((h) => h ?? selectedPath)
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search tree… (↑↓ Enter)"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <MenuTreeView
          root={tree}
          selectedPath={selectedPath}
          highlightPath={highlightPath}
          onSelect={onSelect}
          isLoading={isLoadingTree}
          readOnly
          searchQuery={search}
          rootLabel={context?.workspaceName}
        />
      </div>

      {error && (
        <div className="shrink-0 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">{error}</div>
      )}
    </div>
  )
}
