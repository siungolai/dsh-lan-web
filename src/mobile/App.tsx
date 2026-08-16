/**
 * dsh-lan-web — mobile surface app: two-level UI (list ⇄ conversation).
 *
 * Dark theme, ≥44px touch targets, keyboard avoidance via visualViewport,
 * safe-area insets. Data: session.list / session.history / session.prompt
 * over the JSON-RPC envelope + live assistant streaming over /api/events.mux.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RpcError,
  createSession,
  listSessions,
  listSkills,
  sendPrompt,
  sessionHistory,
  titleOf,
  type HistoryEntry,
  type SessionEvent,
  type SessionSummary,
  type SkillSummary,
} from './api'
import { MuxClient, type ApprovalRequestedFrame, type ApprovalResolvedFrame, type MuxEventFrame, type MuxFrame, type QuestionRequestedFrame } from './mux'
import { useViewport } from './useViewport'
import { SkillMenu, detectSkillGesture, filterSkills, replaceGesture } from './skill-menu'

export type MessageKind = 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'tool-pending' | 'approval' | 'question' | 'todo'

export interface Message {
  key: string
  kind: MessageKind
  role: 'user' | 'assistant'
  text: string
  done: boolean
  seq: number
  /** Host-computed view card type ('terminal', …) for tool messages. */
  card?: string
}

const HISTORY_PAGE = 50
const LIST_REFRESH_MS = 2000

function textOfBlocks(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    .join('')
}

/**
 * Extract the plain text of a user/assistant message event. Wire shapes
 * (verified against the live API): user/message carries the message flat in
 * `data.content`, while assistant/message nests it at `data.message.content`
 * ({turn, step, message, usage}). Both are handled here.
 */
export function messageText(event: SessionEvent): string {
  const data = event.data as { content?: unknown; message?: { content?: unknown } }
  return textOfBlocks(data.message?.content ?? data.content)
}

/** Tool card icon by host card type / tool name (desktop-like visual cues). */
const TOOL_ICONS: Record<string, string> = {
  terminal: '>_',
  bash: '>_',
  read: '📖',
  write: '✏️',
  think: '🧠',
  web_search: '🔍',
  glob: '🗂️',
  grep: '🔎',
  edit: '🖊️',
}

function toolIcon(card: string | undefined, name: string | undefined): string {
  return TOOL_ICONS[(card ?? name ?? '').toLowerCase()] ?? '🔧'
}

function summarizeToolCall(data: { name?: unknown; arguments?: unknown }, view: unknown): string {
  const title = (view as { view?: { title?: unknown } } | undefined)?.view?.title
  if (typeof title === 'string' && title.length > 0) return title.length > 80 ? `${title.slice(0, 80)}…` : title
  const name = typeof data.name === 'string' ? data.name : 'tool'
  const args = typeof data.arguments === 'string' ? data.arguments : ''
  return args.length > 80 ? `${name} ${args.slice(0, 80)}…` : `${name} ${args}`.trim()
}

function summarizeToolResult(view: unknown): string {
  const output = (view as { view?: { output?: unknown } } | undefined)?.view?.output
  if (typeof output === 'string' && output.length > 0) return output.length > 120 ? `${output.slice(0, 120)}…` : output
  return '（无输出）'
}

/** Key of the reasoning block for a turn. */
const reasoningKey = (turn: number): string => `r-${turn}`

export function deriveMessages(entries: HistoryEntry[]): Message[] {
  const out: Message[] = []
  const reasoning = new Map<number, { text: string; seq: number }>()

  const flushReasoning = (turn: number): void => {
    const r = reasoning.get(turn)
    if (r !== undefined && r.text.length > 0) {
      out.push({ key: reasoningKey(turn), kind: 'reasoning', role: 'assistant', text: r.text, done: true, seq: r.seq })
      reasoning.delete(turn)
    }
  }

  for (const { event, view } of entries) {
    const data = (event.data ?? {}) as { turn?: number; chunk?: { type?: string; text?: string }; name?: string; arguments?: string }
    if (event.type === 'user/message' || event.type === 'assistant/message') {
      if (event.type === 'assistant/message') flushReasoning(data.turn ?? 0)
      out.push({
        key: `${event.type === 'user/message' ? 'u' : 'a'}-${event.seq}`,
        kind: 'text',
        role: event.type === 'user/message' ? 'user' : 'assistant',
        text: messageText(event),
        done: true,
        seq: event.seq,
      })
    } else if (event.type === 'tool/call') {
      out.push({
        key: `tc-${event.seq}`,
        kind: 'tool-call',
        role: 'assistant',
        text: summarizeToolCall(data, view),
        done: true,
        seq: event.seq,
        card: (view as { view?: { card?: string } } | undefined)?.view?.card,
      })
    } else if (event.type === 'tool/result') {
      out.push({
        key: `tr-${event.seq}`,
        kind: 'tool-result',
        role: 'assistant',
        text: summarizeToolResult(view),
        done: true,
        seq: event.seq,
        card: (view as { view?: { card?: string } } | undefined)?.view?.card,
      })
    } else if (event.type === 'approval/asked') {
      const ad = data as { id?: unknown; toolName?: unknown; reason?: unknown }
      out.push({
        key: `ap-${String(ad.id ?? event.seq)}`,
        kind: 'approval',
        role: 'assistant',
        text: `${typeof ad.toolName === 'string' ? ad.toolName : '工具'}${typeof ad.reason === 'string' ? `：${ad.reason}` : ''}`,
        done: false,
        seq: event.seq,
      })
    } else if (event.type === 'approval/decided') {
      const ad = data as { id?: unknown }
      out.push({
        key: `ap-${String(ad.id ?? event.seq)}`,
        kind: 'approval',
        role: 'assistant',
        text: '审批已处理',
        done: true,
        seq: event.seq,
      })
    } else if (event.type === 'todo/write') {
      const td = data as { todos?: Array<{ content?: unknown; status?: unknown }> }
      const todos = Array.isArray(td.todos) ? td.todos : []
      const doneCount = todos.filter((t) => t.status === 'completed').length
      out.push({
        key: `tw-${event.seq}`,
        kind: 'todo',
        role: 'assistant',
        text: todos.length > 0 ? `任务清单（${doneCount}/${todos.length} 完成）` : '任务清单',
        done: true,
        seq: event.seq,
      })
    } else if (event.type === 'assistant/chunk' && data.chunk?.type === 'reasoning-delta' && typeof data.chunk.text === 'string') {
      const turn = data.turn ?? 0
      const cur = reasoning.get(turn) ?? { text: '', seq: event.seq }
      cur.text += data.chunk.text
      reasoning.set(turn, cur)
    } else if (event.type === 'assistant/chunk' && data.chunk?.type === 'text-delta') {
      flushReasoning(data.turn ?? 0)
    } else if (event.type === 'turn/end') {
      flushReasoning(data.turn ?? 0)
    }
  }
  for (const [turn, r] of reasoning) {
    if (r.text.length > 0) out.push({ key: reasoningKey(turn), kind: 'reasoning', role: 'assistant', text: r.text, done: true, seq: r.seq })
  }
  return out
}

/**
 * Merge a fresh history page into the already-rendered messages WITHOUT
 * dropping them: only messages with seq beyond the current maximum are new
 * (pages are ascending; a resync page overlaps the tail of what we have).
 * This is what keeps older loaded pages alive across WS reconnects.
 */
export function mergeDerived(prev: Message[], derived: Message[]): Message[] {
  const maxSeq = prev.reduce((max, m) => Math.max(max, m.seq), 0)
  const fresh = derived.filter((m) => m.seq > maxSeq)
  return fresh.length > 0 ? [...prev, ...fresh] : prev
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay) return hhmm
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmm}`
}

export function App({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [listError, setListError] = useState<string | null>(null)
  const [view, setView] = useState<{ kind: 'list' } | { kind: 'conv'; sessionId: string }>({ kind: 'list' })
  const [messages, setMessages] = useState<Message[]>([])
  const [convTitle, setConvTitle] = useState('')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [skillMenu, setSkillMenu] = useState<{ candidates: SkillSummary[]; loading: boolean; error: string | null } | null>(null)
  const skillsCache = useRef(new Map<string, SkillSummary[]>())
  const gestureRef = useRef<{ start: number; cursor: number; seq: number } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [creating, setCreating] = useState(false)
  const [scrolledUp, setScrolledUp] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const viewport = useViewport()
  const scrollRef = useRef<HTMLDivElement>(null)
  const appliedSeqRef = useRef(0)
  const listRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view

  /* ------------------------- list ------------------------- */
  const refreshList = useCallback(async (): Promise<void> => {
    try {
      const items = await listSessions()
      items.sort((a, b) => b.updatedAt - a.updatedAt)
      setSessions(items)
      setListError(null)
    } catch (error) {
      if (error instanceof RpcError && error.status === 401) {
        onSessionExpired()
        return
      }
      setListError(error instanceof Error ? error.message : String(error))
    }
  }, [onSessionExpired])

  const scheduleListRefresh = useCallback((): void => {
    if (listRefreshTimer.current !== null) return
    listRefreshTimer.current = setTimeout(() => {
      listRefreshTimer.current = null
      void refreshList()
    }, LIST_REFRESH_MS)
  }, [refreshList])

  useEffect(() => {
    void refreshList()
  }, [refreshList])

  // System/hardware back button pops the conversation back to the list
  // (spec: two-level navigation with back).
  useEffect(() => {
    const onPop = (): void => setView({ kind: 'list' })
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /* ------------------------- conversation ------------------------- */
  const openConversation = useCallback(
    async (sessionId: string): Promise<void> => {
      setView({ kind: 'conv', sessionId })
      history.pushState({ surface: 'conv' }, '')
      setMessages([])
      setHasMore(false)
      setConvTitle('')
      setSendError(null)
      appliedSeqRef.current = 0
      setLoadingHistory(true)
      try {
        const result = await sessionHistory(sessionId, { maxMessages: HISTORY_PAGE })
        const derived = deriveMessages(result.events)
        setHasMore(result.hasMore)
        const last = result.events[result.events.length - 1]
        const loadedSeq = last !== undefined ? last.event.seq : 0
        // Never roll the guard backwards: live events may already have raised
        // it past the snapshot's tail while the page was loading.
        appliedSeqRef.current = Math.max(appliedSeqRef.current, loadedSeq)
        // Live events that arrived while the page was loading (seq > loadedSeq)
        // must survive the history swap — including in-flight turn-N streams
        // (this also covers the reconnect resync path).
        setMessages((prev) => [...derived, ...prev.filter((m) => m.seq > loadedSeq)])
        const session = (await listSessions()).find((s) => s.sessionId === sessionId)
        setConvTitle(session !== undefined ? titleOf(session) : '')
      } catch (error) {
        if (error instanceof RpcError && error.status === 401) onSessionExpired()
        else setSendError(error instanceof Error ? error.message : String(error))
      } finally {
        setLoadingHistory(false)
        requestAnimationFrame(() => {
          const el = scrollRef.current
          if (el !== null) el.scrollTop = el.scrollHeight
        })
      }
    },
    [onSessionExpired],
  )

  /**
   * Reconnect resync: re-pull the latest page and merge it into the existing
   * messages instead of replacing them — older loaded pages (and in-flight
   * streams) survive. Unlike openConversation this never resets state.
   */
  const resyncConversation = useCallback(
    async (sessionId: string): Promise<void> => {
      try {
        const result = await sessionHistory(sessionId, { maxMessages: HISTORY_PAGE })
        const derived = deriveMessages(result.events)
        const last = result.events[result.events.length - 1]
        const loadedSeq = last !== undefined ? last.event.seq : 0
        appliedSeqRef.current = Math.max(appliedSeqRef.current, loadedSeq)
        setMessages((prev) => mergeDerived(prev, derived))
        setHasMore(result.hasMore)
      } catch (error) {
        if (error instanceof RpcError && error.status === 401) onSessionExpired()
      }
    },
    [onSessionExpired],
  )

  const loadMore = useCallback(async (): Promise<void> => {
    const view0 = viewRef.current
    if (view0.kind !== 'conv' || loadingHistory || !hasMore) return
    const first = messages[0]
    if (first === undefined) return
    setLoadingHistory(true)
    try {
      // Server pagination is EXCLUSIVE (events with seq < beforeSeq): passing
      // first.seq - 1 would silently drop the event at exactly seq-1.
      const beforeSeq = first.seq
      const result = await sessionHistory(view0.sessionId, { beforeSeq, maxMessages: HISTORY_PAGE })
      const older = deriveMessages(result.events)
      setMessages((prev) => [...older, ...prev])
      setHasMore(result.hasMore)
      // Keep the scroll position anchored to the previously-first message.
      const el = scrollRef.current
      if (el !== null) {
        const anchor = el.scrollHeight - el.scrollTop
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight - anchor
        })
      }
    } catch (error) {
      if (error instanceof RpcError && error.status === 401) onSessionExpired()
    } finally {
      setLoadingHistory(false)
    }
  }, [loadingHistory, hasMore, messages, onSessionExpired])

  /* ------------------------- live events ------------------------- */
  useEffect(() => {
    const client = new MuxClient({
      onFrame: (frame: MuxFrame) => {
        if (frame.type === 'session/event' && 'sessionId' in frame && 'event' in frame) {
          applyEvent(frame as MuxEventFrame)
          return
        }
        // Direct mux frames: pending approvals / questions are replayed on
        // connect and pushed live; they never appear in the session/event
        // stream (verified: apiproxy mux() pushes them to every mux queue).
        if (frame.type === 'approval/requested') {
          const f = frame as ApprovalRequestedFrame
          const v = viewRef.current
          if (v.kind !== 'conv' || v.sessionId !== f.sessionId) return
          const key = `ap-${f.approvalId}`
          setMessages((prev) => {
            if (prev.some((m) => m.key === key && m.kind === 'approval')) return prev
            return [...prev, { key, kind: 'approval', role: 'assistant', text: f.reason !== undefined && f.reason.length > 0 ? `${f.toolName}：${f.reason}` : f.toolName, done: false, seq: 0 }]
          })
          scrollToBottomSoon()
        } else if (frame.type === 'approval/resolved') {
          const f = frame as ApprovalResolvedFrame
          const key = `ap-${f.approvalId}`
          setMessages((prev) => prev.map((m) => (m.key === key && m.kind === 'approval' ? { ...m, done: true } : m)))
        } else if (frame.type === 'question/requested') {
          const f = frame as QuestionRequestedFrame
          const v = viewRef.current
          if (v.kind !== 'conv' || v.sessionId !== f.sessionId) return
          const q = f.questions[0]
          if (q === undefined) return
          const key = `q-${q.id}`
          setMessages((prev) => {
            if (prev.some((m) => m.key === key && m.kind === 'question')) return prev
            return [...prev, { key, kind: 'question', role: 'assistant', text: q.question, done: false, seq: 0 }]
          })
          scrollToBottomSoon()
        } else if (frame.type === 'question/resolved') {
          setMessages((prev) => prev.map((m) => (m.kind === 'question' && !m.done ? { ...m, done: true } : m)))
        }
      },
      onResync: () => {
        // Fresh baselines after (re)connect: merge the latest page into the
        // open conversation WITHOUT dropping older loaded pages.
        const v = viewRef.current
        if (v.kind === 'conv') void resyncConversation(v.sessionId)
      },
    })
    client.connect()
    return () => client.dispose()
  }, [resyncConversation])

  const applyEvent = useCallback(
    (frame: MuxEventFrame): void => {
      const { event } = frame
      const v = viewRef.current
      if (v.kind !== 'conv' || frame.sessionId !== v.sessionId) {
        // Other sessions still move the list; the seq guard below must only
        // ever see THIS session's seqs (seq is per-session).
        scheduleListRefresh()
        return
      }
      if (event.seq <= appliedSeqRef.current) return
      appliedSeqRef.current = event.seq
      scheduleListRefresh()
      const data = (event.data ?? {}) as { content?: unknown; turn?: number; chunk?: { type?: string; text?: string; index?: number; name?: string }; name?: string; arguments?: string }

      const flushReasoning = (turn: number): void => {
        setMessages((prev) => prev.map((m) => (m.key === reasoningKey(turn) && m.kind === 'reasoning' ? { ...m, done: true } : m)))
      }

      if (event.type === 'user/message') {
        setMessages((prev) => [...prev, { key: `u-${event.seq}`, kind: 'text', role: 'user', text: messageText(event), done: true, seq: event.seq }])
        scrollToBottomSoon()
      } else if (event.type === 'assistant/chunk') {
        if (data.chunk?.type === 'reasoning-delta' && typeof data.chunk.text === 'string') {
          const turn = data.turn ?? 0
          const key = reasoningKey(turn)
          setMessages((prev) => {
            const existing = prev.find((m) => m.key === key && m.kind === 'reasoning')
            if (existing !== undefined) {
              return prev.map((m) => (m.key === key ? { ...m, text: m.text + data.chunk!.text! } : m))
            }
            return [...prev, { key, kind: 'reasoning', role: 'assistant', text: data.chunk!.text!, done: false, seq: event.seq }]
          })
          scrollToBottomSoon()
        } else if (data.chunk?.type === 'tool-call-delta' && typeof data.chunk.name === 'string') {
          const turn = data.turn ?? 0
          const key = `tcp-${turn}`
          const label = `调用工具 ${data.chunk.name}…`
          setMessages((prev) => {
            const existing = prev.find((m) => m.key === key && m.kind === 'tool-pending')
            if (existing !== undefined) return prev
            return [...prev, { key, kind: 'tool-pending', role: 'assistant', text: label, done: false, seq: event.seq }]
          })
          scrollToBottomSoon()
        } else if (data.chunk?.type === 'text-delta' && typeof data.chunk.text === 'string') {
          flushReasoning(data.turn ?? 0)
          const turn = data.turn ?? 0
          const key = `turn-${turn}`
          setMessages((prev) => {
            const existing = prev.find((m) => m.key === key)
            if (existing !== undefined) {
              return prev.map((m) => (m.key === key ? { ...m, text: m.text + data.chunk!.text!, done: false } : m))
            }
            return [...prev, { key, kind: 'text', role: 'assistant', text: data.chunk!.text!, done: false, seq: event.seq }]
          })
          scrollToBottomSoon()
        }
      } else if (event.type === 'tool/call') {
        const turn = data.turn ?? 0
        flushReasoning(turn)
        const viewBlock = frame.view as { view?: { card?: string } } | undefined
        setMessages((prev) => [
          // Drop the streaming placeholder for this turn, keep the real card.
          ...prev.filter((m) => !(m.kind === 'tool-pending' && m.key === `tcp-${turn}`)),
          {
            key: `tc-${event.seq}`,
            kind: 'tool-call',
            role: 'assistant',
            text: summarizeToolCall(data, frame.view),
            done: true,
            seq: event.seq,
            card: viewBlock?.view?.card,
          },
        ])
        scrollToBottomSoon()
      } else if (event.type === 'tool/result') {
        const viewBlock = frame.view as { view?: { card?: string } } | undefined
        setMessages((prev) => [
          ...prev,
          {
            key: `tr-${event.seq}`,
            kind: 'tool-result',
            role: 'assistant',
            text: summarizeToolResult(frame.view),
            done: true,
            seq: event.seq,
            card: viewBlock?.view?.card,
          },
        ])
        scrollToBottomSoon()
      } else if (event.type === 'assistant/message') {
        flushReasoning(data.turn ?? 0)
        const final = messageText(event)
        const key = `a-${event.seq}`
        setMessages((prev) => [
          ...prev.filter((m) => !(m.role === 'assistant' && !m.done && m.key.startsWith('turn-'))),
          { key, kind: 'text', role: 'assistant', text: final, done: true, seq: event.seq },
        ])
        scrollToBottomSoon()
      } else if (event.type === 'approval/asked') {
        const ad = data as { id?: unknown; toolName?: unknown; reason?: unknown }
        setMessages((prev) => [
          ...prev,
          {
            key: `ap-${String(ad.id ?? event.seq)}`,
            kind: 'approval',
            role: 'assistant',
            text: `${typeof ad.toolName === 'string' ? ad.toolName : '工具'}${typeof ad.reason === 'string' ? `：${ad.reason}` : ''}`,
            done: false,
            seq: event.seq,
          },
        ])
        scrollToBottomSoon()
      } else if (event.type === 'approval/decided') {
        const ad = data as { id?: unknown }
        const key = `ap-${String(ad.id ?? '')}`
        setMessages((prev) => prev.map((m) => (m.key === key && m.kind === 'approval' ? { ...m, done: true } : m)))
      } else if (event.type === 'todo/write') {
        const td = data as { todos?: Array<{ content?: unknown; status?: unknown }> }
        const todos = Array.isArray(td.todos) ? td.todos : []
        const doneCount = todos.filter((t) => t.status === 'completed').length
        const key = `tw-${event.seq}`
        setMessages((prev) => {
          const existing = prev.find((m) => m.kind === 'todo' && m.key === key)
          const card = { key, kind: 'todo' as const, role: 'assistant' as const, text: todos.length > 0 ? `任务清单（${doneCount}/${todos.length} 完成）` : '任务清单', done: true, seq: event.seq }
          return existing !== undefined ? prev.map((m) => (m.key === key ? card : m)) : [...prev, card]
        })
      } else if (event.type === 'turn/end') {
        const turn = data.turn ?? 0
        flushReasoning(turn)
        setMessages((prev) => prev.map((m) => (m.key === `turn-${turn}` ? { ...m, done: true } : m)))
      } else if (event.type === 'session/title') {
        const title = (event.data as { title?: unknown })?.title
        if (typeof title === 'string') setConvTitle(title)
      }
    },
    [scheduleListRefresh],
  )

  const scrollToBottomSoon = useCallback((): void => {
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el !== null) el.scrollTop = el.scrollHeight
    })
  }, [])

  /* ------------------------- skill menu (desktop / parity) ------------------------- */
  const openSkillMenu = useCallback(
    async (sessionId: string, prefix: string, start: number, cursor: number): Promise<void> => {
      const seq = gestureRef.current?.seq ?? 0
      const mySeq = seq + 1
      gestureRef.current = { start, cursor, seq: mySeq }
      setSkillMenu((prev) => (prev === null ? { candidates: [], loading: true, error: null } : prev))
      let skills = skillsCache.current.get(sessionId)
      if (skills === undefined) {
        try {
          skills = await listSkills(sessionId)
          skillsCache.current.set(sessionId, skills)
        } catch (error) {
          if (gestureRef.current?.seq !== mySeq) return
          setSkillMenu({ candidates: [], loading: false, error: error instanceof Error ? error.message : String(error) })
          return
        }
      }
      if (gestureRef.current?.seq !== mySeq) return
      setSkillMenu({ candidates: filterSkills(skills, prefix), loading: false, error: null })
    },
    [],
  )

  const handleComposerChange = useCallback(
    (e: { target: { value: string; selectionStart: number | null } }): void => {
      const value = e.target.value
      const cursor = e.target.selectionStart ?? value.length
      setInput(value)
      const v = viewRef.current
      if (v.kind !== 'conv') return
      const gesture = detectSkillGesture(value, cursor)
      if (gesture === null) {
        setSkillMenu(null)
        gestureRef.current = null
        return
      }
      void openSkillMenu(v.sessionId, gesture.prefix, gesture.start, cursor)
    },
    [openSkillMenu],
  )

  const pickSkill = useCallback(
    (skill: SkillSummary): void => {
      const g = gestureRef.current
      if (g === null) return
      const next = replaceGesture(input, g.start, g.cursor, skill.name)
      setInput(next)
      setSkillMenu(null)
      gestureRef.current = null
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (ta !== null) {
          ta.focus()
          const pos = g.start + skill.name.length + 2
          ta.setSelectionRange(pos, pos)
        }
      })
    },
    [input],
  )

  /* ------------------------- actions ------------------------- */
  const handleSend = useCallback(async (): Promise<void> => {
    const text = input.trim()
    const v = viewRef.current
    if (text.length === 0 || v.kind !== 'conv' || sending) return
    setSending(true)
    setSendError(null)
    setSkillMenu(null)
    gestureRef.current = null
    try {
      await sendPrompt(v.sessionId, text)
      setInput('')
    } catch (error) {
      if (error instanceof RpcError && error.status === 401) onSessionExpired()
      else setSendError(error instanceof Error ? error.message : String(error))
    } finally {
      setSending(false)
    }
  }, [input, sending, onSessionExpired])

  const handleNew = useCallback(async (): Promise<void> => {
    if (creating) return
    setCreating(true)
    try {
      const sessionId = await createSession()
      await openConversation(sessionId)
    } catch (error) {
      if (error instanceof RpcError && error.status === 401) onSessionExpired()
      else setListError(error instanceof Error ? error.message : String(error))
    } finally {
      setCreating(false)
    }
  }, [creating, openConversation, onSessionExpired])

  const toggleExpanded = useCallback((key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const onScroll = useCallback((): void => {
    const el = scrollRef.current
    if (el === null) return
    setScrolledUp(el.scrollTop < el.scrollHeight - el.clientHeight - 80)
    if (el.scrollTop < 80) void loadMore()
  }, [loadMore])

  /* ------------------------- rendering ------------------------- */
  const keyboardPad = useMemo(() => {
    const vh = viewport.visualHeight
    if (vh === null) return 0
    return Math.max(0, window.innerHeight - vh)
  }, [viewport.visualHeight])

  const style: Record<string, import('react').CSSProperties> = {
    root: { display: 'flex', flexDirection: 'column', height: '100dvh', background: '#0f1115', color: '#e6e6e6', fontFamily: 'system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif' },
    header: { display: 'flex', alignItems: 'center', gap: 8, minHeight: 52, padding: '8px 12px', paddingTop: 'env(safe-area-inset-top)', background: '#14171d', borderBottom: '1px solid #232833', flex: 'none' },
    headerTitle: { flex: 1, fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    backButton: { minWidth: 44, minHeight: 44, background: 'none', border: 'none', color: '#9aa0ab', fontSize: 20, borderRadius: 8 },
    iconButton: { minWidth: 44, minHeight: 44, background: 'none', border: 'none', color: '#e6e6e6', fontSize: 20, borderRadius: 8 },
    list: { flex: 1, overflowY: 'auto', overscrollBehavior: 'contain' },
    item: { display: 'flex', flexDirection: 'column', gap: 4, padding: '14px 16px', borderBottom: '1px solid #1c2129', minHeight: 56, background: 'none', borderLeft: 'none', borderRight: 'none', borderTop: 'none', width: '100%', textAlign: 'left', color: '#e6e6e6' },
    itemTitle: { fontSize: 15, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    itemMeta: { display: 'flex', gap: 8, fontSize: 12, color: '#7c8494' },
    running: { color: '#3b82f6' },
    conv: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
    scrollBody: { flex: 1, overflowY: 'auto', padding: '16px 16px 8px', overscrollBehavior: 'contain' },
    bubbleRow: { display: 'flex', marginBottom: 12, justifyContent: 'flex-start' },
    bubbleRowUser: { justifyContent: 'flex-end' },
    bubble: { maxWidth: '82%', padding: '10px 14px', borderRadius: 14, background: '#1a1d24', fontSize: 15, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
    bubbleUser: { background: '#2563eb', color: '#fff' },
    cursor: { display: 'inline-block', width: 8, height: 16, background: '#3b82f6', marginLeft: 2, verticalAlign: '-2px', animation: 'dsh-blink 1s steps(2) infinite' },
    composer: { flex: 'none', background: '#14171d', borderTop: '1px solid #232833', padding: '8px 12px', paddingBottom: `calc(8px + ${keyboardPad}px + env(safe-area-inset-bottom))` },
    composerRow: { display: 'flex', gap: 8, alignItems: 'flex-end' },
    input: { flex: 1, minHeight: 44, maxHeight: 120, padding: '10px 14px', fontSize: 16, lineHeight: 1.4, borderRadius: 10, border: '1px solid #333a45', background: '#0f1115', color: '#e6e6e6', resize: 'none', outline: 'none', fontFamily: 'inherit' },
    send: { minWidth: 44, minHeight: 44, borderRadius: 10, border: 'none', background: sending ? '#1d4ed8' : '#3b82f6', color: '#fff', fontSize: 18, flex: 'none' },
    sendDisabled: { opacity: 0.4 },
    empty: { padding: '40px 24px', textAlign: 'center', color: '#7c8494', fontSize: 14 },
    error: { margin: '8px 12px 0', padding: '8px 12px', borderRadius: 8, background: 'rgba(248,113,113,0.12)', color: '#f87171', fontSize: 13 },
    loading: { padding: 12, textAlign: 'center', color: '#7c8494', fontSize: 13 },
    reasoningRow: { display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '82%', padding: '8px 12px', borderRadius: 10, border: '1px dashed #3a4150', background: '#151920', color: '#9aa0ab', fontSize: 13, minHeight: 36 },
    reasoningLabel: { fontWeight: 600, color: '#7c8494' },
    reasoningText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#8b93a3', fontSize: 12, lineHeight: 1.5 },
    toolCard: { display: 'flex', alignItems: 'flex-start', gap: 8, maxWidth: '88%', padding: '8px 12px', borderRadius: 10, borderLeft: '3px solid #3b82f6', background: '#151920', color: '#c3c7cf', fontSize: 13, minHeight: 36 },
    toolResultCard: { display: 'flex', alignItems: 'flex-start', gap: 8, maxWidth: '88%', padding: '8px 12px', borderRadius: 10, borderLeft: '3px solid #3f6b4f', background: '#141a16', color: '#9aa0ab', fontSize: 13, minHeight: 36 },
    toolIcon: { flex: 'none', fontFamily: 'ui-monospace, Menlo, monospace', color: '#3b82f6', fontWeight: 700 },
    toolText: { overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, wordBreak: 'break-all' },
    pendingCard: { display: 'flex', alignItems: 'center', gap: 8, maxWidth: '88%', padding: '8px 12px', borderRadius: 10, borderLeft: '3px solid #5b6472', background: '#15181d', color: '#7c8494', fontSize: 13, minHeight: 36 },
    approvalCard: { display: 'flex', alignItems: 'center', gap: 8, maxWidth: '88%', padding: '8px 12px', borderRadius: 10, borderLeft: '3px solid #d97706', background: '#1d1810', color: '#e6c98a', fontSize: 13, minHeight: 36 },
    approvalDone: { color: '#7c8494' },
    questionCard: { display: 'flex', alignItems: 'flex-start', gap: 8, maxWidth: '88%', padding: '8px 12px', borderRadius: 10, borderLeft: '3px solid #2563eb', background: '#101623', color: '#a8c0ee', fontSize: 13, minHeight: 36 },
    todoRow: { display: 'flex', alignItems: 'center', gap: 8, maxWidth: '88%', padding: '8px 12px', borderRadius: 10, background: 'none', border: '1px dashed #3a4150', color: '#9aa0ab', fontSize: 13, minHeight: 36 },
  }

  const streaming = messages.some((m) => !m.done)

  if (view.kind === 'list') {
    return (
      <div style={style.root}>
        <div style={style.header}>
          <div style={style.headerTitle}>会话</div>
          <button type="button" style={style.iconButton} onClick={() => void handleNew()} disabled={creating} aria-label="新建会话">
            {creating ? '…' : '＋'}
          </button>
        </div>
        {listError !== null && <div style={style.error}>{listError}</div>}
        <div style={style.list}>
          {sessions.length === 0 && listError === null ? (
            <div style={style.empty}>
              暂无会话
              <br />
              点右上角「＋」开始新对话
            </div>
          ) : (
            sessions.map((s) => (
              <button key={s.sessionId} type="button" style={style.item} onClick={() => void openConversation(s.sessionId)}>
                <span style={style.itemTitle}>{titleOf(s)}</span>
                <span style={style.itemMeta}>
                  <span>{formatTime(s.updatedAt)}</span>
                  {s.running && <span style={style.running}>● 运行中</span>}
                  {s.blank && <span>空会话</span>}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    )
  }

  return (
    <div style={style.root}>
      <div style={style.header}>
        <button type="button" style={style.backButton} onClick={() => setView({ kind: 'list' })} aria-label="返回">
          ‹
        </button>
        <div style={style.headerTitle}>{convTitle !== '' ? convTitle : '对话'}</div>
        <div style={{ minWidth: 44 }} />
      </div>
      <div style={style.conv}>
        {sendError !== null && <div style={style.error}>{sendError}</div>}
        <div style={style.scrollBody} ref={scrollRef} onScroll={onScroll}>
          {loadingHistory && messages.length === 0 ? (
            <div style={style.loading}>加载中…</div>
          ) : messages.length === 0 ? (
            <div style={style.empty}>发送第一条消息开始对话</div>
          ) : (
            messages.map((m) => {
              if (m.kind === 'tool-pending') {
                return (
                  <div key={m.key} style={style.bubbleRow}>
                    <div style={style.pendingCard}>
                      <span style={style.toolIcon}>🔧</span>
                      <span>{m.text}</span>
                    </div>
                  </div>
                )
              }
              if (m.kind === 'approval') {
                return (
                  <div key={m.key} style={style.bubbleRow}>
                    <div style={style.approvalCard}>
                      <span>{m.done ? '✅' : '⏳'}</span>
                      <span style={m.done ? style.approvalDone : undefined}>{m.done ? '审批已处理' : `等待审批：${m.text}`}</span>
                    </div>
                  </div>
                )
              }
              if (m.kind === 'question') {
                return (
                  <div key={m.key} style={style.bubbleRow}>
                    <div style={style.questionCard}>
                      <span>{m.done ? '✅' : '❓'}</span>
                      <span>{m.done ? '问题已回答' : `等待回答：${m.text}`}</span>
                    </div>
                  </div>
                )
              }
              if (m.kind === 'todo') {
                return (
                  <div key={m.key} style={style.bubbleRow}>
                    <button type="button" style={style.todoRow} onClick={() => toggleExpanded(m.key)}>
                      <span>📋</span>
                      <span>{m.text} {expanded.has(m.key) ? '▾' : '▸'}</span>
                    </button>
                  </div>
                )
              }
              if (m.kind === 'reasoning') {
                const open = expanded.has(m.key)
                return (
                  <div key={m.key} style={style.bubbleRow}>
                    <button type="button" style={style.reasoningRow} onClick={() => toggleExpanded(m.key)}>
                      <span style={style.reasoningLabel}>{m.done ? '🧠 思考' : '🧠 思考中…'} {open ? '▾' : '▸'}</span>
                      {open && <span style={style.reasoningText}>{m.text}</span>}
                    </button>
                  </div>
                )
              }
              if (m.kind === 'tool-call' || m.kind === 'tool-result') {
                const cardStyle = m.kind === 'tool-call' ? style.toolCard : style.toolResultCard
                return (
                  <div key={m.key} style={style.bubbleRow}>
                    <div style={cardStyle}>
                      <span style={style.toolIcon}>{toolIcon(m.card, m.text)}</span>
                      <span style={style.toolText}>{m.text}</span>
                    </div>
                  </div>
                )
              }
              return (
                <div key={m.key} style={m.role === 'user' ? { ...style.bubbleRow, ...style.bubbleRowUser } : style.bubbleRow}>
                  <div style={m.role === 'user' ? { ...style.bubble, ...style.bubbleUser } : style.bubble}>
                    {m.text}
                    {!m.done && <span style={style.cursor} />}
                  </div>
                </div>
              )
            })
          )}
        </div>
        {hasMore && !loadingHistory && (
          <button type="button" onClick={() => void loadMore()} style={{ minHeight: 44, background: 'none', border: 'none', color: '#3b82f6', fontSize: 13 }}>
            加载更早的消息
          </button>
        )}
        <div style={{ ...style.composer, position: 'relative' }}>
          {skillMenu !== null && (
            <SkillMenu
              skills={skillMenu.candidates}
              loading={skillMenu.loading}
              error={skillMenu.error}
              onPick={pickSkill}
              onClose={() => setSkillMenu(null)}
            />
          )}
          <div style={style.composerRow}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleComposerChange}
              onBlur={() => {
                // Give the menu a moment to receive the tap before closing.
                setTimeout(() => setSkillMenu(null), 200)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSkillMenu(null)
                  gestureRef.current = null
                } else if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
              placeholder={streaming ? '正在回复…' : '输入消息'}
              rows={1}
              enterKeyHint="send"
              style={style.input}
            />
            <button
              type="button"
              style={{ ...style.send, ...(sending || input.trim().length === 0 ? style.sendDisabled : {}) }}
              onClick={() => void handleSend()}
              disabled={sending || input.trim().length === 0}
              aria-label="发送"
            >
              ➤
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
