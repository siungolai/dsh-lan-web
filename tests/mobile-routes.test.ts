/**
 * Mobile surface (/lan) route tests: real node http server + real store.
 * Covers the dual-layer login gate on the page and bundle routes —
 * loopback exempt, LAN requires a valid session cookie.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { LanWebStore } from '../src/store.ts'
import { registerMobileRoutes } from '../src/mobile-routes.ts'
import { registerLanWebRoutes } from '../src/routes.ts'
import { RateLimiter } from '../src/rate-limit.ts'

class WebServerMock extends Service {
  handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>()

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register(route: { kind?: string; path?: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void {
    this.handlers.set(`${route.kind}:${route.path}`, route.handler)
    return () => {}
  }
}

interface TestEnv {
  store: LanWebStore
  server: http.Server
  base: string
  close: () => Promise<void>
}

async function setup(seedPassword = false): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lanweb-mobile-'))
  const filePath = path.join(dir, 'dsh-lan-web.json')
  const ctx = new Context()
  ctx.plugin(WebServerMock)
  const store = new LanWebStore({ filePath })
  if (seedPassword) {
    const { hashPassword } = await import('../src/crypto.ts')
    await store.setPasswordHash(await hashPassword('secret1'))
  }
  await store.load()
  registerLanWebRoutes(ctx, { store, loginLimiter: new RateLimiter(10, 30_000), getSessionDays: () => 30 })
  registerMobileRoutes(ctx, store)
  const web = ctx.get('webServer', false) as unknown as WebServerMock | undefined
  if (web === undefined) throw new Error('webServer mock missing')
  const server = http.createServer((req, res) => {
    const pathname = req.url?.split('?')[0] ?? '/'
    // exact routes win over the /api/lan-web prefix route.
    const handler = web.handlers.get(`exact:${pathname}`) ?? (pathname.startsWith('/api/lan-web') ? web.handlers.get('prefix:/api/lan-web') : undefined)
    if (handler === undefined) {
      res.writeHead(404).end()
      return
    }
    void handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    store,
    server,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

interface CallResult {
  status: number
  body: string
  contentType: string
  setCookie: string[]
}

async function call(base: string, pathname: string, cookie?: string, lanHost = false): Promise<CallResult> {
  const url = new URL(`${base}${pathname}`)
  const headers: Record<string, string> = {}
  if (cookie !== undefined) headers.cookie = cookie
  if (lanHost) headers.host = '192.0.2.7:3080'
  return new Promise<CallResult>((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers }, (res) => {
      let text = ''
      res.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8')
      })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: text, contentType: res.headers['content-type'] ?? '', setCookie: (res.headers['set-cookie'] ?? []) as string[] })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

let env: TestEnv

beforeEach(async () => {
  env = await setup(true)
})

afterEach(async () => {
  await env.close()
})

describe('mobile surface /lan gate', () => {
  it('loopback: serves the app shell', async () => {
    const res = await call(env.base, '/lan')
    expect(res.status).toBe(200)
    expect(res.contentType).toContain('text/html')
    expect(res.body).toContain('/lan/app.js')
    expect(res.body).not.toContain('id="pw"')
  })

  it('LAN without cookie: serves the login shell (no app shell)', async () => {
    const res = await call(env.base, '/lan', undefined, true)
    expect(res.status).toBe(200)
    expect(res.body).toContain('id="pw"')
    expect(res.body).not.toContain('/lan/app.js')
  })

  it('LAN with a valid session cookie: serves the app shell', async () => {
    const token = env.store.issue('mobile-test')
    const res = await call(env.base, '/lan', `dsh_lan_web_session=${token}`, true)
    expect(res.status).toBe(200)
    expect(res.body).toContain('/lan/app.js')
  })

  it('bundle: 401 for LAN without cookie, 200 for loopback', async () => {
    const denied = await call(env.base, '/lan/app.js', undefined, true)
    expect(denied.status).toBe(401)
    const ok = await call(env.base, '/lan/app.js')
    expect(ok.status).toBe(200)
    expect(ok.contentType).toContain('text/javascript')
    expect(ok.body.length).toBeGreaterThan(1000)
  })
})
