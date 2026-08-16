/**
 * mergeDerived tests: reconnect resync must merge into the existing message
 * list without dropping older loaded pages or duplicating the tail overlap.
 */
import { describe, expect, it } from 'vitest'
import { mergeDerived, type Message } from '../src/mobile/App.tsx'

function msg(seq: number, key: string, role: 'user' | 'assistant' = 'user'): Message {
  return { key, role, text: `m${seq}`, done: true, seq }
}

describe('mergeDerived', () => {
  it('keeps older pages and appends only messages beyond the current max seq', () => {
    const prev = [msg(10, 'u-10'), msg(20, 'a-20'), msg(30, 'u-30')]
    const derived = [msg(30, 'u-30'), msg(40, 'u-40'), msg(50, 'a-50')]
    const out = mergeDerived(prev, derived)
    expect(out.map((m) => m.seq)).toEqual([10, 20, 30, 40, 50])
  })

  it('returns prev unchanged when the page overlaps fully', () => {
    const prev = [msg(10, 'u-10'), msg(20, 'a-20')]
    expect(mergeDerived(prev, [msg(20, 'a-20')])).toBe(prev)
  })

  it('handles an empty prev', () => {
    expect(mergeDerived([], [msg(5, 'u-5')])).toEqual([msg(5, 'u-5')])
  })

  it('keeps in-flight streaming placeholders (they carry seq of their first chunk)', () => {
    const streaming = { key: 'turn-3', role: 'assistant' as const, text: 'part', done: false, seq: 25 }
    const prev = [msg(10, 'u-10'), streaming]
    const derived = [msg(10, 'u-10'), msg(40, 'a-40')]
    const out = mergeDerived(prev, derived)
    expect(out).toContain(streaming)
    expect(out.map((m) => m.seq)).toEqual([10, 25, 40])
  })
})
