/**
 * Routes end-to-end tests: real node http server + real LanWebStore +
 * registerLanWebRoutes. Covers first-time password setup (loopback only),
 * login, cookie sessions, kick-all, and rate limiting.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { LanWebStore } from '../src/store.ts'
import { RateLimiter } from '../src/rate-limit.ts'
import { registerLanWebRoutes } from '../src/routes.ts'

class WebServerMock extends Service {
  handler: ((req: IncomingMessage, res: ServerResponse) => void | Promise<void>) | undefined

  constructor(ctx: Context) {
    super(ctx, 'webServer')
  }

  register(route: { handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void {
    this.handler = route.handler
    return () => {}
  }
}

interface TestEnv {
  store: LanWebStore
  server: http.Server
  base: string
  close: () => Promise<void>
}

let env: TestEnv

async function setupStore(initialHash = ''): Promise<TestEnv> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lanweb-routes-'))
  const filePath = path.join(dir, 'dsh-lan-web.json')
  const ctx = new Context()
  ctx.plugin(WebServerMock)
  const store = new LanWebStore({ filePath })
  if (initialHash !== '') await store.setPasswordHash(initialHash)
  await store.load()
  registerLanWebRoutes(ctx, { store, loginLimiter: new RateLimiter(10, 30_000) })
  const web = ctx.get('webServer', false) as unknown as WebServerMock | undefined
  if (web?.handler === undefined) throw new Error('route handler not registered')
  const server = http.createServer((req, res) => void web.handler!(req, res))
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
  body: unknown
  setCookie: string[]
}

async function call(
  base: string,
  method: string,
  pathname: string,
  opts: { body?: unknown; cookie?: string; lanHost?: boolean } = {},
): Promise<CallResult> {
  const url = new URL(`${base}${pathname}`)
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  if (opts.cookie !== undefined) headers.cookie = opts.cookie
  // Simulate a LAN client by presenting a non-loopback Host header.
  // http.request (unlike undici fetch) permits the Host header.
  if (opts.lanHost === true) headers.host = '192.0.2.7:3080'
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  return new Promise<CallResult>((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, path: url.pathname, method, headers },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => {
          text += chunk.toString('utf8')
        })
        res.on('end', () => {
          let parsed: unknown = null
          if (text !== '') {
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = text
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, setCookie: (res.headers['set-cookie'] ?? []) as string[] })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

beforeEach(async () => {
  env = await setupStore()
})

afterEach(async () => {
  await env.close()
})

describe('first-time password setup', () => {
  it('loopback (host machine) may claim the first password without `current`', async () => {
    const res = await call(env.base, 'POST', '/api/lan-web/password', { body: { next: 'secret1' } })
    expect(res.status).toBe(200)
    expect((res.body as { firstTime?: boolean }).firstTime).toBe(true)
    expect(env.store.hasPassword()).toBe(true)
  })

  it('LAN clients are refused first-time setup (403, no password stealing)', async () => {
    const res = await call(env.base, 'POST', '/api/lan-web/password', { body: { next: 'secret1' }, lanHost: true })
    expect(res.status).toBe(403)
    expect(env.store.hasPassword()).toBe(false)
  })

  it('invalid password length is rejected even for first-time setup', async () => {
    const res = await call(env.base, 'POST', '/api/lan-web/password', { body: { next: 'ab' } })
    expect(res.status).toBe(400)
    expect(env.store.hasPassword()).toBe(false)
  })
})

describe('login', () => {
  it('rejects login before any password is configured (fail-closed)', async () => {
    const res = await call(env.base, 'POST', '/api/lan-web/login', { body: { password: 'x' }, lanHost: true })
    expect(res.status).toBe(403)
    expect((res.body as { error?: string }).error).toBe('not_configured')
  })

  it('accepts the configured password and issues a session cookie', async () => {
    const e = await withPassword('secret1')
    try {
      const res = await call(e.base, 'POST', '/api/lan-web/login', { body: { password: 'secret1' }, lanHost: true })
      expect(res.status).toBe(200)
      expect(res.setCookie.some((c) => c.startsWith('dsh_lan_web_session='))).toBe(true)
      expect(res.setCookie.some((c) => c.includes('HttpOnly') && c.includes('SameSite=Lax'))).toBe(true)
    } finally {
      await e.close()
    }
  })

  it('rejects a wrong password with 401', async () => {
    const e = await withPassword('secret1')
    try {
      const res = await call(e.base, 'POST', '/api/lan-web/login', { body: { password: 'wrong' }, lanHost: true })
      expect(res.status).toBe(401)
    } finally {
      await e.close()
    }
  })

  it('rate limits repeated failed attempts (429 after 10)', async () => {
    const e = await withPassword('secret1')
    try {
      for (let i = 0; i < 10; i += 1) {
        const res = await call(e.base, 'POST', '/api/lan-web/login', { body: { password: 'wrong' }, lanHost: true })
        expect(res.status).toBe(401)
      }
      const blocked = await call(e.base, 'POST', '/api/lan-web/login', { body: { password: 'secret1' }, lanHost: true })
      expect(blocked.status).toBe(429)
    } finally {
      await e.close()
    }
  })
})

describe('session gate', () => {
  it('status: loopback exempt, LAN without cookie 401, LAN with cookie 200', async () => {
    const e = await withPassword('secret1')
    try {
      const loopback = await call(e.base, 'GET', '/api/lan-web/status')
      expect(loopback.status).toBe(200)
      expect((loopback.body as { exempt?: boolean }).exempt).toBe(true)

      const noCookie = await call(e.base, 'GET', '/api/lan-web/status', { lanHost: true })
      expect(noCookie.status).toBe(401)

      const login = await call(e.base, 'POST', '/api/lan-web/login', { body: { password: 'secret1' }, lanHost: true })
      const cookie = login.setCookie[0]!.split(';')[0]!
      const withCookie = await call(e.base, 'GET', '/api/lan-web/status', { lanHost: true, cookie })
      expect(withCookie.status).toBe(200)
    } finally {
      await e.close()
    }
  })

  it('logout revokes the session', async () => {
    const e = await withPassword('secret1')
    try {
      const login = await call(e.base, 'POST', '/api/lan-web/login', { body: { password: 'secret1' }, lanHost: true })
      const cookie = login.setCookie[0]!.split(';')[0]!
      await call(e.base, 'POST', '/api/lan-web/logout', { lanHost: true, cookie })
      const after = await call(e.base, 'GET', '/api/lan-web/status', { lanHost: true, cookie })
      expect(after.status).toBe(401)
    } finally {
      await e.close()
    }
  })
})

describe('password change (established)', () => {
  it('requires the current password and kicks all sessions', async () => {
    const e = await withPassword('secret1')
    try {
      // LAN without session: 401
      const noSession = await call(e.base, 'POST', '/api/lan-web/password', {
        body: { current: 'secret1', next: 'secret2' },
        lanHost: true,
      })
      expect(noSession.status).toBe(401)

      // LAN with session + correct current password: success + kick-all
      const login = await call(e.base, 'POST', '/api/lan-web/login', { body: { password: 'secret1' }, lanHost: true })
      const cookie = login.setCookie[0]!.split(';')[0]!
      const change = await call(e.base, 'POST', '/api/lan-web/password', {
        body: { current: 'secret1', next: 'secret2' },
        lanHost: true,
        cookie,
      })
      expect(change.status).toBe(200)
      expect((change.body as { relogin?: boolean }).relogin).toBe(true)
      // Old session is dead even with the old cookie (epoch bump + clear).
      const after = await call(e.base, 'GET', '/api/lan-web/status', { lanHost: true, cookie })
      expect(after.status).toBe(401)
      // Old password no longer works; new one does.
      const oldLogin = await call(e.base, 'POST', '/api/lan-web/login', { body: { password: 'secret1' }, lanHost: true })
      expect(oldLogin.status).toBe(401)
      const newLogin = await call(e.base, 'POST', '/api/lan-web/login', { body: { password: 'secret2' }, lanHost: true })
      expect(newLogin.status).toBe(200)
    } finally {
      await e.close()
    }
  })

  it('rejects a wrong current password with 401', async () => {
    const e = await withPassword('secret1')
    try {
      const res = await call(e.base, 'POST', '/api/lan-web/password', {
        body: { current: 'nope', next: 'secret2' },
      })
      expect(res.status).toBe(401)
    } finally {
      await e.close()
    }
  })
})

/** Fresh env whose store is seeded with a password hash (independent of the shared env). */
async function withPassword(password: string): Promise<TestEnv> {
  const { hashPassword } = await import('../src/crypto.ts')
  const hash = await hashPassword(password)
  return setupStore(hash)
}
