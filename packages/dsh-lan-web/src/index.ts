/**
 * dsh-lan-web — Host half (node side, runs in the DSH process).
 *
 * Responsibilities (see PLAN.md):
 *   M1: crypto.randomUUID polyfill for LAN plain-HTTP (non-secure context)
 *   M2: password login gate + session cookie + rate limiting (TODO)
 *   M3: persistent sessions / device management (TODO)
 * The 0.0.0.0 binding itself lives in cordis.patch.yml (webserver row override).
 */
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: dsh-host-webserver augments Context with `webServer`.
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Fallback UUID v4 for non-secure contexts (LAN plain HTTP). */
function uuidV4Fallback(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

const POLYFILL_SCRIPT = `<script>
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  crypto.randomUUID = ${uuidV4Fallback.toString()};
}
</script>`

export const name = 'dsh-lan-web'

export const inject = ['webServer']

export function apply(ctx: Context) {
  // M1: inject the polyfill into index.html <head> (idempotent guard).
  ctx.webServer.tapIndex((html: string) =>
    html.includes('randomUUID') ? html : html.replace('</head>', `${POLYFILL_SCRIPT}</head>`),
  )

  // TODO(M2): login gate —
  //   settings namespace `dsh-lan-web` (password, sessionDays, httpsCert/httpsKey reserved)
  //   POST /api/lan-web/login | logout | status | devices/revoke
  //   session cookie (HttpOnly; SameSite=Lax; Max-Age=30d), loopback exempt
  //   rate limit: 10 attempts / 30s / source IP
  //   fail-closed: no password configured -> deny LAN access
  // TODO(M3): session persistence (survives restarts), device list, kick-all on password change
  // TODO(M4): HTTPS config fields; api/gate adapter slot for future DSH versions
}
