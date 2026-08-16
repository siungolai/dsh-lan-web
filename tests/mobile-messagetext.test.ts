/**
 * messageText tests: user/message carries content flat; assistant/message
 * nests it at data.message.content ({turn, step, message, usage}).
 */
import { describe, expect, it } from 'vitest'
import { messageText, type Message } from '../src/mobile/App.tsx'
import type { SessionEvent } from '../src/mobile/api'

const ev = (type: string, data: unknown, seq = 1): SessionEvent => ({ type, seq, time: 0, data })

describe('messageText', () => {
  it('extracts flat content blocks (user/message shape)', () => {
    const e = ev('user/message', { id: 'm1', role: 'user', content: [{ type: 'text', text: '你好' }, { type: 'text', text: '世界' }], source: { kind: 'user' } })
    expect(messageText(e)).toBe('你好世界')
  })

  it('extracts nested message.content (assistant/message shape)', () => {
    const e = ev('assistant/message', {
      turn: 1,
      step: 0,
      message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '回复内容' }], source: { kind: 'model' } },
      usage: {},
    })
    expect(messageText(e)).toBe('回复内容')
  })

  it('returns empty string when neither shape carries text blocks', () => {
    expect(messageText(ev('assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'tool-call', id: 't' }] } }))).toBe('')
    expect(messageText(ev('user/message', {}))).toBe('')
  })
})
