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

// Browser-side cordis row services: the Loader builds the row's inject from
// THIS export (dsh.client.inject in package.json is only boot metadata).
// 'slots' is provided by @deepseek-ai/dsh-client-runtime (client half).
export const inject = ['slots']

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

  // Watch API responses: an unexpected 401 on OUR gate endpoints (kicked /
  // expired / password changed) brings the gate back immediately. Scoped to
  // /api/lan-web/* — other endpoints can legitimately return 401 without
  // meaning "session dead", and popping the gate there would be wrong. The
  // login POST's 401 is the form's own error path and status probes already
  // decide on their own 401. showLoginGate() is idempotent (no-op when the
  // gate is already mounted), which dedupes concurrent 401s.
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await originalFetch(input, init)
    if (res.status === 401) {
      const url = toUrl(input)
      if (
        url !== null &&
        url.pathname.startsWith('/api/lan-web/') &&
        url.pathname !== LOGIN_URL &&
        url.pathname !== STATUS_URL
      ) {
        showLoginGate()
      }
    }
    return res
  }

  // --- M2: settings card (official settings.section slot) ------------
  ctx.slots.register(
    { name: 'settings.section', id: 'dsh-lan-web', label: '局域网访问', order: 100 },
    SettingsCard,
  )

  // --- M3: responsive styles (narrow viewport, touch-friendly) -------
  // Conservative generic rules: safe across GUI layout changes, desktop
  // unaffected (media query only). Layout-specific tuning is a M3 runtime
  // iteration item (needs real-device DOM inspection).
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-lan-web'
  style.textContent = `
@media (max-width: 768px) {
  html { -webkit-text-size-adjust: 100%; }
  button, a, [role="button"], input, select, textarea {
    min-height: 44px;
  }
  input, select, textarea { font-size: 16px; }
  body { overflow-x: hidden; }
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

/**
 * Normalize a fetch input to a URL resolved against the page origin.
 * Returns null for inputs that cannot be interpreted as a URL (the caller
 * then simply does not treat the response as a gate signal).
 */
function toUrl(input: RequestInfo | URL): URL | null {
  try {
    const raw =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input instanceof Request
            ? input.url
            : String(input)
    return new URL(raw, window.location.origin)
  } catch {
    return null
  }
}

export { hideLoginGate, showLoginGate }
