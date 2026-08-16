/**
 * Mobile login view — the client-side backstop of the /lan dual-layer gate.
 * The route already refuses the app shell to LAN clients without a cookie;
 * this covers sessions that expire (kicked / password changed) mid-browse.
 */
import { createElement, useRef, useState } from 'react'

export function LoginView({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function submit(e: { preventDefault(): void }): Promise<void> {
    e.preventDefault()
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
      if (res.status === 429) setError('尝试次数过多，请稍后再试')
      else if (res.status === 403) setError('管理员尚未配置密码，局域网访问暂不可用')
      else if (res.status === 401) setError('密码错误')
      else setError(`登录失败（${res.status}）`)
    } catch {
      setError('网络错误，请重试')
    } finally {
      setBusy(false)
    }
  }

  const s: Record<string, import('react').CSSProperties> = {
    overlay: { position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f1115', color: '#e6e6e6', fontFamily: 'system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif', padding: 24, boxSizing: 'border-box' },
    card: { width: '100%', maxWidth: 360, padding: '32px 28px', borderRadius: 14, background: '#1a1d24', boxSizing: 'border-box' },
    title: { margin: '0 0 6px', fontSize: 20, fontWeight: 600 },
    subtitle: { margin: '0 0 22px', fontSize: 13, color: '#9aa0ab' },
    label: { display: 'block', fontSize: 13, color: '#c3c7cf', marginBottom: 8 },
    input: { width: '100%', minHeight: 44, padding: '0 14px', fontSize: 16, borderRadius: 8, border: '1px solid #333a45', background: '#12151b', color: '#e6e6e6', boxSizing: 'border-box', outline: 'none' },
    button: { width: '100%', minHeight: 44, marginTop: 18, fontSize: 16, fontWeight: 600, borderRadius: 8, border: 'none', background: '#3b82f6', color: '#fff' },
    error: { marginTop: 12, fontSize: 13, color: '#f87171' },
  }

  return createElement('div', { style: s.overlay },
    createElement('form', { style: s.card, onSubmit: submit },
      createElement('h1', { style: s.title }, 'DeepSeek Harness'),
      createElement('p', { style: s.subtitle }, '局域网访问需要登录'),
      createElement('label', { style: s.label, htmlFor: 'm-pw' }, '密码'),
      createElement('input', { ref: inputRef, id: 'm-pw', type: 'password', style: s.input, value: password, onChange: (e: { target: { value: string } }) => setPassword(e.target.value), autoComplete: 'current-password', enterKeyHint: 'go' }),
      createElement('button', { type: 'submit', style: s.button, disabled: busy }, busy ? '登录中…' : '登录'),
      error !== null ? createElement('p', { style: s.error }, error) : null,
    ),
  )
}
