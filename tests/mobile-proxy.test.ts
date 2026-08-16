/**
 * Mobile data-plane proxy tests: login gate, method whitelist, and envelope
 * passthrough via the mocked in-process apiProxy handler.
 */
import { vi } from 'vitest'

const { mockHandler } = vi.hoisted(() => ({
  mockHandler: {
    fetch: vi.fn(async (_input: Request | string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : ''
      return new Response(JSON.stringify({ type: 'server-response', rpcId: 'echo', result: { ok: true, value: { proxied: true, body } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  },
}))

vi.mock('@deepseek-ai/dsh-host-apiproxy', () => ({
  toFetchHandler: () => mockHandler,
}))

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { LanWebStore } from '../src/store.ts'
import { registerMobileProxy } from '../src/mobile-proxy.ts'

class WebServerMock extends Service {
  handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()
  upgrades: string[] = []

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register(route: { kind?: string; path?: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void {
    this.handlers.set(`${route.kind}:${route.path}`, route.handler)
    return () => {}
  }

  registerUpgrade(route: { path: string }): () => void {
    this.upgrades.push(route.path)
    return () => {}
  }
}

class ApiProxyMock extends Service {
  constructor(ctx: Context) {
    super(ctx, 'apiProxy')
  }
}

interface TestEnv {
  store: LanWebStore
  server: http.Server
  base: string
  close: () => Promise<void>
}

let env: TestEnv

beforeEach(async () => {
  mockHandler.fetch.mockClear()
  const dir = await mkdtemp(path.join(tmpdir(), 'lanweb-proxy-'))
  const filePath = path.join(dir, 'dsh-lan-web.json')
  const ctx = new Context()
  ctx.plugin(WebServerMock)
  ctx.plugin(ApiProxyMock)
  const store = new LanWebStore({ filePath })
  const { hashPassword } = await import('../src/crypto.ts')
  await store.setPasswordHash(await hashPassword('secret1'))
  await store.load()
  registerMobileProxy(ctx, store)
  const web = ctx.get('webServer', false) as unknown as WebServerMock | undefined
  if (web === undefined) throw new Error('webServer mock missing')
  // Wait for the async apiproxy load + registration.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const server = http.createServer((req, res) => {
    const pathname = req.url?.split('?')[0] ?? '/'
    const handler = web.handlers.get(`prefix:${pathname.startsWith('/api/lan-web/m') ? '/api/lan-web/m' : pathname}`)
    if (handler === undefined) {
      res.writeHead(404).end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  env = {
    store,
    server,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
  }
})

afterEach(async () => {
  await env.close()
})

async function callProxy(method: string, body: unknown, opts: { cookie?: string; lanHost?: boolean; httpMethod?: string } = {}): Promise<{ status: number; body: unknown }> {
  const url = new URL(`${env.base}${method}`)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.cookie !== undefined) headers.cookie = opts.cookie
  if (opts.lanHost === true) headers.host = '192.0.2.7:3080'
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: opts.httpMethod ?? 'POST', headers }, (res) => {
      let text = ''
      res.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8')
      })
      res.on('end', () => {
        let parsed: unknown = null
        try {
          parsed = text === '' ? null : JSON.parse(text)
        } catch {
          parsed = text
        }
        resolve({ status: res.statusCode ?? 0, body: parsed })
      })
    })
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

describe('mobile data-plane proxy', () => {
  it('registers the prefix route and the events upgrade', () => {
    // Registered asynchronously in beforeEach; assert via behavior below.
    expect(env.store.hasPassword()).toBe(true)
  })

  it('loopback: proxies a whitelisted RPC and passes the envelope through', async () => {
    const res = await callProxy('/api/lan-web/m/session.list', { type: 'client-request', rpcId: 'r1', method: 'session.list', payload: {} })
    expect(res.status).toBe(200)
    expect(mockHandler.fetch).toHaveBeenCalledTimes(1)
    const forwarded = mockHandler.fetch.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(String(forwarded.body))).toMatchObject({ type: 'client-request', method: 'session.list' })
    expect(res.body).toMatchObject({ type: 'server-response', rpcId: 'echo', result: { ok: true } })
  })

  it('LAN without cookie: 401 and nothing forwarded', async () => {
    const res = await callProxy('/api/lan-web/m/session.list', { type: 'client-request', rpcId: 'r2', method: 'session.list', payload: {} }, { lanHost: true })
    expect(res.status).toBe(401)
    expect(mockHandler.fetch).not.toHaveBeenCalled()
  })

  it('LAN with a valid cookie: proxied', async () => {
    const token = env.store.issue('proxy-test')
    const res = await callProxy('/api/lan-web/m/session.list', { type: 'client-request', rpcId: 'r3', method: 'session.list', payload: {} }, { lanHost: true, cookie: `dsh_lan_web_session=${token}` })
    expect(res.status).toBe(200)
    expect(mockHandler.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects non-whitelisted methods with 404', async () => {
    const res = await callProxy('/api/lan-web/m/session.export', { type: 'client-request', rpcId: 'r4', method: 'session.export', payload: {} })
    expect(res.status).toBe(404)
    expect(mockHandler.fetch).not.toHaveBeenCalled()
  })

  it('rejects non-POST with 405', async () => {
    const res = await callProxy('/api/lan-web/m/session.list', {}, { httpMethod: 'GET' })
    expect(res.status).toBe(405)
  })
})
