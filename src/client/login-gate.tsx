/**
 * dsh-lan-web — full-screen login gate (browser half).
 *
 * Mounted directly on document.body via createRoot (no slot owner exists for
 * a full-screen overlay; see PLAN.md M-8). The gate shows whenever the LAN
 * session is missing/invalid and hides after a successful login.
 */
import { createElement, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

let root: Root | null = null
let container: HTMLDivElement | null = null

export function showLoginGate(): void {
  if (container !== null) return
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  root.render(
    createElement(LoginGate, {
      onAuthed: () => {
        hideLoginGate()
      },
    }),
  )
}

export function hideLoginGate(): void {
  root?.unmount()
  root = null
  container?.remove()
  container = null
}

interface LoginGateProps {
  onAuthed: () => void
}

function LoginGate({ onAuthed }: LoginGateProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function submit(event: { preventDefault(): void }) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/lan-web/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.status === 200) {
        onAuthed()
        return
      }
      if (res.status === 429) {
        setError('尝试次数过多，请稍后再试')
      } else if (res.status === 403) {
        setError('管理员尚未配置密码，局域网访问暂不可用')
      } else if (res.status === 401) {
        setError('密码错误')
      } else {
        setError(`登录失败（${res.status}）`)
      }
    } catch {
      setError('网络错误，请重试')
    } finally {
      setBusy(false)
    }
  }

  const styles: Record<string, React.CSSProperties> = {
    overlay: {
      position: 'fixed',
      inset: '0',
      zIndex: 2147483000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0f1115',
      color: '#e6e6e6',
      fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      padding: '24px',
      boxSizing: 'border-box',
    },
    card: {
      width: '100%',
      maxWidth: '360px',
      padding: '32px 28px',
      borderRadius: '14px',
      background: '#1a1d24',
      boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
      boxSizing: 'border-box',
    },
    title: { margin: '0 0 6px', fontSize: '20px', fontWeight: 600 },
    subtitle: { margin: '0 0 22px', fontSize: '13px', color: '#9aa0ab' },
    label: { display: 'block', fontSize: '13px', color: '#c3c7cf', marginBottom: '8px' },
    input: {
      width: '100%',
      padding: '12px 14px',
      fontSize: '16px',
      borderRadius: '8px',
      border: '1px solid #333a45',
      background: '#12151b',
      color: '#e6e6e6',
      boxSizing: 'border-box',
      outline: 'none',
    },
    button: {
      width: '100%',
      marginTop: '18px',
      padding: '12px',
      fontSize: '16px',
      fontWeight: 600,
      borderRadius: '8px',
      border: 'none',
      background: '#3b82f6',
      color: '#fff',
      cursor: 'pointer',
      minHeight: '44px',
    },
    error: { marginTop: '12px', fontSize: '13px', color: '#f87171' },
  }

  return createElement(
    'div',
    { style: styles.overlay },
    createElement(
      'form',
      { style: styles.card, onSubmit: submit },
      createElement('h1', { style: styles.title }, 'DeepSeek Harness'),
      createElement('p', { style: styles.subtitle }, '局域网访问需要登录'),
      createElement('label', { style: styles.label, htmlFor: 'lan-web-password' }, '密码'),
      createElement('input', {
        ref: inputRef,
        id: 'lan-web-password',
        type: 'password',
        style: styles.input,
        value: password,
        onChange: (e: { target: { value: string } }) => setPassword(e.target.value),
        autoComplete: 'current-password',
        enterKeyHint: 'go',
      }),
      createElement(
        'button',
        { type: 'submit', style: styles.button, disabled: busy },
        busy ? '登录中…' : '登录',
      ),
      error !== null ? createElement('p', { style: styles.error }, error) : null,
    ),
  )
}
