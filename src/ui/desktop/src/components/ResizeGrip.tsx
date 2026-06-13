import { getCurrentWindow } from '@tauri-apps/api/window'

type Edge = 'North' | 'South' | 'East' | 'West'
type Corner = 'NorthWest' | 'NorthEast' | 'SouthWest' | 'SouthEast'

const EDGES: { dir: Edge; className: string }[] = [
  { dir: 'North', className: 'absolute left-3 right-3 top-0 z-10 h-1.5 cursor-n-resize hover:bg-foreground/10' },
  { dir: 'South', className: 'absolute bottom-0 left-3 right-3 z-10 h-1.5 cursor-s-resize hover:bg-foreground/10' },
  { dir: 'West', className: 'absolute bottom-3 left-0 top-3 z-10 w-1.5 cursor-w-resize hover:bg-foreground/10' },
  { dir: 'East', className: 'absolute bottom-3 right-0 top-3 z-10 w-1.5 cursor-e-resize hover:bg-foreground/10' },
]

const CORNERS: { dir: Corner; className: string }[] = [
  { dir: 'NorthWest', className: 'absolute left-0 top-0 z-20 h-4 w-4 cursor-nw-resize hover:bg-foreground/10 rounded-tl-xl' },
  { dir: 'NorthEast', className: 'absolute right-0 top-0 z-20 h-4 w-4 cursor-ne-resize hover:bg-foreground/10 rounded-tr-xl' },
  { dir: 'SouthWest', className: 'absolute bottom-0 left-0 z-20 h-4 w-4 cursor-sw-resize hover:bg-foreground/10 rounded-bl-xl' },
  { dir: 'SouthEast', className: 'absolute bottom-0 right-0 z-20 h-4 w-4 cursor-se-resize hover:bg-foreground/10 rounded-br-xl' },
]

function startResize(dir: Edge | Corner, e: React.MouseEvent) {
  e.preventDefault()
  e.stopPropagation()
  getCurrentWindow().startResizeDragging(dir).catch(() => {})
}

export function ResizeGrip() {
  return (
    <>
      {EDGES.map(({ dir, className }) => (
        <button
          key={dir}
          type="button"
          aria-label={`Resize ${dir}`}
          onMouseDown={(e) => startResize(dir, e)}
          className={className}
        />
      ))}
      {CORNERS.map(({ dir, className }) => (
        <button
          key={dir}
          type="button"
          aria-label={`Resize ${dir}`}
          onMouseDown={(e) => startResize(dir, e)}
          className={className}
        />
      ))}
    </>
  )
}
