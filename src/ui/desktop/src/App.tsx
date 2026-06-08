import { useCallback, useEffect, useRef, useState } from 'react'
import { AuthScreen } from './components/AuthScreen'
import { type AuthFormData } from './components/AuthPanel'
import { Menu } from './components/Menu'
import { DEFAULT_SHORTCUT, loadConfig, saveConfig, type DesktopConfig } from './lib/config'
import { login, ping, verifyToken } from './lib/api'
import { registerActivation } from './lib/shortcuts'

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

  // (Re)register the global activation accelerator while authenticated.
  useEffect(() => {
    if (phase !== 'ready') return
    const accel = config.shortcut || DEFAULT_SHORTCUT
    let cleanup: (() => void) | undefined
    registerActivation(accel, () => activate.current()).then((c) => { cleanup = c }).catch(() => {})
    return () => cleanup?.()
  }, [phase, config.shortcut])

  const persist = useCallback(async (next: DesktopConfig) => {
    setConfig(next)
    await saveConfig(next)
  }, [])

  const handleTestConnection = useCallback(async (data: AuthFormData) => {
    setBusy(true); setError(null); setStatus(null)
    try { setStatus(`Server reachable (${await ping(data.serverUrl)})`) }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not reach server') }
    finally { setBusy(false) }
  }, [])

  const handleLogin = useCallback(async (data: AuthFormData) => {
    setBusy(true); setError(null); setStatus(null)
    try {
      let token = data.token?.trim()
      if (data.mode === 'password') token = await login(data.serverUrl, data.email ?? '', data.password ?? '')
      if (!token) throw new Error('Provide a token or credentials')
      if (!(await verifyToken(data.serverUrl, token))) throw new Error('Server rejected the credentials')
      await persist({ ...config, serverUrl: data.serverUrl, token, email: data.email })
      setPhase('ready')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [config, persist])

  const handleLogout = useCallback(async () => {
    await persist({ ...config, token: undefined, boundContextId: undefined })
    setPhase('auth')
  }, [config, persist])

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
      onUpdateConfig={(patch) => persist({ ...config, ...patch })}
      onLogout={handleLogout}
    />
  )
}
