/**
 * dsh-lan-web — Host half (node side, runs in the DSH process).
 *
 * Responsibilities (see PLAN.md):
 *   M1: crypto.randomUUID polyfill for LAN plain-HTTP (non-secure context)
 *   M2: password login gate + session cookie + sliding renewal + rate limiting
 *   M3: session persistence (survives restarts), device list, kick-all
 * The 0.0.0.0 binding itself lives in cordis.patch.yml (webserver row override).
 */
import path from 'node:path'
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
// Side-effect type import: dsh-host-webserver augments Context with `webServer`.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { DEFAULT_LAN_WEB_CONFIG, lanWebConfigSchema, type LanWebConfig } from './config.ts'
import { LanWebStore } from './store.ts'
import { RateLimiter } from './rate-limit.ts'
import { registerLanWebRoutes } from './routes.ts'
import { registerMobileRoutes } from './mobile-routes.ts'
import { registerMobileProxy } from './mobile-proxy.ts'
import { POLYFILL_SCRIPT } from './crypto.ts'

export const name = 'dsh-lan-web'

export const inject = ['webServer']

/**
 * Mobile-UA redirect injected into the GUI index.html: a phone opening the
 * main address goes straight to the /lan mobile surface BEFORE any plugin
 * client bundle loads (the desktop GUI + every UI plugin stays desktop-only;
 * /lan is a self-contained bundle that loads none of them). Desktop UAs are
 * untouched; `?desktop=1` or the dsh_lan_web_ui=desktop cookie opt out.
 */
const MOBILE_REDIRECT_SCRIPT = `<script data-dsh-lan-web="ua-redirect">
(function () {
  var mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || navigator.maxTouchPoints >= 2;
  if (!mobile) return;
  var path = location.pathname;
  if (path === '/lan' || path.indexOf('/lan/') === 0) return;
  if (/(?:desktop|full)=1/.test(location.search)) return;
  if (document.cookie.indexOf('dsh_lan_web_ui=desktop') !== -1) return;
  try { document.cookie = 'dsh_lan_web_ui=mobile; path=/; max-age=31536000'; } catch (e) {}
  location.replace('/lan');
})();
</script>`

export function apply(ctx: Context) {
  // M1: polyfill for the browser GUI on LAN plain HTTP (idempotent guard).
  ctx.effect(() =>
    ctx.webServer.tapIndex((html: string) =>
      html.includes('randomUUID') ? html : html.replace('</head>', `${POLYFILL_SCRIPT}</head>`),
    ),
  )
  // M5: phones hitting the main address land on the mobile surface instead of
  // the plugin-heavy desktop GUI (desktop untouched; /lan is self-contained).
  ctx.effect(() =>
    ctx.webServer.tapIndex((html: string) =>
      html.includes('ua-redirect') ? html : html.replace('</head>', `${MOBILE_REDIRECT_SCRIPT}</head>`),
    ),
  )

  // M2: user-editable configuration via the `dsh-lan-web` settings namespace.
  let config: LanWebConfig = { ...DEFAULT_LAN_WEB_CONFIG }
  const namespace = settingsNamespace('dsh-lan-web')
  installSettingsSection(ctx, namespace, lanWebConfigSchema, DEFAULT_LAN_WEB_CONFIG, {
    setSource(current) {
      config = { ...DEFAULT_LAN_WEB_CONFIG, ...current() }
    },
    onChange() {
      // Nothing derived from config is cached; no action needed.
    },
  })

  // M2/M3: private store (password hash, epoch, sessions) + login rate limiter.
  const harnessHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const store = new LanWebStore({
    filePath: path.join(harnessHome, 'dsh-lan-web.json'),
    getSessionDays: () => config.sessionDays,
  })
  // Register routes IMMEDIATELY, then load persisted state asynchronously.
  // Before load() settles the store is empty → fail-closed (403 not_configured),
  // so there is no "unauthenticated window" during startup. A load failure is
  // logged (EACCES etc.) — the gate stays closed rather than opening.
  registerLanWebRoutes(ctx, {
    store,
    loginLimiter: new RateLimiter(10, 30_000),
    getSessionDays: () => config.sessionDays,
  })
  // M5: /lan mobile surface (app shell gated by the same login gate).
  registerMobileRoutes(ctx, store)
  // 0.3.0: mobile data-plane proxy — /api/lan-web/m/* + events bridge behind
  // the login gate (upgrade B). Disabled gracefully when apiProxy is absent.
  registerMobileProxy(ctx, store)
  store
    .load()
    .then(() => store.installExitFlush())
    .catch((error) => {
      console.error('[dsh-lan-web] failed to load session store, gate stays closed:', error)
    })

  // TODO(M4): HTTPS config fields; api/gate adapter slot for future DSH versions.
}
