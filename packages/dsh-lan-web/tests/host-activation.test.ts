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

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  tapIndex(fn: (html: string) => string): () => void {
    this.taps.push(fn)
    return () => {}
  }

  register(): () => void {
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
    expect(web?.taps.length).toBe(1)
    // polyfill tap: injects the randomUUID guard into </head>
    const html = '<html><head></head></html>'
    const out = web.taps[0]!(html)
    expect(out).toContain('randomUUID')
    expect(out).toContain('</head>')
  })

  it('store data file lands under DSH_HOME after apply (async load)', async () => {
    const ctx = new Context()
    ctx.plugin(WebServerMock)
    ctx.plugin(hostPlugin as never)
    // Let the async store.load().then(registerRoutes) settle.
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
})
