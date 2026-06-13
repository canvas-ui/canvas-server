/**
 * MenuTreeView — card-style tree for M2 panels.
 * Supports full tree operations via context-menu: new folder (inline),
 * rename, remove, copy/cut/paste, lock/unlock layer, show layer content,
 * merge/subtract layers. Ctrl/⌘-click to multi-select source + targets.
 */
import { useState, useCallback, useRef, useEffect, memo } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronRight, ChevronDown,
  Plus, Trash2, Edit2, Copy, Scissors, Clipboard,
  Layers, LayoutDashboard, MoreHorizontal, Lock, Unlock, Eye, Share2, Palette,
} from 'lucide-react'
import { Icon } from '@iconify/react'
import { cn } from '../../lib/utils'
import type { TreeNode, LayerMetadata } from '../../lib/types'
import {
  getLayerStyle, mergeLayerStyle, DEFAULT_FOLDER_ICON, DEFAULT_CANVAS_ICON,
  type LayerStyle,
} from '../../lib/layer-style'
import { LayerIconPicker } from './LayerIconPicker'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MenuTreeViewProps {
  root: TreeNode | null
  treeName?: string
  selectedPath: string
  pendingPath?: string | null
  highlightPath?: string | null
  onSelect: (path: string) => void
  isLoading?: boolean
  readOnly?: boolean
  rootLabel?: string
  contentPath?: string | null
  onShowContent?: (path: string) => void
  onOpenToSide?: (path: string, treeName: string) => void
  onInsertPath?: (path: string, autoCreateLayers?: boolean) => Promise<boolean>
  onCreateCanvas?: (path: string) => Promise<boolean>
  onRemovePath?: (path: string, recursive?: boolean) => Promise<boolean>
  onRenamePath?: (fromPath: string, newName: string) => Promise<boolean>
  onMovePath?: (from: string, to: string, recursive?: boolean, sourceTreeName?: string, targetTreeName?: string) => Promise<boolean>
  onCopyPath?: (from: string, to: string, recursive?: boolean, sourceTreeName?: string, targetTreeName?: string) => Promise<boolean>
  onShareCanvas?: (path: string) => Promise<void>
  onLockLayer?: (layerId: string) => Promise<boolean>
  onUnlockLayer?: (layerId: string) => Promise<boolean>
  onDestroyLayer?: (layerId: string) => Promise<boolean>
  onMergeLayer?: (layerId: string, targetLayers: string[]) => Promise<unknown>
  onSubtractLayer?: (layerId: string, targetLayers: string[]) => Promise<unknown>
  onUpdateNode?: (path: string, updates: { metadata?: LayerMetadata }) => Promise<boolean>
  searchQuery?: string
  pastedDocumentIds?: number[]
  onPasteDocuments?: (path: string, documentIds: number[]) => Promise<boolean>
}

type ClipboardMode = 'copy' | 'cut'
type Clip = { mode: ClipboardMode; path: string; treeName: string }
type LayerRef = { path: string; id: string }

const TREE_BRANCH_GUTTER = 22

// ─── Context menu ─────────────────────────────────────────────────────────────

interface CtxMenuProps {
  x: number; y: number
  node: TreeNode
  path: string
  onClose: () => void
  onShowContent?: (path: string) => void
  onOpenToSide?: (path: string) => void
  sourceLayer: LayerRef | null
  targetLayers: Map<string, string>
  clipboard: Clip | null
  onStartInlineCreate: (parentPath: string, isCanvas?: boolean) => void
  onChangeIcon?: () => void
  hasCreateCanvas?: boolean
  onShareCanvas?: MenuTreeViewProps['onShareCanvas']
  onRemove?: MenuTreeViewProps['onRemovePath']
  onRename?: MenuTreeViewProps['onRenamePath']
  onLock?: MenuTreeViewProps['onLockLayer']
  onUnlock?: MenuTreeViewProps['onUnlockLayer']
  onDestroy?: MenuTreeViewProps['onDestroyLayer']
  onMerge?: MenuTreeViewProps['onMergeLayer']
  onSubtract?: MenuTreeViewProps['onSubtractLayer']
  onCopy: (path: string) => void
  onCut: (path: string) => void
  onPaste: (target: string) => Promise<void>
  pastedDocumentIds?: number[]
  onPasteDocuments?: (path: string, documentIds: number[]) => Promise<boolean>
}

function CtxMenu({
  x, y, node, path, onClose, onShowContent, onOpenToSide,
  sourceLayer, targetLayers, clipboard,
  onStartInlineCreate, onChangeIcon, hasCreateCanvas, onShareCanvas, onRemove, onRename,
  onLock, onUnlock, onDestroy, onMerge, onSubtract,
  onCopy, onCut, onPaste,
  pastedDocumentIds, onPasteDocuments,
}: CtxMenuProps) {

  const canMergeSubtract = sourceLayer && targetLayers.size > 0 && sourceLayer.path === path
  const hasLayerSel = sourceLayer && targetLayers.size > 0 && (
    sourceLayer.path === path || targetLayers.has(path)
  )

  const run = async (fn: () => Promise<void>) => {
    try { await fn() } catch (err) { alert(err instanceof Error ? err.message : String(err)) }
    onClose()
  }

  const item = (icon: React.ReactNode, label: string, fn: () => Promise<void>, danger = false) => (
    <button
      type="button"
      className={cn(
        'flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent rounded-sm text-left',
        danger && 'text-destructive hover:bg-destructive/10',
      )}
      onClick={() => run(fn)}
    >
      {icon}
      {label}
    </button>
  )

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 min-w-[11rem] overflow-hidden rounded-md border bg-popover p-1 shadow-lg"
        style={{ left: x, top: y }}
      >
        {/* Show layer content — workspace tree only */}
        {onShowContent && item(<Eye className="w-3 h-3" />, 'Show layer content', async () => {
          onShowContent(path)
        })}
        {onOpenToSide && item(<Eye className="w-3 h-3" />, 'Open to the side', async () => {
          onOpenToSide(path)
        })}

        {(onShowContent || onOpenToSide) && <div className="my-1 h-px bg-border" />}

        {node.type === 'canvas' && onShareCanvas && item(
          <Share2 className="w-3 h-3" />,
          'Share canvas',
          async () => { await onShareCanvas(path) },
        )}

        {node.type === 'canvas' && onShareCanvas && <div className="my-1 h-px bg-border" />}

        {/* New folder — inline */}
        <button
          type="button"
          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent rounded-sm text-left"
          onClick={() => { onStartInlineCreate(path, false); onClose() }}
        >
          <Plus className="w-3 h-3" />
          New folder here
        </button>

        {/* New canvas — inline, workspace trees only */}
        {hasCreateCanvas && (
          <button
            type="button"
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent rounded-sm text-left"
            onClick={() => { onStartInlineCreate(path, true); onClose() }}
          >
            <LayoutDashboard className="w-3 h-3 text-violet-500" />
            New canvas here
          </button>
        )}

        {path !== '/' && onChangeIcon && (
          <button
            type="button"
            className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent rounded-sm text-left"
            onClick={() => { onChangeIcon(); onClose() }}
          >
            <Palette className="w-3 h-3" />
            Change icon
          </button>
        )}

        {path !== '/' && !node.locked && onRename && item(<Edit2 className="w-3 h-3" />, 'Rename', async () => {
          const cur = path.split('/').pop() || ''
          const n = prompt('New name:', cur)
          if (!n || n === cur) return
          await onRename(path, n)
        })}

        <div className="my-1 h-px bg-border" />

        {/* Clipboard */}
        {item(<Copy className="w-3 h-3" />, 'Copy', async () => onCopy(path))}
        {item(<Scissors className="w-3 h-3" />, 'Cut', async () => onCut(path))}
        {clipboard && item(
          <Clipboard className="w-3 h-3" />,
          `Paste (${clipboard.mode})`,
          async () => onPaste(path),
        )}
        {pastedDocumentIds && pastedDocumentIds.length > 0 && onPasteDocuments && item(
          <Clipboard className="w-3 h-3" />,
          `Paste ${pastedDocumentIds.length} document(s)`,
          async () => { await onPasteDocuments(path, pastedDocumentIds) },
        )}

        {/* Remove — disabled for locked layers */}
        {path !== '/' && !node.locked && onRemove && (
          <>
            <div className="my-1 h-px bg-border" />
            {item(<Trash2 className="w-3 h-3" />, 'Remove', async () => {
              if (confirm(`Remove "${path}"?`)) await onRemove(path, false)
            }, true)}
            {item(<Trash2 className="w-3 h-3" />, 'Remove recursive', async () => {
              if (confirm(`Remove "${path}" and all children?`)) await onRemove(path, true)
            }, true)}
          </>
        )}

        {/* Lock / unlock / destroy */}
        {(onLock || onUnlock || onDestroy) && (
          <>
            <div className="my-1 h-px bg-border" />
            {node.locked
              ? (onUnlock && item(<Unlock className="w-3 h-3" />, 'Unlock layer', async () => {
                  await onUnlock(node.id)
                }))
              : (onLock && item(<Lock className="w-3 h-3" />, 'Lock layer', async () => {
                  await onLock(node.id)
                }))
            }
            {path !== '/' && !node.locked && onDestroy && item(
              <Trash2 className="w-3 h-3" />, 'Destroy layer', async () => {
                if (confirm(`Permanently destroy layer "${node.label || node.name}" and its bitmap?`))
                  await onDestroy(node.id)
              }, true
            )}
          </>
        )}

        {/* Layer: merge / subtract */}
        {canMergeSubtract && (
          <>
            <div className="my-1 h-px bg-border" />
            {onMerge && item(<Layers className="w-3 h-3" />, 'Merge into targets', async () => {
              const tgtIds = Array.from(targetLayers.values())
              await onMerge(node.id, tgtIds)
            })}
            {onSubtract && item(<Layers className="w-3 h-3" />, 'Subtract from targets', async () => {
              const tgtIds = Array.from(targetLayers.values())
              await onSubtract(node.id, tgtIds)
            })}
          </>
        )}

        {hasLayerSel && !canMergeSubtract && (
          <>
            <div className="my-1 h-px bg-border" />
            <div className="px-3 py-1.5 text-[10px] text-muted-foreground italic">
              Right-click the source layer to merge/subtract
            </div>
          </>
        )}

      </div>
    </>, document.body
  )
}
// ─── Inline create input ──────────────────────────────────────────────────────

interface InlineCreateProps {
  onConfirm: (name: string) => void
  onCancel: () => void
  placeholder?: string
}

function InlineCreateInput({ onConfirm, onCancel, placeholder = 'folder name…' }: InlineCreateProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const commit = () => {
    const val = inputRef.current?.value.trim() ?? ''
    if (val) onConfirm(val)
    else onCancel()
  }

  return (
    <div className="flex min-h-10 items-center gap-2 rounded-md px-3 py-2 bg-card ring-1 ring-primary/50 shadow-lg text-sm font-medium">
      <ChevronRight className="w-4 h-4 opacity-0 shrink-0" />
      <input
        ref={inputRef}
        className="flex-1 bg-transparent outline-none min-w-0 text-sm font-medium placeholder:font-normal placeholder:text-muted-foreground"
        placeholder={placeholder}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={commit}
      />
    </div>
  )
}

// ─── Tree node card ───────────────────────────────────────────────────────────

function buildPath(parent: string, name: string) {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

function nodeMatchesSearch(node: TreeNode, parentPath: string, query: string): boolean {
  const path = buildPath(parentPath, node.name)
  if (path.toLowerCase().includes(query) || (node.label || '').toLowerCase().includes(query)) return true
  return node.children?.some(c => nodeMatchesSearch(c, path, query)) ?? false
}

interface CardNodeProps {
  node: TreeNode
  parentPath: string
  depth: number
  isLast: boolean
  selectedPath: string
  pendingPath?: string | null
  contentPath?: string | null
  readOnly: boolean
  sourceLayer: LayerRef | null
  targetLayers: Map<string, string>
  clipboard: Clip | null
  searchQuery: string
  inlineCreateParent: string | null
  inlineCreateIsCanvas: boolean
  onSelect: (path: string) => void
  onShowContent?: (path: string) => void
  onCtrl: (path: string, id: string) => void
  onCtxMenu: (e: React.MouseEvent, path: string, node: TreeNode) => void
  onConfirmCreate: (parentPath: string, name: string) => void
  onCancelCreate: () => void
  onOpenPicker?: (e: React.MouseEvent, path: string, node: TreeNode) => void
  styleOverrides: Map<string, LayerStyle>
  // Drag-and-drop
  dragOverPath: string | null
  isCopyDrag: boolean
  onDragStart: (path: string, e: React.DragEvent) => void
  onDragEnter: (path: string, e: React.DragEvent) => void
  onDragOver: (path: string, e: React.DragEvent) => void
  onDragLeave: (path: string, e: React.DragEvent) => void
  onDragEnd: () => void
  onDrop: (path: string, e: React.DragEvent) => void
}

const CardNode = memo(function CardNode({
  node, parentPath, depth, isLast, selectedPath, pendingPath, contentPath, readOnly,
  sourceLayer, targetLayers, clipboard, searchQuery,
  inlineCreateParent, inlineCreateIsCanvas,
  onSelect, onShowContent, onCtrl, onCtxMenu,
  onConfirmCreate, onCancelCreate, onOpenPicker, styleOverrides,
  dragOverPath, isCopyDrag, onDragStart, onDragEnter, onDragOver, onDragLeave, onDragEnd, onDrop,
}: CardNodeProps) {

  const path = buildPath(parentPath, node.name)
  const style = styleOverrides.get(path) ?? getLayerStyle(node)

  const [expanded, setExpanded] = useState(() =>
    selectedPath !== '/' && (selectedPath === path || selectedPath.startsWith(path + '/'))
  )

  if (searchQuery && !nodeMatchesSearch(node, parentPath, searchQuery)) return null

  // Auto-expand when inline create targets this node
  const shouldExpand = expanded || inlineCreateParent === path || (searchQuery.length > 0)

  const hasChildren = node.children && node.children.length > 0
  const isSelected = selectedPath === path
  const isPending = pendingPath === path
  const cardShadow = readOnly ? 'border border-border/60 shadow-overlay' : 'shadow-lg hover:shadow-xl'

  const isSource = sourceLayer?.path === path
  const isTarget = targetLayers.has(path)
  const isCanvas = node.type === 'canvas'

  const handleClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) { onCtrl(path, node.id); return }
    onSelect(path)
  }

  return (
    <div className="relative">
      <div
        className="pointer-events-none absolute top-0 w-px bg-border"
        style={{
          left: `-${TREE_BRANCH_GUTTER / 2}px`,
          bottom: isLast ? '50%' : 0,
        }}
      />
      <div
        className="pointer-events-none absolute top-5 h-px bg-border"
        style={{
          left: `-${TREE_BRANCH_GUTTER / 2}px`,
          width: `${TREE_BRANCH_GUTTER / 2}px`,
        }}
      />

      <div
        data-tree-path={path}
        className={cn(
          'group relative flex min-h-10 items-center gap-2 rounded-md px-3 py-2 cursor-pointer transition-colors select-none overflow-hidden text-sm',
          cardShadow,
          'before:absolute before:left-0 before:top-0 before:bottom-0 before:w-1.5 before:transition-colors',
          isSource && 'ring-1 ring-blue-500/40 bg-blue-500/10 before:bg-blue-500',
          isTarget && !isSource && 'ring-1 ring-amber-500/40 bg-amber-500/10 before:bg-amber-500',
          !isSource && !isTarget && isSelected && !node.locked && 'bg-primary/[0.08] hover:bg-primary/[0.12] before:bg-primary',
          !isSource && !isTarget && isSelected && node.locked && 'bg-amber-500/15 hover:bg-amber-500/20 before:bg-primary',
          !isSource && !isTarget && !isSelected && isPending && 'bg-primary/[0.03] before:bg-transparent',
          !isSource && !isTarget && !isSelected && !isPending && !node.locked && 'bg-card hover:bg-primary/[0.04] before:bg-transparent',
          !isSource && !isTarget && !isSelected && node.locked && 'bg-amber-500/15 hover:bg-amber-500/20 before:bg-amber-500',
          dragOverPath === path && !readOnly && !isCopyDrag && 'ring-2 ring-blue-400 bg-blue-50/50',
          dragOverPath === path && !readOnly && isCopyDrag && 'ring-2 ring-emerald-500 bg-emerald-50/50',
        )}
        style={{ borderRight: style.color ? `4px solid ${style.color}` : '4px solid transparent' }}
        draggable={!readOnly}
        onClick={handleClick}
        onContextMenu={e => { if (!readOnly) { e.preventDefault(); onCtxMenu(e, path, node) } }}
        onDragStart={e => { if (!readOnly) onDragStart(path, e) }}
        onDragEnter={e => { if (!readOnly) onDragEnter(path, e) }}
        onDragOver={e => { if (!readOnly) onDragOver(path, e) }}
        onDragLeave={e => onDragLeave(path, e)}
        onDragEnd={() => onDragEnd()}
        onDrop={e => { if (!readOnly) onDrop(path, e) }}
      >
        <button
          type="button"
          className={cn('shrink-0 text-muted-foreground hover:text-foreground', !hasChildren && inlineCreateParent !== path && 'invisible')}
          onClick={e => { e.stopPropagation(); setExpanded(v => !v) }}
        >
          {shouldExpand ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>

        {(() => {
          const iconEl = (
            <Icon
              icon={style.icon || (isCanvas ? DEFAULT_CANVAS_ICON : DEFAULT_FOLDER_ICON)}
              width={16}
              height={16}
              color={style.color || undefined}
              className={cn('shrink-0', !style.color && (isCanvas ? 'text-violet-500' : 'text-muted-foreground'))}
            />
          )
          return onOpenPicker ? (
            <button
              type="button"
              className="shrink-0 rounded p-0.5 -m-0.5 hover:bg-muted-foreground/10"
              title="Change icon"
              onClick={e => { e.stopPropagation(); onOpenPicker(e, path, node) }}
            >
              {iconEl}
            </button>
          ) : iconEl
        })()}

        <span
          className="flex-1 truncate font-medium"
          title={node.description || undefined}
        >
          {node.label || node.name}
        </span>

        {!readOnly && (
          <button
            type="button"
            className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-muted-foreground/10 text-muted-foreground"
            onClick={e => { e.stopPropagation(); onCtxMenu(e, path, node) }}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
        )}
      </div>

      {shouldExpand && (hasChildren || inlineCreateParent === path) && (
        <div className="ml-[22px] mt-2 mb-1 space-y-1.5">
          {inlineCreateParent === path && (
            <InlineCreateInput
              onConfirm={name => onConfirmCreate(path, name)}
              onCancel={onCancelCreate}
              placeholder={inlineCreateIsCanvas ? 'canvas name…' : undefined}
            />
          )}
          {node.children?.map((child, index) => (
            <CardNode
              key={child.id || child.name}
              node={child}
              parentPath={path}
              depth={depth + 1}
              isLast={index === (node.children?.length ?? 0) - 1}
              selectedPath={selectedPath}
              pendingPath={pendingPath}
              contentPath={contentPath}
              readOnly={readOnly}
              sourceLayer={sourceLayer}
              targetLayers={targetLayers}
              clipboard={clipboard}
              searchQuery={searchQuery}
              inlineCreateParent={inlineCreateParent}
              inlineCreateIsCanvas={inlineCreateIsCanvas}
              onSelect={onSelect}
              onShowContent={onShowContent}
              onCtrl={onCtrl}
              onCtxMenu={onCtxMenu}
              onConfirmCreate={onConfirmCreate}
              onCancelCreate={onCancelCreate}
              onOpenPicker={onOpenPicker}
              styleOverrides={styleOverrides}
              dragOverPath={dragOverPath}
              isCopyDrag={isCopyDrag}
              onDragStart={onDragStart}
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDragEnd={onDragEnd}
              onDrop={onDrop}
            />
          ))}
        </div>
      )}
    </div>
  )
})
// ─── Root ─────────────────────────────────────────────────────────────────────

export function MenuTreeView({
  root, treeName = 'context', selectedPath, pendingPath, highlightPath, onSelect, isLoading = false, readOnly = false,
  rootLabel, contentPath, onShowContent, onOpenToSide,
  onInsertPath, onCreateCanvas, onShareCanvas, onRemovePath, onRenamePath, onMovePath, onCopyPath,
  pastedDocumentIds, onPasteDocuments,
  onLockLayer, onUnlockLayer, onDestroyLayer, onMergeLayer, onSubtractLayer,
  onUpdateNode,
  searchQuery = '',
}: MenuTreeViewProps) {

  const [clipboard, setClipboard] = useState<Clip | null>(null)
  const [sourceLayer, setSourceLayer] = useState<LayerRef | null>(null)
  const [targetLayers, setTargetLayers] = useState<Map<string, string>>(new Map())
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; path: string; node: TreeNode } | null>(null)
  const [picker, setPicker] = useState<{ x: number; y: number; path: string; node: TreeNode } | null>(null)
  // Live style preview keyed by path; persistence is debounced. Cleared on
  // every tree refetch (root identity change) so server data takes over.
  const [styleOverrides, setStyleOverrides] = useState<Map<string, LayerStyle>>(new Map())
  const [prevRoot, setPrevRoot] = useState(root)
  const persistTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const containerRef = useRef<HTMLDivElement>(null)

  // Apply the keyboard highlight imperatively via the data-tree-path attribute.
  // Threading highlightPath through every node would re-render (and re-mount the
  // Iconify <Icon>s on) the whole tree on each arrow key — the source of the lag.
  useEffect(() => {
    const host = containerRef.current
    if (!host) return
    host.querySelector('.tree-row-active')?.classList.remove('tree-row-active')
    if (highlightPath) {
      const el = host.querySelector(`[data-tree-path="${CSS.escape(highlightPath)}"]`)
      el?.classList.add('tree-row-active')
      el?.scrollIntoView({ block: 'nearest' })
    }
  }, [highlightPath, root, searchQuery])

  // Drop optimistic style overrides once fresh server data arrives (root
  // identity changes on refetch). Reset-on-prop-change happens during render.
  if (root !== prevRoot) {
    setPrevRoot(root)
    setStyleOverrides(new Map())
  }
  const [inlineCreateParent, setInlineCreateParent] = useState<string | null>(null)
  const [inlineCreateIsCanvas, setInlineCreateIsCanvas] = useState(false)

  // ── Drag-and-drop state ───────────────────────────────────────────────────
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)
  const [isCopyDrag, setIsCopyDrag] = useState(false)
  const [copyModeSticky, setCopyModeSticky] = useState(false)
  const draggedPathRef = useRef<string | null>(null)
  const draggedTreeRef = useRef<string>(treeName)
  const isCopyRef = useRef(false)
  const copyModeStickyRef = useRef(false)

  useEffect(() => {
    const onClipboard = (event: Event) => {
      setClipboard((event as CustomEvent<Clip | null>).detail ?? null)
    }
    window.addEventListener('tree:path-clipboard', onClipboard)
    return () => window.removeEventListener('tree:path-clipboard', onClipboard)
  }, [])

  // Track ctrl/meta/alt globally — Firefox fires keydown/keyup during drag
  // (Chrome does not). Respect sticky toggle as the floor.
  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      const next = e.ctrlKey || e.altKey || copyModeStickyRef.current
      isCopyRef.current = next
      setIsCopyDrag(next)
    }
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
    }
  }, [])

  const isValidPathDrop = useCallback((src: string, tgt: string, isCopy: boolean): boolean => {
    if (draggedTreeRef.current !== treeName) return true
    const ns = src.endsWith('/') ? src.slice(0, -1) : src
    const nt = tgt.endsWith('/') ? tgt.slice(0, -1) : tgt
    const srcParent = ns.substring(0, ns.lastIndexOf('/')) || '/'
    if (nt.startsWith(ns + '/')) return false
    if (ns === nt) return false
    if (!isCopy && nt === srcParent) return false
    return true
  }, [treeName])

  const handleDragStart = useCallback((path: string, e: React.DragEvent) => {
    draggedPathRef.current = path
    draggedTreeRef.current = treeName
    e.dataTransfer.setData('text/plain', path)
    e.dataTransfer.setData('application/x-canvas-tree-path', JSON.stringify({ path, treeName }))
    e.dataTransfer.effectAllowed = 'copyMove'
  }, [treeName])

  const eventIsCopy = (e: React.DragEvent) =>
    e.ctrlKey || e.altKey || copyModeStickyRef.current

  const handleDragEnter = useCallback((path: string, e: React.DragEvent) => {
    const src = draggedPathRef.current
    const isCopy = eventIsCopy(e)
    if (isCopy !== isCopyRef.current) { isCopyRef.current = isCopy; setIsCopyDrag(isCopy) }
    if (src) {
      if (!isValidPathDrop(src, path, isCopy)) return
    }
    e.preventDefault()
    setDragOverPath(path)
  }, [isValidPathDrop])

  const handleDragOver = useCallback((path: string, e: React.DragEvent) => {
    const isCopy = eventIsCopy(e)
    if (isCopy !== isCopyRef.current) {
      isCopyRef.current = isCopy
      setIsCopyDrag(isCopy)
    }
    const src = draggedPathRef.current
    if (src) {
      if (!isValidPathDrop(src, path, isCopy)) {
        e.dataTransfer.dropEffect = 'none'
        return
      }
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = isCopy ? 'copy' : 'move'
  }, [isValidPathDrop])

  const handleDragLeave = useCallback((path: string, e: React.DragEvent) => {
    if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) {
      setDragOverPath(prev => prev === path ? null : prev)
    }
  }, [])

  const handleDragEnd = useCallback(() => {
    draggedPathRef.current = null
    draggedTreeRef.current = treeName
    isCopyRef.current = false
    setIsCopyDrag(false)
    setDragOverPath(null)
  }, [treeName])

  const handleDrop = useCallback(async (targetPath: string, e: React.DragEvent) => {
    e.preventDefault()
    const payload = (() => {
      try { return JSON.parse(e.dataTransfer.getData('application/x-canvas-tree-path')) as { path?: string; treeName?: string } }
      catch { return null }
    })()
    const src = payload?.path || e.dataTransfer.getData('text/plain')
    const sourceTreeName = payload?.treeName || draggedTreeRef.current || treeName
    const isCopy = eventIsCopy(e) || isCopyRef.current
    draggedPathRef.current = null
    draggedTreeRef.current = treeName
    isCopyRef.current = false
    setIsCopyDrag(false)
    setDragOverPath(null)
    if (!src) return
    const isRecursive = e.shiftKey
    const isCrossTree = sourceTreeName !== treeName
    if (!isCrossTree && src === targetPath) return
    if (!isCrossTree && !isValidPathDrop(src, targetPath, isCopy)) return
    try {
      if (isCopy && onCopyPath) {
        await onCopyPath(src, targetPath, isRecursive, sourceTreeName, treeName)
      } else if (!isCopy && onMovePath) {
        await onMovePath(src, targetPath, isRecursive, sourceTreeName, treeName)
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }, [isValidPathDrop, onCopyPath, onMovePath, treeName])

  const q = searchQuery.toLowerCase().trim()

  const openCtxMenu = useCallback((e: React.MouseEvent, path: string, node: TreeNode) => {
    e.stopPropagation()
    const x = Math.min(e.clientX, window.innerWidth - 190)
    const y = Math.min(e.clientY, window.innerHeight - 260)
    setCtxMenu({ x, y, path, node })
  }, [])

  const openPicker = useCallback((e: React.MouseEvent, path: string, node: TreeNode) => {
    e.stopPropagation()
    const x = Math.min(e.clientX, window.innerWidth - 290)
    const y = Math.min(e.clientY, window.innerHeight - 360)
    setPicker({ x, y, path, node })
  }, [])

  const handleStyleChange = useCallback((change: LayerStyle) => {
    if (!picker || !onUpdateNode) return
    const path = picker.path
    const next: LayerStyle = { ...(styleOverrides.get(path) ?? getLayerStyle(picker.node)), ...change }
    // Instant local preview for both the tree row and the picker.
    setStyleOverrides(prev => new Map(prev).set(path, next))
    // Debounced persist — the native color input fires rapidly while dragging.
    const metadata = mergeLayerStyle(picker.node.metadata, next)
    const timers = persistTimers.current
    const pending = timers.get(path)
    if (pending) clearTimeout(pending)
    timers.set(path, setTimeout(() => {
      timers.delete(path)
      onUpdateNode(path, { metadata }).catch(err => alert(err instanceof Error ? err.message : String(err)))
    }, 350))
  }, [picker, onUpdateNode, styleOverrides])

  const handleCtrl = useCallback((path: string, id: string) => {
    if (!sourceLayer) {
      setSourceLayer({ path, id })
      setTargetLayers(new Map())
    } else if (path === sourceLayer.path) {
      setSourceLayer(null)
      setTargetLayers(new Map())
    } else {
      setTargetLayers(prev => {
        const next = new Map(prev)
        if (next.has(path)) next.delete(path)
        else next.set(path, id)
        return next
      })
    }
  }, [sourceLayer])

  const handlePaste = useCallback(async (target: string) => {
    if (!clipboard || !onMovePath || !onCopyPath) return
    // target is the parent to paste under; prevent pasting into self or own descendants
    if (clipboard.treeName === treeName && (target === clipboard.path || target.startsWith(clipboard.path + '/'))) return
    if (clipboard.mode === 'cut') {
      await onMovePath(clipboard.path, target, false, clipboard.treeName, treeName)
      setClipboard(null)
      window.dispatchEvent(new CustomEvent('tree:path-clipboard', { detail: null }))
    } else {
      await onCopyPath(clipboard.path, target, false, clipboard.treeName, treeName)
    }
  }, [clipboard, onMovePath, onCopyPath, treeName])

  useEffect(() => {
    if (readOnly) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return
      if (event.key !== 'F6') return
      event.preventDefault()
      if (clipboard?.mode === 'cut') {
        handlePaste(selectedPath)
        return
      }
      const next = { mode: 'cut' as const, path: selectedPath, treeName }
      setClipboard(next)
      window.dispatchEvent(new CustomEvent('tree:path-clipboard', { detail: next }))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [clipboard, handlePaste, readOnly, selectedPath, treeName])

  const handleConfirmCreate = useCallback(async (parentPath: string, name: string) => {
    const isCanvas = inlineCreateIsCanvas
    setInlineCreateParent(null)
    setInlineCreateIsCanvas(false)
    const full = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`
    try {
      if (isCanvas) {
        if (onCreateCanvas && await onCreateCanvas(full)) onSelect(full)
      } else {
        if (onInsertPath && await onInsertPath(full, true)) onSelect(full)
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }, [onInsertPath, onCreateCanvas, onSelect, inlineCreateIsCanvas])

  const handleCancelCreate = useCallback(() => {
    setInlineCreateParent(null)
    setInlineCreateIsCanvas(false)
  }, [])

  const toggleCopyMode = useCallback(() => {
    setCopyModeSticky(v => {
      const next = !v
      copyModeStickyRef.current = next
      isCopyRef.current = next
      setIsCopyDrag(next)
      return next
    })
  }, [])

  if (isLoading) return <div className="px-3 py-3 text-xs text-muted-foreground">Loading tree…</div>
  if (!root) return <div className="px-3 py-3 text-xs text-muted-foreground">No tree available</div>

  const hasSelection = sourceLayer || targetLayers.size > 0

  // Shared props for CardNode
  const cardProps = {
    selectedPath, pendingPath, contentPath, readOnly,
    sourceLayer, targetLayers, clipboard, searchQuery: q,
    inlineCreateParent, inlineCreateIsCanvas,
    onSelect, onShowContent, onCtrl: handleCtrl, onCtxMenu: openCtxMenu,
    onConfirmCreate: handleConfirmCreate, onCancelCreate: handleCancelCreate,
    onOpenPicker: onUpdateNode ? openPicker : undefined,
    styleOverrides,
    dragOverPath,
    isCopyDrag,
    onDragStart: handleDragStart,
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDragEnd: handleDragEnd,
    onDrop: handleDrop,
  }

  return (
    <div ref={containerRef} className="px-3 py-2 space-y-1.5">
      {!readOnly && (
        <div className="flex items-center justify-end px-1 pb-0.5 text-[10px]">
          <button
            type="button"
            onClick={toggleCopyMode}
            title="Toggle drag-drop mode (or hold Ctrl / Alt while dragging)"
            className={cn(
              'px-2 py-0.5 rounded-full border transition-colors select-none',
              copyModeSticky
                ? 'border-emerald-500 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : 'border-border text-muted-foreground hover:bg-muted',
            )}
          >
            {copyModeSticky ? 'Drag → Copy' : 'Drag → Move'}
          </button>
        </div>
      )}
      {hasSelection && (
        <div className="flex items-center justify-between px-1 pb-1 text-[10px] text-muted-foreground">
          <span>
            {sourceLayer
              ? `Source: ${sourceLayer.path} · ${targetLayers.size} target(s)`
              : 'Select source with ⌃-click'}
          </span>
          <button
            type="button"
            className="hover:text-foreground underline"
            onClick={() => { setSourceLayer(null); setTargetLayers(new Map()) }}
          >
            clear
          </button>
        </div>
      )}

      {/* Root "/" node — always shown, children indented below */}
      <div
        data-tree-path="/"
        className={cn(
          'group relative flex min-h-10 items-center gap-2 rounded-md px-3 py-2 cursor-pointer transition-colors select-none',
          readOnly ? 'border border-border/60 shadow-overlay' : 'shadow-lg hover:shadow-xl',
          'text-sm',
          selectedPath === '/' && !contentPath ? 'bg-primary/[0.06]' : 'bg-card hover:bg-primary/[0.04]',
          dragOverPath === '/' && !readOnly && !isCopyDrag && 'ring-2 ring-blue-400 bg-blue-50/50',
          dragOverPath === '/' && !readOnly && isCopyDrag && 'ring-2 ring-emerald-500 bg-emerald-50/50',
        )}
        style={{ borderRight: '4px solid transparent' }}
        onClick={() => onSelect('/')}
        onDragEnter={e => { if (!readOnly) handleDragEnter('/', e) }}
        onDragOver={e => { if (!readOnly) handleDragOver('/', e) }}
        onDragLeave={e => handleDragLeave('/', e)}
        onDrop={e => { if (!readOnly) handleDrop('/', e) }}
        onContextMenu={e => {
          if (!readOnly && onInsertPath) {
            e.preventDefault()
            const x = Math.min(e.clientX, window.innerWidth - 190)
            const y = Math.min(e.clientY, window.innerHeight - 260)
            // use root as a pseudo-node for ctx menu
            const pseudoNode = { id: '', name: '/', label: '/', type: 'root', description: '', color: null, locked: false, children: [] } as unknown as TreeNode
            setCtxMenu({ x, y, path: '/', node: pseudoNode })
          }
        }}
      >
        <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 font-medium truncate">
          / {rootLabel && <span className="text-muted-foreground font-normal">[{rootLabel}]</span>}
        </span>
        {!readOnly && onInsertPath && (
          <button
            type="button"
            className="shrink-0 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-muted-foreground/10 text-muted-foreground"
            onClick={e => {
              e.stopPropagation()
              const x = Math.min(e.clientX, window.innerWidth - 190)
              const y = Math.min(e.clientY, window.innerHeight - 260)
              const pseudoNode = { id: '', name: '/', label: '/', type: 'root', description: '', color: null, locked: false, children: [] } as unknown as TreeNode
              setCtxMenu({ x, y, path: '/', node: pseudoNode })
            }}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Children indented under root */}
      <div className="ml-[22px] mt-1.5 space-y-1.5">
        {inlineCreateParent === '/' && (
          <InlineCreateInput
            onConfirm={name => handleConfirmCreate('/', name)}
            onCancel={handleCancelCreate}
            placeholder={inlineCreateIsCanvas ? 'canvas name…' : undefined}
          />
        )}
        {root.children?.map((child, index) => (
          <CardNode
            key={child.id || child.name}
            node={child}
            parentPath="/"
            depth={0}
            isLast={index === (root.children?.length ?? 0) - 1}
            {...cardProps}
          />
        ))}
        {(!root.children?.length && inlineCreateParent !== '/') && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">Empty tree</div>
        )}
      </div>

      {ctxMenu && (
        <CtxMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          node={ctxMenu.node}
          path={ctxMenu.path}
          onClose={() => setCtxMenu(null)}
          onShowContent={onShowContent}
          onOpenToSide={onOpenToSide ? (path) => onOpenToSide(path, treeName) : undefined}
          sourceLayer={sourceLayer}
          targetLayers={targetLayers}
          clipboard={clipboard}
          onStartInlineCreate={(path, isCanvas = false) => { setInlineCreateParent(path); setInlineCreateIsCanvas(isCanvas) }}
          onChangeIcon={onUpdateNode ? () => openPicker({ clientX: ctxMenu.x, clientY: ctxMenu.y, stopPropagation: () => {} } as React.MouseEvent, ctxMenu.path, ctxMenu.node) : undefined}
          hasCreateCanvas={!!onCreateCanvas}
          onShareCanvas={onShareCanvas}
          onRemove={!readOnly ? onRemovePath : undefined}
          onRename={!readOnly ? onRenamePath : undefined}
          onLock={!readOnly ? onLockLayer : undefined}
          onUnlock={!readOnly ? onUnlockLayer : undefined}
          onDestroy={!readOnly ? onDestroyLayer : undefined}
          onMerge={!readOnly ? onMergeLayer : undefined}
          onSubtract={!readOnly ? onSubtractLayer : undefined}
          onCopy={path => {
            const next = { mode: 'copy' as const, path, treeName }
            setClipboard(next)
            window.dispatchEvent(new CustomEvent('tree:path-clipboard', { detail: next }))
          }}
          onCut={path => {
            const next = { mode: 'cut' as const, path, treeName }
            setClipboard(next)
            window.dispatchEvent(new CustomEvent('tree:path-clipboard', { detail: next }))
          }}
          onPaste={handlePaste}
          pastedDocumentIds={pastedDocumentIds}
          onPasteDocuments={onPasteDocuments}
        />
      )}

      {picker && onUpdateNode && (
        <LayerIconPicker
          x={picker.x}
          y={picker.y}
          current={styleOverrides.get(picker.path) ?? getLayerStyle(picker.node)}
          onChange={handleStyleChange}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
