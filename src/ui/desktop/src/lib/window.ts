import { useEffect } from 'react'
import {
  getCurrentWindow,
  currentMonitor,
  monitorFromPoint,
  primaryMonitor,
  type Monitor,
} from '@tauri-apps/api/window'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { loadConfig, persistWindowBounds, type DesktopConfig } from './config'

const AUTH_W = 960
const AUTH_H = 640

const DEFAULT_MENU_W = 480
const DEFAULT_MENU_H = 620
const MIN_MENU_W = 72
const MIN_MENU_H = 160
const VIEWPORT_PAD = 12
const BOUNDS_DEBOUNCE_MS = 600

export type MenuPanel = 'none' | 'contexts' | 'tree' | 'settings'

let menuWindowPrepared = false

export async function resizeAuthWindow(): Promise<void> {
  const win = getCurrentWindow()
  await win.setResizable(true)
  await win.setSize(new LogicalSize(AUTH_W, AUTH_H))
  await win.center()
}

function monitorArea(m: Monitor, scale: number) {
  const a = m.workArea
  return {
    x: a.position.x / scale,
    y: a.position.y / scale,
    w: a.size.width / scale,
    h: a.size.height / scale,
  }
}

export async function ensureWindowVisible(): Promise<void> {
  const win = getCurrentWindow()
  const scale = await win.scaleFactor()
  const pos = await win.outerPosition()
  const size = await win.innerSize()
  const x = pos.x / scale
  const y = pos.y / scale
  const w = size.width / scale
  const h = size.height / scale

  let monitor = await monitorFromPoint(pos.x + size.width / 2, pos.y + size.height / 2)
  if (!monitor) monitor = await currentMonitor()
  if (!monitor) monitor = await primaryMonitor()
  if (!monitor) return

  const area = monitorArea(monitor, scale)
  let nx = x
  let ny = y
  if (x + w < area.x + VIEWPORT_PAD) nx = area.x + VIEWPORT_PAD
  if (x > area.x + area.w - VIEWPORT_PAD) nx = area.x + area.w - w - VIEWPORT_PAD
  if (y + h < area.y + VIEWPORT_PAD) ny = area.y + VIEWPORT_PAD
  if (y > area.y + area.h - VIEWPORT_PAD) ny = area.y + area.h - h - VIEWPORT_PAD
  nx = Math.max(area.x + VIEWPORT_PAD, Math.min(nx, area.x + area.w - w - VIEWPORT_PAD))
  ny = Math.max(area.y + VIEWPORT_PAD, Math.min(ny, area.y + area.h - h - VIEWPORT_PAD))

  if (nx !== x || ny !== y) await win.setPosition(new LogicalPosition(nx, ny))
}

async function prepareMenuWindow(): Promise<void> {
  if (menuWindowPrepared) return
  const win = getCurrentWindow()
  await win.setResizable(true)
  await win.setShadow(false)
  await win.setMinSize(new LogicalSize(MIN_MENU_W, MIN_MENU_H))
  menuWindowPrepared = true
}

export async function applyMenuWindowBounds(cfg: DesktopConfig): Promise<void> {
  await prepareMenuWindow()
  const win = getCurrentWindow()
  const w = cfg.windowW ?? DEFAULT_MENU_W
  const h = cfg.windowH ?? DEFAULT_MENU_H
  await win.setSize(new LogicalSize(w, h))
  if (cfg.windowX != null && cfg.windowY != null) {
    await win.setPosition(new LogicalPosition(cfg.windowX, cfg.windowY))
  } else {
    await win.center()
  }
  await ensureWindowVisible()
}

export async function readWindowBounds(): Promise<Pick<DesktopConfig, 'windowX' | 'windowY' | 'windowW' | 'windowH'>> {
  const win = getCurrentWindow()
  const scale = await win.scaleFactor()
  const pos = await win.outerPosition()
  const size = await win.innerSize()
  return {
    windowX: Math.round(pos.x / scale),
    windowY: Math.round(pos.y / scale),
    windowW: Math.round(size.width / scale),
    windowH: Math.round(size.height / scale),
  }
}

export async function showMenuOverlay(): Promise<void> {
  const cfg = await loadConfig()
  await applyMenuWindowBounds(cfg)
  const win = getCurrentWindow()
  await win.show()
  await win.setFocus()
}

export async function hideToTray(): Promise<void> {
  const bounds = await readWindowBounds()
  await persistWindowBounds(bounds)
  await getCurrentWindow().hide()
}

/** Listen for move/resize; write bounds to disk only — never re-apply bounds here. */
export function useMenuWindowPersistence(): void {
  useEffect(() => {
    let unlistenMove: (() => void) | undefined
    let unlistenResize: (() => void) | undefined
    let unlistenScale: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout>

    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        readWindowBounds().then(persistWindowBounds).catch(() => {})
      }, BOUNDS_DEBOUNCE_MS)
    }

    ;(async () => {
      await prepareMenuWindow()
      const win = getCurrentWindow()
      unlistenMove = await win.onMoved(schedule)
      unlistenResize = await win.onResized(schedule)
      unlistenScale = await win.onScaleChanged(() => {
        ensureWindowVisible().then(schedule).catch(() => {})
      })
    })()

    return () => {
      clearTimeout(timer)
      unlistenMove?.()
      unlistenResize?.()
      unlistenScale?.()
    }
  }, [])
}
