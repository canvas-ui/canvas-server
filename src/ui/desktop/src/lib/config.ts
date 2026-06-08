import { invoke } from '@tauri-apps/api/core'

// Persisted in <CANVAS_USER_HOME>/config/desktop.json (see src-tauri/config.rs).
export interface DesktopConfig {
  serverUrl?: string
  token?: string
  email?: string
  boundContextId?: string
  shortcut?: string
}

// Tauri accelerator format. Ctrl+Alt+arrows collide with most Linux DEs, so
// the default mirrors Raycast/Spotlight: one global combo to summon.
export const DEFAULT_SHORTCUT = 'CommandOrControl+Alt+Space'

export async function loadConfig(): Promise<DesktopConfig> {
  return await invoke<DesktopConfig>('load_config')
}

export async function saveConfig(config: DesktopConfig): Promise<void> {
  await invoke('save_config', { config })
}
