/**
 * dsh-lan-web — sliding-window rate limiter for login attempts.
 * Keyed by source IP: `limit` hits per `windowMs` before refusal.
 *
 * Memory is bounded: expired entries are swept lazily on allow() (at most
 * once per window), so a flood of distinct IPs cannot grow the map forever.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>()
  private lastSweep = 0

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the key may proceed (records the hit). */
  allow(key: string): boolean {
    const t = this.now()
    this.sweep(t)
    const record = this.hits.get(key)
    if (record === undefined || t - record.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: t })
      return true
    }
    record.count += 1
    return record.count <= this.limit
  }

  reset(key: string): void {
    this.hits.delete(key)
  }

  /** Number of tracked keys (informational; used by tests). */
  size(): number {
    return this.hits.size
  }

  /** Drop entries whose window has fully elapsed; runs at most once per window. */
  private sweep(t: number): void {
    if (t - this.lastSweep < this.windowMs) return
    this.lastSweep = t
    for (const [key, record] of this.hits) {
      if (t - record.windowStart >= this.windowMs) this.hits.delete(key)
    }
  }
}
