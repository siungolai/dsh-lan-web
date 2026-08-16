/**
 * dsh-lan-web — /lan mobile surface entry (standalone page bundle).
 *
 * Bootstraps the two-level app. The /m route already refuses the app shell
 * to LAN clients without a cookie; this client-side status probe is the
 * backstop for sessions that die mid-browse (kicked / password changed).
 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { LoginView } from './login'

function Bootstrap() {
  const [state, setState] = useState<'checking' | 'ok' | 'login'>('checking')

  useEffect(() => {
    let cancelled = false
    fetch('/api/lan-web/status')
      .then((res) => {
        if (!cancelled) setState(res.status === 200 ? 'ok' : 'login')
      })
      .catch(() => {
        if (!cancelled) setState('login')
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (state === 'checking') {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f1115', color: '#7c8494', fontFamily: 'system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif' }}>
        加载中…
      </div>
    )
  }
  if (state === 'login') {
    return <LoginView onAuthed={() => setState('ok')} />
  }
  return <App onSessionExpired={() => setState('login')} />
}

const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(<Bootstrap />)
}
