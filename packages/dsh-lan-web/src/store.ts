/**
 * dsh-lan-web — session & credential store.
 *
 * Persisted at `$DSH_HOME/dsh-lan-web.json` (atomic tmp+rename, mode 0600).
 * Layout:
 *   { passwordHash, epoch, sessions: { [token]: SessionRecord } }
 *
 * - Password change bumps `epoch` and clears every session (kick-all,
 *   including replayed old cookies — records carry their issue epoch).
 * - Sessions slide: validation refreshes `lastSeenAt`; a record is dead once
 *   `lastSeenAt + sessionDays` is in the past.
 * - Writes are debounced (500 ms) to batch bursts; flush() forces a write.
 * - Clock/randomness are injectable for tests.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomToken } from './crypto.ts'

export interface SessionRecord {
  /** Random identifier of the logged-in device (not the cookie bearer token). */
  deviceId: string
  deviceName?: string
  createdAt: number
  lastSeenAt: number
  userAgent?: string
  /** Epoch at issue time; mismatches after a password change. */
  issuedEpoch: number
}

export interface StoreOptions {
  filePath: string
  now?: () => number
  /** Current sliding-lifetime in days (from settings). */
  getSessionDays?: () => number
  /** Token generator (defaults to crypto random 32-hex). */
  randomToken?: () => string
}

const FLUSH_DEBOUNCE_MS = 500

export class LanWebStore {
  private data: {
    passwordHash: string
    epoch: number
    sessions: Record<string, SessionRecord>
  }
  private readonly filePath: string
  private readonly now: () => number
  private readonly getSessionDays: () => number
  private readonly randomToken: () => string
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: StoreOptions) {
    this.filePath = options.filePath
    this.now = options.now ?? Date.now
    this.getSessionDays = options.getSessionDays ?? (() => 30)
    this.randomToken = options.randomToken ?? randomToken
    this.data = { passwordHash: '', epoch: 0, sessions: {} }
  }

  /**
   * Load persisted data. A missing file (first run) is a normal empty state;
   * a CORRUPT file degrades to the empty state but logs a warning (the
   * password is effectively lost — fail-closed is safer than a half state).
   * Any other read error (e.g. EACCES: file exists but unreadable) is
   * rethrown so the operator notices instead of silently resetting the
   * password to "not configured".
   */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        this.data = { passwordHash: '', epoch: 0, sessions: {} }
        return
      }
      throw error
    }
    try {
      const parsed = JSON.parse(raw) as { passwordHash?: string; epoch?: number; sessions?: Record<string, SessionRecord> }
      this.data = {
        passwordHash: typeof parsed.passwordHash === 'string' ? parsed.passwordHash : '',
        epoch: typeof parsed.epoch === 'number' ? parsed.epoch : 0,
        sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      }
    } catch {
      console.error('[dsh-lan-web] session data file corrupt, starting empty (fail-closed):', this.filePath)
      this.data = { passwordHash: '', epoch: 0, sessions: {} }
    }
  }

  hasPassword(): boolean {
    return this.data.passwordHash.length > 0
  }

  get passwordHash(): string {
    return this.data.passwordHash
  }

  /**
   * Set a new password hash: bumps the epoch and clears every session.
   * The caller is responsible for hashing (scrypt) beforehand.
   */
  async setPasswordHash(hash: string): Promise<void> {
    this.data.passwordHash = hash
    this.data.epoch += 1
    this.data.sessions = {}
    await this.flush()
  }

  /** Issue a new session token (records the current epoch). */
  issue(userAgent?: string, deviceName?: string): string {
    const token = this.randomToken()
    const now = this.now()
    this.data.sessions[token] = {
      deviceId: this.randomToken(),
      deviceName,
      createdAt: now,
      lastSeenAt: now,
      userAgent,
      issuedEpoch: this.data.epoch,
    }
    this.scheduleFlush()
    return token
  }

  /**
   * Validate a bearer token: epoch match + sliding window alive.
   * Touches `lastSeenAt` on success (sliding renewal).
   */
  validate(token: string): SessionRecord | null {
    const record = this.data.sessions[token]
    if (!record) return null
    if (record.issuedEpoch !== this.data.epoch) {
      delete this.data.sessions[token]
      this.scheduleFlush()
      return null
    }
    const aliveMs = this.getSessionDays() * 86_400_000
    if (this.now() - record.lastSeenAt > aliveMs) {
      delete this.data.sessions[token]
      this.scheduleFlush()
      return null
    }
    record.lastSeenAt = this.now()
    this.scheduleFlush()
    return record
  }

  revoke(token: string): void {
    if (delete this.data.sessions[token]) this.scheduleFlush()
  }

  /** Revoke every session of one device (settings-card kick). */
  revokeByDevice(deviceId: string): void {
    let changed = false
    for (const [token, record] of Object.entries(this.data.sessions)) {
      if (record.deviceId === deviceId) {
        delete this.data.sessions[token]
        changed = true
      }
    }
    if (changed) this.scheduleFlush()
  }

  listDevices(): Array<{ deviceId: string; deviceName?: string; createdAt: number; lastSeenAt: number; userAgent?: string }> {
    const seen = new Map<string, SessionRecord>()
    for (const record of Object.values(this.data.sessions)) seen.set(record.deviceId, record)
    return [...seen.values()].map((r) => ({
      deviceId: r.deviceId,
      deviceName: r.deviceName,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
      userAgent: r.userAgent,
    }))
  }

  sessionCount(): number {
    return Object.keys(this.data.sessions).length
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush().catch((error) => {
        console.error('[dsh-lan-web] session flush failed:', error)
      })
    }, FLUSH_DEBOUNCE_MS)
    this.flushTimer.unref?.()
  }

  /**
   * Atomic write (tmp + rename), mode 0600. Writes are serialized on a
   * promise chain: concurrent flush() calls (debounce timer + explicit
   * awaits) would otherwise race on the same .tmp path — the second
   * rename() fails with ENOENT and the unhandled rejection crashes the
   * process (Node >= 15).
   */
  private flushChain: Promise<void> = Promise.resolve()

  flush(): Promise<void> {
    this.flushChain = this.flushChain
      .catch(() => {
        // A failed chain link must not poison the next flush; the caller's
        // own rejection still propagates from the link it awaited.
      })
      .then(() => this.writeNow())
    return this.flushChain
  }

  private async writeNow(): Promise<void> {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    await rename(tmp, this.filePath)
  }

  /**
   * Synchronous last-resort write for process exit paths ('exit' event,
   * SIGTERM/SIGINT handlers), where async I/O can no longer complete.
   * Idempotent with flush() (same .tmp path, serialized by the event-loop
   * pause at exit).
   */
  flushSync(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
      renameSync(tmp, this.filePath)
    } catch {
      // Last resort only: nothing recoverable at exit time.
    }
  }

  /** Register exit-time flush hooks ('exit', SIGTERM, SIGINT). */
  installExitFlush(): void {
    const flush = () => this.flushSync()
    process.on('exit', flush)
    process.on('SIGTERM', flush)
    process.on('SIGINT', flush)
  }
}
