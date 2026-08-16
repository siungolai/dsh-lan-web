/**
 * dsh-lan-web — /api/lan-web/* HTTP routes (Host half).
 *
 * One prefix route owns the whole namespace; the handler dispatches on
 * pathname + method. Loopback requests are exempt from the login gate
 * (consistent with the platform trust fence); LAN requests must present a
 * valid session cookie. Sliding renewal re-issues the cookie on every
 * successful authenticated request.
 *
 * Endpoints:
 *   POST /api/lan-web/login           → 200 + Set-Cookie | 401 | 403 (not configured) | 429
 *   POST /api/lan-web/logout          → 200 (clears cookie)
 *   GET  /api/lan-web/status          → 200 {exempt|ok} | 401 {login:true}
 *   POST /api/lan-web/password        → 200 (kicks all sessions) | 400 | 401
 *   GET  /api/lan-web/devices         → 200 {devices:[...]} | 401
 *   POST /api/lan-web/devices/revoke  → 200 | 400 | 401
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { LanWebStore } from './store.ts'
import type { RateLimiter } from './rate-limit.ts'
import { hashPassword, verifyPassword } from './crypto.ts'

export const COOKIE_NAME = 'dsh_lan_web_session'
const BODY_LIMIT_BYTES = 4096
const MIN_PASSWORD_LENGTH = 4
const MAX_PASSWORD_LENGTH = 128

export interface LanWebDeps {
  store: LanWebStore
  loginLimiter: RateLimiter
  /** Sliding session lifetime in days (from settings); drives cookie Max-Age. */
  getSessionDays: () => number
}

export function registerLanWebRoutes(ctx: Context, deps: LanWebDeps): void {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: '/api/lan-web',
      handler: (req, res) => void handle(req, res, deps),
    }),
  )
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: LanWebDeps): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://lan-web.local').pathname
  const method = req.method ?? 'GET'
  try {
    switch (pathname) {
      case '/api/lan-web/login':
        if (method === 'POST') return await login(req, res, deps)
        break
      case '/api/lan-web/logout':
        if (method === 'POST') return logout(req, res, deps)
        break
      case '/api/lan-web/status':
        if (method === 'GET') return status(req, res, deps)
        break
      case '/api/lan-web/password':
        if (method === 'POST') return await changePassword(req, res, deps)
        break
      case '/api/lan-web/devices':
        if (method === 'GET') return devices(req, res, deps)
        break
      case '/api/lan-web/devices/revoke':
        if (method === 'POST') return await revokeDevice(req, res, deps)
        break
      default:
        break
    }
    writeJson(res, 404, { error: 'not_found' })
  } catch (err) {
    if (err instanceof Error && err.message === 'body_too_large') {
      writeJson(res, 413, { error: 'body_too_large' })
      return
    }
    if (err instanceof Error && err.message === 'invalid_json') {
      writeJson(res, 400, { error: 'bad_request' })
      return
    }
    writeJson(res, 500, { error: 'internal', detail: err instanceof Error ? err.message : String(err) })
  }
}

/* ----------------------------- helpers ----------------------------- */

export function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  const loopbackAddress =
    address === '::1' ||
    address === '127.0.0.1' ||
    address.startsWith('127.') ||
    address.startsWith('::ffff:127.')
  const host = (req.headers.host ?? '').toLowerCase()
  const loopbackHost =
    host === 'localhost' ||
    host.startsWith('localhost:') ||
    host === '[::1]' ||
    host.startsWith('[::1]:') ||
    host.startsWith('127.')
  return loopbackAddress && loopbackHost
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return undefined
}

function setSessionCookie(res: ServerResponse, token: string, maxAgeSec: number): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`,
  )
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        if (!tooLarge) {
          tooLarge = true
          // Reject early, but keep DRAINING the request stream instead of
          // req.destroy(): destroying the socket kills the connection before
          // the 413 response can be delivered (client sees a reset, not 413).
          reject(Object.assign(new Error('body_too_large'), { status: 413 }))
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return
      try {
        resolve(chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid_json'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Require a valid session for a LAN request. Loopback is exempt. On success
 * the sliding window is renewed (cookie re-issued). Returns the session
 * record, or null after writing the 401 response.
 */
function requireSession(req: IncomingMessage, res: ServerResponse, deps: LanWebDeps): ReturnType<LanWebStore['validate']> {
  if (isLoopback(req)) return {} as never // loopback: exempt (callers must not use the record)
  const token = readCookie(req, COOKIE_NAME)
  if (token === undefined) {
    writeJson(res, 401, { login: true })
    return null
  }
  const record = deps.store.validate(token)
  if (record === null) {
    clearSessionCookie(res)
    writeJson(res, 401, { login: true })
    return null
  }
  // Sliding renewal: re-issue the cookie with a fresh lifetime.
  setSessionCookie(res, token, deps.getSessionDays() * 86_400)
  return record
}

/* ----------------------------- handlers ----------------------------- */

async function login(req: IncomingMessage, res: ServerResponse, deps: LanWebDeps): Promise<void> {
  const ip = req.socket.remoteAddress ?? 'unknown'
  if (!deps.loginLimiter.allow(ip)) {
    writeJson(res, 429, { error: 'rate_limited' })
    return
  }
  if (!deps.store.hasPassword()) {
    writeJson(res, 403, { error: 'not_configured' })
    return
  }
  const body = await readJsonBody(req)
  const password = (body as { password?: unknown } | undefined)?.password
  if (typeof password !== 'string' || !(await verifyPassword(password, deps.store.passwordHash))) {
    writeJson(res, 401, { error: 'invalid_credentials' })
    return
  }
  const token = deps.store.issue(req.headers['user-agent'])
  setSessionCookie(res, token, deps.getSessionDays() * 86_400)
  writeJson(res, 200, { ok: true })
}

function logout(req: IncomingMessage, res: ServerResponse, deps: LanWebDeps): void {
  const token = readCookie(req, COOKIE_NAME)
  if (token !== undefined) deps.store.revoke(token)
  clearSessionCookie(res)
  writeJson(res, 200, { ok: true })
}

function status(req: IncomingMessage, res: ServerResponse, deps: LanWebDeps): void {
  if (isLoopback(req)) {
    writeJson(res, 200, { exempt: true, configured: deps.store.hasPassword() })
    return
  }
  if (requireSession(req, res, deps) !== null) writeJson(res, 200, { ok: true })
}

async function changePassword(req: IncomingMessage, res: ServerResponse, deps: LanWebDeps): Promise<void> {
  const body = await readJsonBody(req)
  const { current, next } = (body ?? {}) as { current?: unknown; next?: unknown }
  if (typeof next !== 'string' || next.length < MIN_PASSWORD_LENGTH || next.length > MAX_PASSWORD_LENGTH) {
    writeJson(res, 400, { error: 'invalid_password_length' })
    return
  }
  // First-time setup: no password exists yet. Only loopback (the host
  // machine) may claim it — a LAN client must never be able to grab
  // the gate. No `current` password is required (there is none).
  if (!deps.store.hasPassword()) {
    if (!isLoopback(req)) {
      writeJson(res, 403, { error: 'not_configured' })
      return
    }
    const hash = await hashPassword(next)
    await deps.store.setPasswordHash(hash)
    writeJson(res, 200, { ok: true, firstTime: true })
    return
  }
  // Established password: require an authenticated session and the
  // current password, then bump epoch + clear every session (kick-all).
  if (requireSession(req, res, deps) === null) return
  if (typeof current !== 'string' || !(await verifyPassword(current, deps.store.passwordHash))) {
    writeJson(res, 401, { error: 'invalid_credentials' })
    return
  }
  const hash = await hashPassword(next)
  await deps.store.setPasswordHash(hash)
  // Kick-all: the caller's own cookie is dead too; clear it here.
  clearSessionCookie(res)
  writeJson(res, 200, { ok: true, relogin: true })
}

function devices(req: IncomingMessage, res: ServerResponse, deps: LanWebDeps): void {
  if (requireSession(req, res, deps) === null) return
  writeJson(res, 200, { devices: deps.store.listDevices() })
}

async function revokeDevice(req: IncomingMessage, res: ServerResponse, deps: LanWebDeps): Promise<void> {
  if (requireSession(req, res, deps) === null) return
  const body = await readJsonBody(req)
  const deviceId = (body as { deviceId?: unknown } | undefined)?.deviceId
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    writeJson(res, 400, { error: 'bad_request' })
    return
  }
  deps.store.revokeByDevice(deviceId)
  writeJson(res, 200, { ok: true })
}
