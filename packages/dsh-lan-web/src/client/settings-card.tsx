/**
 * dsh-lan-web — settings card (browser half), registered into the official
 * `settings.section` slot: change password, list devices, revoke devices.
 */
import { createElement, useEffect, useState } from 'react'

interface Device {
  deviceId: string
  deviceName?: string
  createdAt: number
  lastSeenAt: number
  userAgent?: string
}

export function SettingsCard() {
  const [devices, setDevices] = useState<Device[]>([])
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  async function refreshDevices() {
    try {
      const res = await fetch('/api/lan-web/devices')
      if (res.status === 200) {
        const data = (await res.json()) as { devices: Device[] }
        setDevices(data.devices)
      }
    } catch {
      // Ignore transient failures; the list refreshes on next open.
    }
  }

  useEffect(() => {
    void refreshDevices()
  }, [])

  async function submitPassword(event: { preventDefault(): void }) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/lan-web/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ current, next }),
      })
      if (res.status === 200) {
        setMessage({ kind: 'ok', text: '密码已修改，所有设备（含本机）已退出，请重新登录' })
        setCurrent('')
        setNext('')
      } else if (res.status === 401) {
        setMessage({ kind: 'error', text: '当前密码错误' })
      } else if (res.status === 400) {
        setMessage({ kind: 'error', text: '新密码需 4~128 个字符' })
      } else {
        setMessage({ kind: 'error', text: `操作失败（${res.status}）` })
      }
    } catch {
      setMessage({ kind: 'error', text: '网络错误' })
    } finally {
      setBusy(false)
    }
  }

  async function revoke(deviceId: string) {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch('/api/lan-web/devices/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId }),
      })
      if (res.status === 200) {
        setMessage({ kind: 'ok', text: '设备已退出' })
        await refreshDevices()
      } else {
        setMessage({ kind: 'error', text: `操作失败（${res.status}）` })
      }
    } catch {
      setMessage({ kind: 'error', text: '网络错误' })
    } finally {
      setBusy(false)
    }
  }

  const styles: Record<string, React.CSSProperties> = {
    section: { display: 'flex', flexDirection: 'column', gap: '18px' },
    field: { display: 'flex', flexDirection: 'column', gap: '8px' },
    label: { fontSize: '13px', color: '#9aa0ab' },
    input: {
      padding: '10px 12px',
      fontSize: '14px',
      borderRadius: '8px',
      border: '1px solid #333a45',
      background: '#12151b',
      color: '#e6e6e6',
      boxSizing: 'border-box',
      minHeight: '40px',
    },
    button: {
      padding: '10px 16px',
      fontSize: '14px',
      fontWeight: 600,
      borderRadius: '8px',
      border: 'none',
      background: '#3b82f6',
      color: '#fff',
      cursor: 'pointer',
      minHeight: '40px',
    },
    list: { listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' },
    item: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '10px 12px',
      borderRadius: '8px',
      background: '#12151b',
      fontSize: '13px',
    },
    small: { color: '#9aa0ab', fontSize: '12px' },
    danger: { background: '#dc2626' },
    ok: { color: '#4ade80', fontSize: '13px' },
    error: { color: '#f87171', fontSize: '13px' },
  }

  return createElement(
    'div',
    { style: styles.section },
    createElement(
      'form',
      { style: styles.field, onSubmit: submitPassword },
      createElement('h3', { style: { margin: 0 } }, '修改密码'),
      createElement('label', { style: styles.label }, '当前密码'),
      createElement('input', {
        type: 'password',
        style: styles.input,
        value: current,
        onChange: (e: { target: { value: string } }) => setCurrent(e.target.value),
        autoComplete: 'current-password',
      }),
      createElement('label', { style: styles.label }, '新密码（4~128 字符）'),
      createElement('input', {
        type: 'password',
        style: styles.input,
        value: next,
        onChange: (e: { target: { value: string } }) => setNext(e.target.value),
        autoComplete: 'new-password',
      }),
      createElement(
        'button',
        { type: 'submit', style: styles.button, disabled: busy || current === '' || next === '' },
        '修改密码并退出所有设备',
      ),
    ),
    message !== null
      ? createElement('p', { style: message.kind === 'ok' ? styles.ok : styles.error }, message.text)
      : null,
    createElement(
      'div',
      { style: styles.field },
      createElement('h3', { style: { margin: 0 } }, '已登录设备'),
      devices.length === 0
        ? createElement('p', { style: styles.small }, '暂无其他设备')
        : createElement(
            'ul',
            { style: styles.list },
            ...devices.map((device) =>
              createElement(
                'li',
                { key: device.deviceId, style: styles.item },
                createElement(
                  'div',
                  null,
                  createElement('div', null, device.deviceName ?? '未命名设备'),
                  createElement(
                    'div',
                    { style: styles.small },
                    `最后活跃：${new Date(device.lastSeenAt).toLocaleString()}${device.userAgent ? ` · ${device.userAgent.slice(0, 60)}` : ''}`,
                  ),
                ),
                createElement(
                  'button',
                  {
                    style: { ...styles.button, ...styles.danger },
                    onClick: () => void revoke(device.deviceId),
                    disabled: busy,
                  },
                  '踢出',
                ),
              ),
            ),
          ),
    ),
  )
}
