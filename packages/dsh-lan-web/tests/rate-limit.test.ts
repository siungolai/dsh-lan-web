/**
 * dsh-lan-web — rate limiter unit tests.
 */
import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/rate-limit.ts'

describe('RateLimiter', () => {
  it('allows up to the limit inside a window', () => {
    let now = 0
    const limiter = new RateLimiter(3, 30_000, () => now)
    expect(limiter.allow('ip-1')).toBe(true)
    expect(limiter.allow('ip-1')).toBe(true)
    expect(limiter.allow('ip-1')).toBe(true)
    expect(limiter.allow('ip-1')).toBe(false)
  })

  it('tracks keys independently', () => {
    let now = 0
    const limiter = new RateLimiter(2, 30_000, () => now)
    limiter.allow('a')
    limiter.allow('a')
    expect(limiter.allow('a')).toBe(false)
    expect(limiter.allow('b')).toBe(true)
    expect(limiter.allow('b')).toBe(true)
  })

  it('resets after the window elapses', () => {
    let now = 0
    const limiter = new RateLimiter(1, 30_000, () => now)
    expect(limiter.allow('ip')).toBe(true)
    expect(limiter.allow('ip')).toBe(false)
    now = 30_001
    expect(limiter.allow('ip')).toBe(true)
  })

  it('reset clears a key', () => {
    const limiter = new RateLimiter(1, 30_000)
    limiter.allow('ip')
    expect(limiter.allow('ip')).toBe(false)
    limiter.reset('ip')
    expect(limiter.allow('ip')).toBe(true)
  })
})
