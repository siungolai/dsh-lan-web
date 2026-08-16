/**
 * Host-half activation smoke test: real cordis Context + webServer mock +
 * real plugin entry (src/index.ts). Verifies the apply() path does not throw
 * and registers the polyfill tap — the exact failure class that took down
 * the web profile before (client-half `slots` inject, see client test).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import * as hostPlugin from '../src/index.ts'

/** Minimal webServer stand-in (tapIndex/register contract only). */
class WebServerMock extends Service {
  taps: Array<(html: string) => string> = []
  routes: Array<{ kind?: string; path?: string }> = []

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  tapIndex(fn: (html: string) => string): () => void {
    this.taps.push(fn)
    return () => {}
  }

  register(route: { kind?: string; path?: string; handler: unknown }): () => void {
    this.routes.push(route)
    return () => {}
  }
}

let home: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'lanweb-host-'))
  // The plugin derives its data file from DSH_HOME; isolate it from the real one.
  process.env.DSH_HOME = home
})

afterEach(async () => {
  delete process.env.DSH_HOME
  await rm(home, { recursive: true, force: true })
})

describe('host half activation', () => {
  it('applies under cordis with inject services present', async () => {
    const ctx = new Context()
    ctx.plugin(WebServerMock)
    ctx.plugin(hostPlugin as never) // {name, inject: ['webServer'], apply}
    await new Promise((resolve) => setTimeout(resolve, 20))
    const web = ctx.get('webServer', false) as unknown as WebServerMock | undefined
    expect(web?.taps.length).toBe(2)
    const html = '<html><head></head></html>'
    // polyfill tap: injects the randomUUID guard into </head>
    const polyfill = web.taps.find((t) => t(html).includes('randomUUID'))
    expect(polyfill).toBeDefined()
    expect(polyfill!(html)).toContain('</head>')
    // mobile-UA tap: redirects phones off the plugin-heavy desktop GUI to /lan
    const redirect = web.taps.find((t) => t(html).includes('ua-redirect'))
    expect(redirect).toBeDefined()
    const out = redirect!(html)
    expect(out).toContain("location.replace('/lan')")
    expect(out).toContain("dsh_lan_web_ui=desktop")
  })

  it('registers the /api/lan-web prefix route while the async store load settles', async () => {
    const ctx = new Context()
    ctx.plugin(WebServerMock)
    ctx.plugin(hostPlugin as never)
    // The async store.load() under the isolated DSH_HOME must settle without
    // an unhandled rejection; route registration is immediate so the gate is
    // fail-closed before load() completes (empty store refuses LAN access).
    await new Promise((resolve) => setTimeout(resolve, 50))
    const web = ctx.get('webServer', false) as unknown as WebServerMock | undefined
    expect(web?.routes.some((r) => r.path === '/api/lan-web' && r.kind === 'prefix')).toBe(true)
  })
})
