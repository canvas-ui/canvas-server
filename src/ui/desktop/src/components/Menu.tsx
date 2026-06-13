import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Layers3, LogOut, Link2, LayoutGrid, Settings, Keyboard, Search } from 'lucide-react'
import { cn } from '../lib/utils'
import { DEFAULT_SHORTCUT, type DesktopConfig } from '../lib/config'
import { toAccelerator } from '../lib/shortcuts'
import { useMenuWindowPersistence } from '../lib/window'
import type { Context } from '../lib/types'
import { listContexts } from '../lib/api'
import { contextUrlToPath } from '../lib/context-url'
import { BoundContextTree } from './tree/BoundContextTree'
import { Input } from './ui/input'
import { ResizeGrip } from './ResizeGrip'

interface MenuProps {
  config: DesktopConfig
  activateSignal: number
  onUpdateConfig: (patch: Partial<DesktopConfig>) => void
  onLogout: () => void
}

export function Menu({ config, activateSignal, onUpdateConfig, onLogout }: MenuProps) {
  const serverUrl = config.serverUrl!
  const token = config.token!
  const boundId = config.boundContextId

  const [panel, setPanel] = useState<'none' | 'contexts' | 'tree' | 'settings'>('none')
  const [contexts, setContexts] = useState<Context[]>([])
  const [contextSearch, setContextSearch] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [focusSignal, setFocusSignal] = useState(0)
  const contextSearchRef = useRef<HTMLInputElement>(null)

  useMenuWindowPersistence()

  const loadContexts = useCallback(async () => {
    try {
      setContexts(await listContexts(serverUrl, token))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [serverUrl, token])

  useEffect(() => { loadContexts() }, [loadContexts])

  const filteredContexts = useMemo(() => contexts.filter((c) => {
    const q = contextSearch.trim().toLowerCase()
    if (!q) return true
    const path = contextUrlToPath(c.url || '', c.workspaceName).toLowerCase()
    return c.id.toLowerCase().includes(q) || (c.workspaceName || '').toLowerCase().includes(q) || path.includes(q)
  }), [contexts, contextSearch])

  const contextIds = useMemo(() => filteredContexts.map((c) => c.id), [filteredContexts])

  useEffect(() => {
    setHighlightIdx(0)
  }, [contextSearch, panel])

  // Hotkey: jump to bound tree or context picker; focus search.
  useEffect(() => {
    if (activateSignal === 0) return
    const next = boundId ? 'tree' as const : 'contexts' as const
    setPanel(next)
    setFocusSignal((s) => s + 1)
    if (next === 'contexts') contextSearchRef.current?.focus()
  }, [activateSignal, boundId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable) return
      if (e.key === 'Escape') { getCurrentWindow().hide(); return }
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const k = e.key.toLowerCase()
      if (k === 'c') setPanel((p) => (p === 'contexts' ? 'none' : 'contexts'))
      else if (k === 'b' && boundId) setPanel('tree')
      else if (k === 's') setPanel((p) => (p === 'settings' ? 'none' : 'settings'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [boundId])

  const bind = (id: string) => {
    onUpdateConfig({ boundContextId: id })
    setPanel('tree')
    setFocusSignal((s) => s + 1)
  }

  const onContextSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIdx((i) => Math.min(contextIds.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter' && contextIds[highlightIdx]) {
      e.preventDefault()
      bind(contextIds[highlightIdx])
    }
  }

  useEffect(() => {
    if (panel !== 'contexts') return
    const id = contextIds[highlightIdx]
    if (!id) return
    document.getElementById(`ctx-row-${id}`)?.scrollIntoView({ block: 'nearest' })
  }, [highlightIdx, contextIds, panel])

  return (
    <div className="relative flex h-full w-full gap-2 p-2" data-tauri-drag-region>
      <div className="flex shrink-0 flex-col items-center gap-1 rounded-xl border border-border/70 bg-card p-2 shadow-overlay">
        <div className="mb-1 flex h-10 w-10 items-center justify-center">
          <img src="/images/logo-wr_64x64.png" alt="Canvas" className="h-6 w-6" />
        </div>
        <IconButton active={panel === 'contexts'} label="Contexts (C)" onClick={() => setPanel((p) => (p === 'contexts' ? 'none' : 'contexts'))}>
          <Layers3 className="h-5 w-5" />
        </IconButton>
        {boundId && (
          <IconButton active={panel === 'tree'} label="Bound context (B)" onClick={() => setPanel('tree')}>
            <Link2 className="h-5 w-5 text-secondary" />
          </IconButton>
        )}
        <div className="flex-1" />
        <IconButton active={panel === 'settings'} label="Settings (S)" onClick={() => setPanel((p) => (p === 'settings' ? 'none' : 'settings'))}>
          <Settings className="h-5 w-5" />
        </IconButton>
        <IconButton label="Logout" onClick={onLogout}>
          <LogOut className="h-5 w-5 text-destructive" />
        </IconButton>
      </div>

      {panel !== 'none' && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-card shadow-overlay">
          {panel === 'contexts' && (
            <div className="flex min-h-0 flex-1 flex-col p-3">
              <PanelTitle>Bind a context</PanelTitle>
              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={contextSearchRef}
                  value={contextSearch}
                  onChange={(e) => setContextSearch(e.target.value)}
                  onKeyDown={onContextSearchKeyDown}
                  placeholder="Search contexts… (↑↓ Enter)"
                  className="h-8 pl-8 text-xs"
                />
              </div>
              <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
                {filteredContexts.map((c, idx) => {
                  const path = contextUrlToPath(c.url || '', c.workspaceName)
                  return (
                    <button
                      key={c.id}
                      id={`ctx-row-${c.id}`}
                      type="button"
                      onClick={() => (idx === highlightIdx ? bind(c.id) : setHighlightIdx(idx))}
                      className={cn(
                        'flex w-full flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent',
                        idx === highlightIdx && 'bg-accent ring-2 ring-ring ring-offset-1 ring-offset-background',
                        c.id === boundId && idx !== highlightIdx && 'ring-1 ring-secondary/30',
                      )}
                    >
                      <span className="flex items-center gap-2 font-medium">
                        <LayoutGrid className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate">{c.id}</span>
                        {c.id === boundId && <Link2 className="h-3.5 w-3.5 shrink-0 text-secondary" />}
                      </span>
                      {(c.workspaceName || path !== '/') && (
                        <span className="truncate pl-6 font-mono text-[11px] text-muted-foreground">
                          {c.workspaceName ? `${c.workspaceName}://${path.replace(/^\//, '')}` : path}
                        </span>
                      )}
                    </button>
                  )
                })}
                {filteredContexts.length === 0 && (
                  <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                    {contexts.length === 0 ? 'No contexts on this server' : 'No matches'}
                  </div>
                )}
              </div>
              {error && <div className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
            </div>
          )}

          {panel === 'tree' && boundId && (
            <BoundContextTree
              serverUrl={serverUrl}
              token={token}
              contextId={boundId}
              focusSignal={focusSignal}
            />
          )}

          {panel === 'settings' && (
            <div className="p-3">
              <SettingsPanel shortcut={config.shortcut || DEFAULT_SHORTCUT} onChangeShortcut={(s) => onUpdateConfig({ shortcut: s })} />
            </div>
          )}
        </div>
      )}

      <ResizeGrip />
    </div>
  )
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 px-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>
}

function IconButton({ active, label, onClick, children }: { active?: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
        active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function SettingsPanel({ shortcut, onChangeShortcut }: { shortcut: string; onChangeShortcut: (s: string) => void }) {
  const [recording, setRecording] = useState(false)
  return (
    <>
      <PanelTitle>Settings</PanelTitle>
      <div className="space-y-3 px-0.5 text-sm">
        <div className="space-y-1">
          <div className="font-medium">Activation shortcut</div>
          <button
            type="button"
            onClick={() => setRecording(true)}
            onBlur={() => setRecording(false)}
            onKeyDown={(e) => {
              if (!recording) return
              e.preventDefault()
              const accel = toAccelerator(e)
              if (accel) { onChangeShortcut(accel); setRecording(false) }
            }}
            className={cn('flex w-full items-center gap-2 rounded-md border px-2 py-1.5 font-mono text-xs', recording ? 'border-ring ring-1 ring-ring' : 'hover:bg-accent')}
          >
            <Keyboard className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex-1 text-left">{recording ? 'Press keys…' : shortcut}</span>
          </button>
          <div className="text-[11px] text-muted-foreground">Summon this menu from anywhere on your desktop.</div>
        </div>
        <div className="space-y-1">
          <div className="font-medium">In-overlay keys</div>
          <ul className="space-y-0.5 text-[11px] text-muted-foreground">
            <li><kbd className="font-mono">C</kbd> Contexts · <kbd className="font-mono">B</kbd> Bound tree · <kbd className="font-mono">S</kbd> Settings</li>
            <li><kbd className="font-mono">↑↓ Enter</kbd> Navigate search results</li>
            <li><kbd className="font-mono">Esc</kbd> Hide overlay</li>
          </ul>
        </div>
      </div>
    </>
  )
}
