/**
 * dsh-lan-web — mobile surface WebSocket client for /api/events.mux.
 *
 * Wire facts (verified): the mux is a DOWNSTREAM-ONLY channel (sending an
 * upstream message gets the socket closed with 1008). Every wire frame is a
 * `server-request` ENVELOPE {type, rpcId, method, payload} where method ===
 * payload.type — e.g. method 'session/event' with payload
 * {type:'session/event', sessionId, event, view?}. On connect the server
 * pushes one `session/subscribed {sessionId, lastSeq}` baseline per live
 * session. No heartbeats, no subscribe frames. Reconnect = reopen the
 * stream; the app re-pulls history for the open conversation (higher seq
 * wins). A `stream/error` payload closes the socket.
 */
export interface MuxEventFrame {
  type: 'session/event'
  sessionId: string
  event: import('./api.ts').SessionEvent
  view?: unknown
}

export interface ApprovalRequestedFrame {
  type: 'approval/requested'
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

export interface ApprovalResolvedFrame {
  type: 'approval/resolved'
  sessionId: string
  approvalId: string
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
}

export interface QuestionRequestedFrame {
  type: 'question/requested'
  sessionId: string
  questions: Array<{ id: string; question: string; header?: string; detail?: string }>
}

export interface QuestionResolvedFrame {
  type: 'question/resolved'
  sessionId: string
  questionRpcId: string
  outcome: 'answered' | 'cancelled'
}

export type MuxFrame =
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  | MuxEventFrame
  | ApprovalRequestedFrame
  | ApprovalResolvedFrame
  | QuestionRequestedFrame
  | QuestionResolvedFrame
  | { type: 'session/queue' | 'session/jobs'; sessionId: string }
  | { type: 'session/projection'; sessionId: string; key: string; value: unknown; seq: number }
  | { type: 'stream/error' }
  | { type: string; [key: string]: unknown }

/** Wire envelope: {type:'server-request', rpcId, method, payload}. */
interface MuxEnvelope {
  type?: unknown
  method?: unknown
  payload?: unknown
}

export interface MuxClientOptions {
  /** Called with every mux frame (already parsed). */
  onFrame: (frame: MuxFrame) => void
  /** Called after a reconnect when fresh baselines were received. */
  onResync?: () => void
}

const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15000

export class MuxClient {
  private ws: WebSocket | null = null
  private retry = 0
  private resynced = false
  private visibilityHandler: (() => void) | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(private readonly options: MuxClientOptions) {}

  connect(): void {
    this.resynced = false
    // No heartbeats exist on this channel (protocol is downstream-only, an
    // upstream ping would get the socket closed with 1008) — a sleeping phone
    // can silently half-open the connection. Reconnect when the tab returns.
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.ws.close()
    }
    document.addEventListener('visibilitychange', onVisibility)
    this.visibilityHandler = onVisibility
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/events.mux`)
    this.ws = ws
    ws.onmessage = (event: MessageEvent<string>) => {
      let envelope: MuxEnvelope
      try {
        envelope = JSON.parse(String(event.data)) as MuxEnvelope
      } catch {
        return
      }
      if (envelope.type !== 'server-request' || typeof envelope.method !== 'string') return
      const frame = (envelope.payload ?? {}) as MuxFrame
      this.options.onFrame(frame)
      if (frame.type === 'session/subscribed' && !this.resynced) {
        // First baseline after (re)connect: the stream is live again. Fire
        // once per connection — one frame per live session.
        this.resynced = true
        this.retry = 0
        this.options.onResync?.()
      } else if (frame.type === 'stream/error') {
        ws.close()
      }
    }
    ws.onclose = () => {
      this.ws = null
      if (this.disposed) return
      const delay = Math.min(RETRY_BASE_MS * 2 ** this.retry, RETRY_MAX_MS)
      this.retry += 1
      this.retryTimer = setTimeout(() => this.connect(), delay)
    }
    ws.onerror = () => {
      ws.close()
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    if (this.visibilityHandler !== null) document.removeEventListener('visibilitychange', this.visibilityHandler)
    this.visibilityHandler = null
    this.ws?.close()
    this.ws = null
  }
}
