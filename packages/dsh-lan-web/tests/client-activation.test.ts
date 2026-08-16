/**
 * Client-half activation test: reproduces the browser-side cordis row
 * semantics that previously crashed the web GUI —
 *   "cannot get property 'slots' without inject".
 *
 * The Loader builds the browser row's inject from the client half's own
 * `export const inject` (package.json dsh.client.inject is only boot
 * metadata). This test asserts that with `inject: ['slots']` exported and a
 * slots service provided (as dsh-client-runtime does), apply() registers the
 * settings card and mounts the gate machinery without throwing.
 */
// @vitest-environment jsdom
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import * as clientModule from '../src/client/index.ts'

class SlotsMock extends Service {
  registrations: Array<{ name: string; id?: string }> = []

  constructor(ctx: Context) {
    super(ctx, 'slots')
  }

  register(options: { name: string; id?: string }): () => void {
    this.registrations.push(options)
    return () => {}
  }
}

let dom: JSDOM

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://192.0.2.7:3080/',
  })
  // @ts-expect-error vitest jsdom globals are set by the environment; we
  // replace them with our own JSDOM instance to control the URL.
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  // The client half reads `window.fetch` (jsdom), so both globals must be mocked.
  const okFetch = async () => ({ status: 200 }) as Response
  globalThis.fetch = okFetch
  dom.window.fetch = okFetch
})

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch
})

describe('client half activation', () => {
  it('exports slots in the browser-row inject list', () => {
    expect(clientModule.inject).toContain('slots')
  })

  it('applies under cordis with a slots service and registers the settings card', async () => {
    const ctx = new Context()
    ctx.plugin(SlotsMock)
    ctx.plugin({
      inject: clientModule.inject,
      apply: clientModule.apply,
    } as never)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const slots = ctx.get('slots', false) as unknown as SlotsMock | undefined
    expect(slots?.registrations.some((r) => r.name === 'settings.section' && r.id === 'dsh-lan-web')).toBe(true)
    // Gate machinery: no overlay should be mounted for an authenticated status.
    expect(document.body.querySelector('div[style*="2147483000"]')).toBeNull()
  })

  it('shows the gate when status returns 401 (LAN unauthenticated)', async () => {
    const gateFetch = async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/lan-web/status')) {
        return { status: 401 } as Response
      }
      return { status: 200 } as Response
    }
    globalThis.fetch = gateFetch
    dom.window.fetch = gateFetch
    const ctx = new Context()
    ctx.plugin(SlotsMock)
    ctx.plugin({ inject: clientModule.inject, apply: clientModule.apply } as never)
    // Let the async status probe settle.
    await new Promise((resolve) => setTimeout(resolve, 120))
    const overlay = document.body.querySelector('div[style*="2147483000"]')
    expect(overlay).not.toBeNull()
  })
})
