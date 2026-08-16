/**
 * dsh-lan-web — browser half (injected into the DSH web GUI).
 *
 * M2: full-screen login gate (direct DOM mount, see login-gate.tsx) +
 * settings card (official `settings.section` slot).
 * M3: responsive layout / touch-friendly styles (injected stylesheet).
 */
import { createElement } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ctx.slots typing and the settings-surface SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { hideLoginGate, showLoginGate } from './login-gate.tsx'
import { SettingsCard } from './settings-card.tsx'

export const name = 'dsh-lan-web-client'

const STATUS_URL = '/api/lan-web/status'
const LOGIN_URL = '/api/lan-web/login'

export function apply(ctx: ClientContext) {
  // --- M2: login gate ------------------------------------------------
  // Initial probe: loopback → {exempt:true} (no gate); valid session → {ok};
  // otherwise 401 → show the full-screen gate.
  void fetch(STATUS_URL)
    .then((res) => {
      if (res.status === 401) showLoginGate()
    })
    .catch(() => {
      /* network error: leave the GUI as-is; next probe will decide */
    })

  // Watch every API response: an unexpected 401 (kicked / expired / password
  // changed) brings the gate back immediately. The login POST itself is
  // excluded — its 401 is the gate's own error path.
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await originalFetch(input, init)
    if (res.status === 401) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input instanceof Request ? input.url : String(input)
      if (!url.includes(LOGIN_URL) && !url.includes(STATUS_URL)) showLoginGate()
    }
    return res
  }

  // --- M2: settings card (official settings.section slot) ------------
  ctx.slots.register({ name: 'settings.section', id: 'dsh-lan-web' }, SettingsCard)

  // --- M3: responsive styles (narrow viewport, touch-friendly) -------
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-lan-web'
  style.textContent = `
@media (max-width: 768px) {
  #root {
    --dsh-lan-web-mobile: 1;
  }
}
`
  document.head.appendChild(style)

  // Keep the gate honest on session expiry while the GUI is idle: a slow
  // periodic status probe refreshes the decision after background tabs wake.
  const timer = window.setInterval(() => {
    void fetch(STATUS_URL).then((res) => {
      if (res.status === 401) showLoginGate()
    })
  }, 60_000)
  ctx.effect(() => () => window.clearInterval(timer))
}

export { hideLoginGate, showLoginGate }
