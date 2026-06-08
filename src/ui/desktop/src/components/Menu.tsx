import { useCallback, useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Layers3, LogOut, Link2, LayoutGrid, Settings, Keyboard } from 'lucide-react'
import { cn } from '../lib/utils'
import { DEFAULT_SHORTCUT, type DesktopConfig } from '../lib/config'
import { toAccelerator } from '../lib/shortcuts'
import type { Context } from '../lib/types'
import { listContexts } from '../lib/api'
import { BoundContextTree } from './tree/BoundContextTree'

type Panel = 'none' | 'contexts' | 'tree' | 'settings'

interface MenuProps {
  config: DesktopConfig
  activateSignal: number
  onUpdateConfig: (patch: Partial<DesktopConfig>) => void
  onLogout: () => void
}

export function Menu({ config, activateSignal, onUpdateConfig, onLogout }: MenuProps) {
  const serverUrl = config.serverUrl!
  const token = config.token!

  const [panel, setPanel] = useState<Panel>('none')
  const [contexts, setContexts] = useState<Context[]>([])
  const [error, setError] = useState<string | null>(null)

  const boundId = config.boundContextId

  const loadContexts = useCallback(async () => {
    try { setContexts(await listContexts(serverUrl, token)) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [serverUrl, token])

  useEffect(() => { loadContexts() }, [loadContexts])

  // Global activation — jump to the bound tree, else the contexts list.
  useEffect(() => {
    if (activateSignal === 0) return
    setPanel(boundId ? 'tree' : 'contexts')
  }, [activateSignal]) // eslint-disable-line react-hooks/exhaustive-deps

  // Raycast-style single-key section nav (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
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

  const bind = (id: string) => { onUpdateConfig({ boundContextId: id }); setPanel('tree') }

  return (
    <div className="flex h-full gap-2 p-2" data-tauri-drag-region>
      {/* M0 — icon-only bar */}
      <div className="flex flex-col items-center gap-1 rounded-xl bg-card/95 p-2 shadow-elevation-3 backdrop-blur">
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
        <div className={cn('flex flex-col rounded-xl bg-card/95 shadow-elevation-3 backdrop-blur', panel === 'tree' ? 'w-80' : 'w-72 p-2')}>
          {panel === 'contexts' && (
            <div className="p-2">
              <PanelTitle>Contexts</PanelTitle>
              <div className="flex-1 overflow-y-auto">
                {contexts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => bind(c.id)}
                    className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent', c.id === boundId && 'bg-accent')}
                  >
                    <LayoutGrid className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">{c.id}</span>
                    {c.id === boundId && <Link2 className="h-3.5 w-3.5 text-secondary" />}
                  </button>
                ))}
                {contexts.length === 0 && <div className="px-2 py-3 text-xs text-muted-foreground">No contexts</div>}
              </div>
              {error && <div className="mt-1 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">{error}</div>}
            </div>
          )}

          {panel === 'tree' && boundId && (
            <BoundContextTree serverUrl={serverUrl} token={token} contextId={boundId} />
          )}

          {panel === 'settings' && (
            <div className="p-2">
              <SettingsPanel shortcut={config.shortcut || DEFAULT_SHORTCUT} onChangeShortcut={(s) => onUpdateConfig({ shortcut: s })} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return <div className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>
}

function IconButton({ active, label, onClick, children }: { active?: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn('flex h-10 w-10 items-center justify-center rounded-lg transition-colors', active ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')}
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
      <div className="space-y-3 px-2 py-1 text-sm">
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
          <div className="text-[11px] text-muted-foreground">Click, then press a modifier combo. Avoid combos your desktop already uses.</div>
        </div>
        <div className="space-y-1">
          <div className="font-medium">In-overlay keys</div>
          <ul className="space-y-0.5 text-[11px] text-muted-foreground">
            <li><kbd className="font-mono">C</kbd> Contexts · <kbd className="font-mono">B</kbd> Bound · <kbd className="font-mono">S</kbd> Settings</li>
            <li><kbd className="font-mono">Esc</kbd> Hide overlay</li>
          </ul>
        </div>
      </div>
    </>
  )
}
