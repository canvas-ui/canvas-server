import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthScreen } from './components/AuthScreen'
import { type AuthFormData } from './components/AuthPanel'
import { Menu } from './components/Menu'
import { DEFAULT_SHORTCUT, loadConfig, saveConfig, type DesktopConfig } from './lib/config'
import { login, ping, verifyToken } from './lib/api'
import { registerActivation } from './lib/shortcuts'
import { hideToTray, resizeAuthWindow } from './lib/window'

type Phase = 'loading' | 'auth' | 'ready'

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [config, setConfig] = useState<DesktopConfig>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [activateSignal, setActivateSignal] = useState(0)
  const activate = useRef(() => setActivateSignal((s) => s + 1))

  useEffect(() => {
    (async () => {
      const cfg = await loadConfig()
      setConfig(cfg)
      if (cfg.serverUrl && cfg.token && (await verifyToken(cfg.serverUrl, cfg.token))) setPhase('ready')
      else setPhase('auth')
    })()
  }, [])

  // Login needs a full window; the overlay menu shrinks itself once authenticated.
  useEffect(() => {
    if (phase === 'loading' || phase === 'auth') resizeAuthWindow().catch(() => {})
  }, [phase])

  // Authenticated app lives in the tray; summon with the activation shortcut.
  useEffect(() => {
    if (phase !== 'ready') return
    hideToTray().catch(() => {})
  }, [phase])

  // (Re)register the global activation accelerator while authenticated.
  useEffect(() => {
    if (phase !== 'ready') return
    const accel = config.shortcut || DEFAULT_SHORTCUT
    let cleanup: (() => void) | undefined
    registerActivation(accel, () => activate.current()).then((c) => { cleanup = c }).catch(() => {})
    return () => cleanup?.()
  }, [phase, config.shortcut])

  const persist = useCallback(async (patch: Partial<DesktopConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }))
    await saveConfig(patch)
  }, [])

  const handleTestConnection = useCallback(async (data: AuthFormData) => {
    setBusy(true); setError(null); setStatus(null)
    try { setStatus(`Server reachable (${await ping(data.serverUrl)})`) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not reach server') }
    finally { setBusy(false) }
  }, [])

  const handleLogin = useCallback(async (data: AuthFormData) => {
    setBusy(true); setError(null); setStatus('Signing in…')
    try {
      let token = data.token?.trim()
      if (data.mode === 'password') {
        token = await login(data.serverUrl, data.email ?? '', data.password ?? '')
      } else {
        if (!token) throw new Error('Provide an application token')
        if (!(await verifyToken(data.serverUrl, token))) throw new Error('Server rejected the token')
      }
      setStatus('Saving session…')
      await persist({ serverUrl: data.serverUrl, token, email: data.email })
      setPhase('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }, [persist])

  const updateConfig = useCallback(async (patch: Partial<DesktopConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }))
    saveConfig(patch).catch(() => {})
  }, [])

  const handleLogout = useCallback(async () => {
    setConfig((prev) => ({ ...prev, token: undefined, boundContextId: undefined }))
    await saveConfig({ token: null, boundContextId: null })
    setPhase('auth')
  }, [])

  if (phase === 'loading') {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>
  }

  if (phase === 'auth') {
    return (
      <AuthScreen
        defaultServerUrl={config.serverUrl ?? ''}
        defaultEmail={config.email ?? ''}
        busy={busy}
        error={error}
        status={status}
        onTestConnection={handleTestConnection}
        onLogin={handleLogin}
      />
    )
  }

  return (
    <Menu
      config={config}
      activateSignal={activateSignal}
      onUpdateConfig={updateConfig}
      onLogout={handleLogout}
    />
  )
}
