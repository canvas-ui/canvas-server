import { invoke } from '@tauri-apps/api/core'

// Persisted in <CANVAS_USER_HOME>/config/desktop.json (see src-tauri/config.rs).
export interface DesktopConfig {
  serverUrl?: string
  token?: string
  email?: string
  boundContextId?: string
  shortcut?: string
  windowX?: number
  windowY?: number
  windowW?: number
  windowH?: number
}

// Tauri accelerator format. Ctrl+Alt+arrows collide with most Linux DEs, so
// the default mirrors Raycast/Spotlight: one global combo to summon.
export const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+Space'

export async function loadConfig(): Promise<DesktopConfig> {
  return await invoke<DesktopConfig>('load_config')
}

// save_config merges partial patches on disk (see src-tauri/config.rs), so
// callers only send the keys they own. `null` deletes a key (logout).
export async function saveConfig(patch: Partial<Record<keyof DesktopConfig, unknown>>): Promise<void> {
  await invoke('save_config', { config: patch })
}

/** Persist window geometry without touching React state (avoids resize/navigation jank). */
export async function persistWindowBounds(
  bounds: Pick<DesktopConfig, 'windowX' | 'windowY' | 'windowW' | 'windowH'>,
): Promise<void> {
  await saveConfig(bounds)
}
