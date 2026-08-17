/**
 * dsh-lan-web — mobile data-plane proxy (ROADMAP 0.3.0 upgrade B).
 *
 * Moves the /lan data plane BEHIND the login gate: the mobile page now calls
 * /api/lan-web/m/* instead of DSH's unauthenticated /api/*. Every proxied
 * RPC passes the same cookie gate as the login routes (loopback exempt), and
 * streaming events flow over a plugin-owned WebSocket (/api/lan-web/m/events)
 * that replays in-process session/event — never the ungated /api/events.mux.
 *
 * Forwarding is in-process (no HTTP loopback): InProcessApiClient over the
 * host's apiProxy service, with a strict method whitelist (the mobile
 * surface's RPC set only — sensitive endpoints stay out of the proxy).
 */
import { WebSocketServer } from 'ws'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { LanWebStore } from './store.ts'
import { COOKIE_NAME, isLoopback, readCookie } from './routes.ts'
// Type-only import: erased at compile time — no runtime resolution of
// dsh-host-apiproxy (its transitive tree only exists inside the DSH profile;
// the repository install skips peers via legacy-peer-deps).
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

const PROXY_PREFIX = '/api/lan-web/m'

/** RPC methods the mobile surface may proxy. Nothing else is exposed.
 * commands/execute is intentionally absent: permission switches go through
 * the documented session.prompt slash path (`/permission <preset>`), which
 * the host routes to the command registry. */
const MOBILE_METHODS = new Set([
  'session.list',
  'session.history',
  'session.prompt',
  'session.create',
  'session.models',
  'session.selectModel',
  'skill.list',
])

let rpcCounter = 0
function mintRpcId(): string {
  rpcCounter += 1
  return `lanweb-${Date.now().toString(36)}-${rpcCounter}`
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function isAuthed(req: IncomingMessage, store: LanWebStore): boolean {
  if (isLoopback(req)) return true
  const token = readCookie(req, COOKIE_NAME)
  return token !== undefined && store.validate(token) !== null
}

function readBody(req: IncomingMessage, limit = 32 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body_too_large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function registerMobileProxy(ctx: Context, store: LanWebStore): void {
  const apiProxy = ctx.get('apiProxy', false) as ApiProxy | undefined
  if (apiProxy === undefined) {
    console.warn('[dsh-lan-web] apiProxy service absent — mobile data-plane proxy disabled')
    return
  }
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: PROXY_PREFIX,
      handler: (req, res) => void handleProxy(req, res, store, apiProxy),
    }),
  )
  ctx.effect(() =>
    ctx.webServer.registerUpgrade({
      path: `${PROXY_PREFIX}/events`,
      handler: (req, socket, head) => handleEventsUpgrade(ctx, req, socket, head, store),
    }),
  )
}

/* ------------------------- in-process forwarding ------------------------- */

type RpcRequest = { type: 'client-request'; rpcId: string; method: string; payload: unknown }

/** Replay one envelope through the apiProxy method groups (no HTTP loopback).
 * Method-group params are typed RpcRequest<Payload>; the payload is validated
 * by the host's own zod schemas at the other end, so the generic envelope is
 * cast per call. */
async function forward(apiProxy: ApiProxy, request: RpcRequest): Promise<unknown> {
  switch (request.method) {
    case 'session.list':
      return apiProxy.sessions.list(request as unknown as Parameters<ApiProxy['sessions']['list']>[0])
    case 'session.history':
      return apiProxy.sessions.history(request as unknown as Parameters<ApiProxy['sessions']['history']>[0])
    case 'session.prompt':
      return apiProxy.sessions.prompt(request as unknown as Parameters<ApiProxy['sessions']['prompt']>[0])
    case 'session.create':
      return apiProxy.sessions.create(request as unknown as Parameters<ApiProxy['sessions']['create']>[0])
    case 'session.models':
      return apiProxy.sessions.models(request as unknown as Parameters<ApiProxy['sessions']['models']>[0])
    case 'session.selectModel':
      return apiProxy.sessions.selectModel(request as unknown as Parameters<ApiProxy['sessions']['selectModel']>[0])
    case 'skill.list':
      return apiProxy.skills.list(request as unknown as Parameters<ApiProxy['skills']['list']>[0])
    default:
      throw new Error(`method not whitelisted: ${request.method}`)
  }
}

/* ------------------------- RPC proxy ------------------------- */

async function handleProxy(req: IncomingMessage, res: ServerResponse, store: LanWebStore, apiProxy: ApiProxy): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://lan-web.local').pathname
  const method = pathname.slice(PROXY_PREFIX.length + 1)
  if (!MOBILE_METHODS.has(method)) {
    writeJson(res, 404, { error: 'not_found' })
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { error: 'method_not_allowed' })
    return
  }
  if (!isAuthed(req, store)) {
    writeJson(res, 401, { login: true })
    return
  }
  let raw: string
  try {
    raw = await readBody(req)
  } catch {
    writeJson(res, 413, { error: 'body_too_large' })
    return
  }
  let envelope: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  try {
    envelope = JSON.parse(raw) as typeof envelope
  } catch {
    writeJson(res, 400, { error: 'bad_request' })
    return
  }
  const rpcId = typeof envelope.rpcId === 'string' ? envelope.rpcId : mintRpcId()
  if (envelope.type !== 'client-request' || envelope.method !== method) {
    writeJson(res, 400, { error: 'bad_request' })
    return
  }
  try {
    // The method groups return full RpcResponse envelopes — pass through.
    const response = await forward(apiProxy, { type: 'client-request', rpcId, method, payload: envelope.payload })
    writeJson(res, 200, response)
  } catch (error) {
    writeJson(res, 200, {
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } },
    })
  }
}

/* ------------------------- events bridge (WS) ------------------------- */

const wss = new WebSocketServer({ noServer: true })

function handleEventsUpgrade(ctx: Context, req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, store: LanWebStore): void {
  if (!isAuthed(req, store)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const sessions = ctx.get('sessions')
    const send = (payload: unknown): void => {
      if (ws.readyState === ws.OPEN) {
        const frame = { type: 'server-request', rpcId: mintRpcId(), method: (payload as { type: string }).type, payload }
        ws.send(JSON.stringify(frame))
      }
    }
    if (sessions !== undefined) {
      for (const session of sessions.list()) {
        send({ type: 'session/subscribed', sessionId: session.id, lastSeq: session.seq - 1 })
      }
    }
    const disposers = [
      ctx.on('session/event', (session: { id: string }, event: unknown) => {
        send({ type: 'session/event', sessionId: session.id, event })
      }),
      ctx.on('session/created', (session: { id: string; seq: number }) => {
        send({ type: 'session/subscribed', sessionId: session.id, lastSeq: session.seq - 1 })
      }),
    ]
    ws.on('close', () => {
      for (const dispose of disposers) dispose()
    })
  })
}
