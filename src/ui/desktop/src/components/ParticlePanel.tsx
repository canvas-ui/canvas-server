import { useEffect, useState } from 'react'

declare global {
  interface Window {
    particlesJS: { load: (elementId: string, configPath: string) => void }
  }
}

export function ParticlePanel() {
  const [scriptLoaded, setScriptLoaded] = useState(false)

  useEffect(() => {
    if (window.particlesJS) { setScriptLoaded(true); return }
    const script = document.createElement('script')
    script.src = '/js/particles.min.js'
    script.onload = () => setScriptLoaded(true)
    document.body.appendChild(script)
    return () => { script.remove() }
  }, [])

  useEffect(() => {
    if (scriptLoaded && window.particlesJS) {
      window.particlesJS.load('particles-container', '/js/particles.config.json')
    }
  }, [scriptLoaded])

  return (
    <div className="relative h-full w-full bg-black">
      <div id="particles-container" className="absolute inset-0 h-full w-full" />
      <div className="relative z-10 flex h-full flex-col justify-between p-8 text-white/90">
        <div className="flex items-center gap-3">
          <img src="/images/logo-wr_64x64.png" alt="" className="h-10 w-10" />
          <div className="text-lg font-semibold">Canvas</div>
        </div>
        <div className="text-xs text-white/50">Desktop Client</div>
      </div>
    </div>
  )
}
