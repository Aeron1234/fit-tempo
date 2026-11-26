import { useEffect, useRef, useState, type ReactNode } from 'react'

interface InstallPrompt extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let prompt: InstallPrompt | undefined
const installChange = 'fit-tempo-install-change'
let installed = false

// Bootstrap runs once in main, before the landing component mounts.
// eslint-disable-next-line react-refresh/only-export-components
export function initializePwa() {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault()
    prompt = event as InstallPrompt
    window.dispatchEvent(new Event(installChange))
  })
  window.addEventListener('appinstalled', () => {
    installed = true
    prompt = undefined
    window.dispatchEvent(new Event(installChange))
  })
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/fit-tempo-sw.js').catch(error => {
      console.warn('Fit Tempo offline shell could not be registered', error)
    })
  }
}

export function InstallFitTempo() {
  const [help, setHelp] = useState(false)
  const [busy, setBusy] = useState(false)
  const [isInstalled, setInstalled] = useState(false)
  useEffect(() => {
    const standalone = window.matchMedia('(display-mode: standalone)')
    const update = () => setInstalled(installed || standalone.matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true)
    update()
    standalone.addEventListener('change', update)
    window.addEventListener(installChange, update)
    return () => {
      standalone.removeEventListener('change', update)
      window.removeEventListener(installChange, update)
    }
  }, [])

  async function install() {
    if (!prompt) {
      setHelp(value => !value)
      return
    }
    const current = prompt
    prompt = undefined
    setBusy(true)
    try {
      const { outcome } = await current.prompt()
      if (outcome === 'accepted') setInstalled(true)
      else setHelp(true)
    } catch {
      setHelp(true)
    } finally {
      setBusy(false)
    }
  }

  if (isInstalled) return <p role="status">Fit Tempo is installed.</p>
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const apple = /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)
  const android = /Android/.test(agent)
  return <>
    <button type="button" className="landing-primary" disabled={busy} aria-expanded={help}
      onClick={() => void install()}>Install Fit Tempo</button>
    {help && <p className="landing-install-help" role="status">
      {apple ? 'In Safari, tap Share (under More in some layouts), then Add to Home Screen. Turn on Open as Web App if shown, then tap Add.'
        : android ? 'In Chrome, open the menu and choose Install and create shortcut, then Install. Some versions show Add to Home screen or Install app.'
          : 'Look for an install icon in the address bar or an Install app option in your browser menu.'}
      {' '}You can also open Fit Tempo in this browser.
    </p>}
  </>
}

export function ConnectionBoundary({ children }: { children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine)
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    const update = () => { setOnline(navigator.onLine); setChecked(false) }
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    element.showModal()
    return () => element.close()
  }, [online])
  return <>
    {!online && <dialog ref={dialog} className="connection-overlay" role="alertdialog" onCancel={event => event.preventDefault()}
      aria-labelledby="connection-title" aria-describedby="connection-details">
      <div className="landing-card">
        <h2 id="connection-title">You’re offline</h2>
        <p id="connection-details">Reconnect to use Fit Tempo. Any open form will stay on this screen.</p>
        <button type="button" autoFocus className="landing-primary" onClick={() => {
          setOnline(navigator.onLine)
          setChecked(true)
        }}>Retry connection</button>
        {checked && <p role="status">Still offline. Check Wi-Fi or mobile data and try again.</p>}
      </div>
    </dialog>}
    {children}
  </>
}

