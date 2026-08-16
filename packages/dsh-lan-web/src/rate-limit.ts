/**
 * dsh-lan-web — sliding-window rate limiter for login attempts.
 * Keyed by source IP: `limit` hits per `windowMs` before refusal.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>()

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the key may proceed (records the hit). */
  allow(key: string): boolean {
    const t = this.now()
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
}
