import { ParticlePanel } from './ParticlePanel'
import { AuthPanel, type AuthFormData } from './AuthPanel'

interface AuthScreenProps {
  defaultServerUrl?: string
  defaultEmail?: string
  busy?: boolean
  error?: string | null
  status?: string | null
  onTestConnection: (data: AuthFormData) => Promise<void>
  onLogin: (data: AuthFormData) => Promise<void>
}

export function AuthScreen(props: AuthScreenProps) {
  // Mirrors the Electron auth-layout: a 95vw × 95vh card centered with padding.
  return (
    <div className="flex min-h-screen w-full flex-col items-center justify-center p-4">
      <div className="flex h-[95vh] w-[95vw] overflow-hidden rounded-xl bg-card shadow-elevation-4">
        <div className="relative hidden w-1/2 bg-black md:block">
          <ParticlePanel />
        </div>
        <div className="flex w-full flex-col justify-center md:w-1/2">
          <AuthPanel {...props} />
        </div>
      </div>
    </div>
  )
}
