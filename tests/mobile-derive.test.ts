/**
 * deriveMessages tests: tool calls/results become typed cards; reasoning
 * deltas accumulate into a thinking block flushed before the text.
 */
import { describe, expect, it } from 'vitest'
import { deriveMessages } from '../src/mobile/App.tsx'
import type { HistoryEntry, SessionEvent } from '../src/mobile/api'

const ev = (type: string, data: unknown, seq: number): SessionEvent => ({ type, seq, time: 0, data })
const entry = (event: SessionEvent, view?: unknown): HistoryEntry => ({ event, view })

describe('deriveMessages', () => {
  it('derives tool calls and results as typed cards with host views', () => {
    const msgs = deriveMessages([
      entry(ev('user/message', { content: [{ type: 'text', text: 'hi' }] }, 1)),
      entry(ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }, 2), { for: 'call', view: { card: 'terminal', title: 'ls' } }),
      entry(ev('tool/result', { turn: 1, step: 1, message: { content: [] } }, 3), { for: 'result', view: { card: 'terminal', output: 'file1\nfile2' } }),
      entry(ev('assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'done' }] } }, 4)),
    ])
    expect(msgs.map((m) => m.kind)).toEqual(['text', 'tool-call', 'tool-result', 'text'])
    expect(msgs[1]).toMatchObject({ kind: 'tool-call', text: 'ls', card: 'terminal' })
    expect(msgs[2]).toMatchObject({ kind: 'tool-result', text: 'file1\nfile2', card: 'terminal' })
  })

  it('accumulates reasoning deltas into one block flushed before the text', () => {
    const msgs = deriveMessages([
      entry(ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: '想想' } }, 1)),
      entry(ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: '再多想' } }, 2)),
      entry(ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: '答案' } }, 3)),
      entry(ev('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '最终答案' }] } }, 4)),
    ])
    // History derives text only from assistant/message; text-delta chunks
    // merely flush the pending reasoning block (live path renders them).
    expect(msgs.map((m) => m.kind)).toEqual(['reasoning', 'text'])
    expect(msgs[0].text).toBe('想想再多想')
    expect(msgs[0].done).toBe(true)
    expect(msgs[1].text).toBe('最终答案')
  })

  it('derives approval cards and resolves them', () => {
    const msgs = deriveMessages([
      entry(ev('approval/asked', { id: 'ap1', toolName: 'bash', reason: '执行远程命令' }, 5)),
      entry(ev('approval/decided', { id: 'ap1' }, 6)),
    ])
    expect(msgs.map((m) => m.kind)).toEqual(['approval', 'approval'])
    expect(msgs[0]).toMatchObject({ kind: 'approval', text: 'bash：执行远程命令', done: false })
    expect(msgs[1].done).toBe(true)
  })

  it('derives a todo summary card', () => {
    const msgs = deriveMessages([
      entry(ev('todo/write', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] }, 7)),
    ])
    expect(msgs[0]).toMatchObject({ kind: 'todo', text: '任务清单（1/2 完成）' })
  })

  it('falls back to the tool name when the view lacks a title', () => {
    const msgs = deriveMessages([entry(ev('tool/call', { turn: 1, step: 1, callId: 'c', name: 'read', arguments: '{"file":"a.txt"}' }, 2))])
    expect(msgs[0]).toMatchObject({ kind: 'tool-call' })
    expect(msgs[0].text).toContain('read')
  })
})
