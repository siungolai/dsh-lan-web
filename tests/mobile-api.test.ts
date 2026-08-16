/**
 * Mobile API client tests: JSON-RPC envelope parsing against a mocked fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcError, listSessions, rpc, sendPrompt, sessionHistory } from '../src/mobile/api.ts'

const originalFetch = globalThis.fetch

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input instanceof Request ? input.url : String(input)
    return Promise.resolve(handler(url, init ?? {}))
  }) as unknown as typeof fetch
}

/** Build a server-response echoing the request's rpcId. */
function respondOk(requestBody: string, value: unknown): Response {
  const req = JSON.parse(requestBody) as { rpcId: string }
  return new Response(JSON.stringify({ type: 'server-response', rpcId: req.rpcId, result: { ok: true, value } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('rpc envelope', () => {
  it('posts a client-request envelope and returns the value', async () => {
    let seen: { url: string; body: unknown } | undefined
    mockFetch((url, init) => {
      seen = { url, body: JSON.parse(String(init.body)) }
      return respondOk(String(init.body), { items: [] })
    })
    const value = await rpc<{ items: unknown[] }>('session.list', {})
    expect(seen?.url).toBe('/api/lan-web/m/session.list')
    const body = seen?.body as { type: string; method: string; payload: unknown; rpcId: string }
    expect(body.type).toBe('client-request')
    expect(body.method).toBe('session.list')
    expect(body.payload).toEqual({})
    expect(body.rpcId.length).toBeGreaterThan(0)
    expect(value).toEqual({ items: [] })
  })

  it('throws RpcError with the server code on result.ok=false', async () => {
    mockFetch((_url, init) => {
      const req = JSON.parse(String(init.body)) as { rpcId: string }
      return new Response(JSON.stringify({ type: 'server-response', rpcId: req.rpcId, result: { ok: false, error: { code: 'session_busy', details: { reason: 'x' } } } }), { status: 200 })
    })
    await expect(sendPrompt('s1', 'hi')).rejects.toMatchObject({ name: 'RpcError', code: 'session_busy' })
  })

  it('surfaces HTTP 401 as RpcError with status', async () => {
    mockFetch(() => new Response('unauthorized', { status: 401 }))
    await expect(listSessions()).rejects.toMatchObject({ name: 'RpcError', status: 401 })
  })

  it('rejects a mismatched rpcId envelope', async () => {
    mockFetch(() => new Response(JSON.stringify({ type: 'server-response', rpcId: 'other', result: { ok: true, value: 1 } }), { status: 200 }))
    await expect(rpc<number>('session.list', {})).rejects.toMatchObject({ name: 'RpcError', code: 'bad_response' })
  })

  it('session.history passes beforeSeq/maxMessages through', async () => {
    let payload: unknown
    mockFetch((_url, init) => {
      const req = JSON.parse(String(init.body)) as { payload: unknown }
      payload = req.payload
      return respondOk(String(init.body), { events: [], hasMore: false })
    })
    await sessionHistory('s1', { beforeSeq: 10, maxMessages: 50 })
    expect(payload).toEqual({ sessionId: 's1', beforeSeq: 10, maxMessages: 50 })
  })
})
