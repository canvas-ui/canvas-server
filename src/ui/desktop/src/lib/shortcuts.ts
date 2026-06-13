import { register, unregister } from '@tauri-apps/plugin-global-shortcut'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { showMenuOverlay } from './window'

// Registers the global activation accelerator. Pressing it toggles the overlay;
// on show it fires onActivate so the menu can jump to the right panel.
// Returns a cleanup that unregisters the accelerator.
export async function registerActivation(accel: string, onActivate: () => void): Promise<() => void> {
  try { await unregister(accel) } catch { /* not registered yet */ }
  await register(accel, async (event) => {
    if (event.state !== 'Pressed') return
    const win = getCurrentWindow()
    if (await win.isVisible()) {
      await win.hide()
    } else {
      await showMenuOverlay()
      onActivate()
    }
  })
  return () => { unregister(accel).catch(() => {}) }
}

// Converts a keydown into a Tauri accelerator string, or null if it isn't a
// usable global shortcut yet (lone modifier / no modifier).
export function toAccelerator(e: React.KeyboardEvent | KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null
  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (mods.length === 0) return null
  let key = e.key
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  return [...mods, key].join('+')
}
