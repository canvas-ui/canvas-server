/**
 * LayerIconPicker — floating popover to set a layer's icon + color.
 * Selections apply live via onChange; the panel stays open so icon and
 * color can be tweaked together (raindrop-style).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@iconify/react'
import { X, Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  loadPhosphorFillIcons, searchIcons, LAYER_COLORS, DEFAULT_FOLDER_ICON,
  type LayerStyle,
} from '../../lib/layer-style'

const MAX_RESULTS = 180

interface LayerIconPickerProps {
  x: number
  y: number
  current: LayerStyle
  onChange: (change: LayerStyle) => void
  onClose: () => void
}

export function LayerIconPicker({ x, y, current, onChange, onClose }: LayerIconPickerProps) {
  const [query, setQuery] = useState('')
  const [allIcons, setAllIcons] = useState<string[]>([])
  const [results, setResults] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  // Manual double-click: Iconify swaps the icon's inner DOM async, which breaks
  // native dblclick (it needs both clicks on the same element).
  const lastClick = useRef<{ name: string; t: number }>({ name: '', t: 0 })

  const handleIconClick = (name: string) => {
    onChange({ icon: name })
    const now = Date.now()
    if (lastClick.current.name === name && now - lastClick.current.t < 350) onClose()
    lastClick.current = { name, t: now }
  }

  useEffect(() => { searchRef.current?.focus() }, [])

  useEffect(() => {
    let active = true
    loadPhosphorFillIcons().then((list) => {
      if (active) { setAllIcons(list); setLoading(false) }
    })
    return () => { active = false }
  }, [])

  // While typing, search the whole Iconify catalog (debounced); otherwise
  // browse the cached Phosphor list.
  useEffect(() => {
    const q = query.trim()
    if (!q) { setResults([]); setSearching(false); return }
    setSearching(true)
    const t = setTimeout(() => {
      searchIcons(q).then((r) => { setResults(r); setSearching(false) })
    }, 250)
    return () => clearTimeout(t)
  }, [query])

  const icons = useMemo(
    () => (query.trim() ? results : allIcons).slice(0, MAX_RESULTS),
    [query, results, allIcons],
  )

  const left = Math.min(x, window.innerWidth - 290)
  const top = Math.min(y, window.innerHeight - 360)

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 w-[270px] rounded-md border bg-popover p-2 shadow-xl"
        style={{ left, top }}
      >
        <div className="flex items-center justify-between px-1 pb-1.5">
          <span className="text-xs font-medium">Icon &amp; color</span>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Colors */}
        <div className="flex flex-wrap gap-1.5 px-1 pb-2">
          {LAYER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              onClick={() => onChange({ color: c })}
              className={cn(
                'w-5 h-5 rounded-full border transition-transform hover:scale-110',
                current.color === c ? 'ring-2 ring-offset-1 ring-foreground' : 'border-black/10',
              )}
              style={{ backgroundColor: c }}
            />
          ))}
          <button
            type="button"
            title="No color"
            onClick={() => onChange({ color: undefined })}
            className={cn(
              'w-5 h-5 rounded-full border flex items-center justify-center text-muted-foreground hover:scale-110 transition-transform',
              !current.color && 'ring-2 ring-offset-1 ring-foreground',
            )}
          >
            <X className="w-3 h-3" />
          </button>
          {/* Custom color */}
          <label
            title="Custom color"
            className={cn(
              'relative w-5 h-5 rounded-full border border-black/10 cursor-pointer hover:scale-110 transition-transform overflow-hidden',
              current.color && !LAYER_COLORS.includes(current.color) && 'ring-2 ring-offset-1 ring-foreground',
            )}
            style={{
              background: current.color && !LAYER_COLORS.includes(current.color)
                ? current.color
                : 'conic-gradient(from 0deg, #ef4444, #eab308, #22c55e, #06b6d4, #6366f1, #ec4899, #ef4444)',
            }}
          >
            <input
              type="color"
              value={current.color ?? '#3b82f6'}
              onChange={(e) => onChange({ color: e.target.value })}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
          </label>
        </div>

        {/* Search */}
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search icons…"
          className="w-full mb-2 rounded-sm border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
        />

        {/* Icon grid */}
        {loading || searching ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> {searching ? 'Searching…' : 'Loading icons…'}
          </div>
        ) : (
        <div className="grid grid-cols-7 gap-0.5 max-h-[200px] overflow-y-auto">
          <button
            type="button"
            title="No icon"
            onClick={() => onChange({ icon: undefined })}
            className={cn(
              'aspect-square flex items-center justify-center rounded-sm hover:bg-accent text-muted-foreground',
              !current.icon && 'bg-accent ring-1 ring-primary',
            )}
          >
            <X className="w-4 h-4" />
          </button>
          {icons.map((name) => (
            <button
              key={name}
              type="button"
              title={name.replace(/^[^:]+:/, '').replace('-fill', '')}
              onClick={() => handleIconClick(name)}
              className={cn(
                'aspect-square flex items-center justify-center rounded-sm hover:bg-accent',
                current.icon === name && 'bg-accent ring-1 ring-primary',
              )}
            >
              <Icon icon={name} width={18} height={18} color={current.color} />
            </button>
          ))}
        </div>
        )}
        {!loading && !searching && icons.length === 0 && (
          <div className="px-1 py-3 text-center text-[11px] text-muted-foreground">No icons match “{query}”</div>
        )}
      </div>
    </>,
    document.body,
  )
}

export { DEFAULT_FOLDER_ICON }
