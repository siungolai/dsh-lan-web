/**
 * dsh-lan-web — store unit tests (injectable clock, temp files).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LanWebStore } from '../src/store.ts'

let dir: string
let file: string
let store: LanWebStore
let now = 1_000_000
let tokenCounter = 0

const days = (n: number) => n * 86_400_000

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lanweb-'))
  file = path.join(dir, 'dsh-lan-web.json')
  now = 1_000_000
  tokenCounter = 0
  store = new LanWebStore({
    filePath: file,
    now: () => now,
    getSessionDays: () => 30,
    randomToken: () => `tok-${++tokenCounter}`,
  })
  await store.load()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('password lifecycle', () => {
  it('starts without a password (fail-closed)', () => {
    expect(store.hasPassword()).toBe(false)
  })

  it('setPasswordHash clears all sessions and bumps epoch', async () => {
    const t1 = store.issue('ua-1')
    const t2 = store.issue('ua-2')
    expect(store.sessionCount()).toBe(2)
    await store.setPasswordHash('hash:abc')
    expect(store.hasPassword()).toBe(true)
    expect(store.sessionCount()).toBe(0)
    expect(store.validate(t1)).toBeNull()
    expect(store.validate(t2)).toBeNull()
  })
})

describe('session sliding window', () => {
  it('issues and validates a token, touching lastSeenAt', () => {
    const token = store.issue('ua-phone')
    const record = store.validate(token)
    expect(record).not.toBeNull()
    expect(record!.deviceId).toBeTruthy()
    expect(record!.userAgent).toBe('ua-phone')
  })

  it('expires after sessionDays without any activity', () => {
    const token = store.issue()
    now += days(31) // never touched since issue
    expect(store.validate(token)).toBeNull()
    expect(store.sessionCount()).toBe(0)
  })

  it('expires 30 days after the last activity (sliding window edge)', () => {
    const token = store.issue()
    expect(store.validate(token)).not.toBeNull() // touch at t0
    now += days(29)
    expect(store.validate(token)).not.toBeNull() // 29d idle: alive, touches again
    now += days(31) // 31 days since last activity
    expect(store.validate(token)).toBeNull()
    expect(store.sessionCount()).toBe(0)
  })

  it('slides: activity inside the window renews the deadline', () => {
    const token = store.issue()
    now += days(25)
    expect(store.validate(token)).not.toBeNull() // touches
    now += days(25) // 50 days total, but only 25 since last touch
    expect(store.validate(token)).not.toBeNull()
  })

  it('rejects unknown tokens', () => {
    expect(store.validate('nope')).toBeNull()
  })

  it('revokes single token and by device', () => {
    const t1 = store.issue('ua-a')
    const t2 = store.issue('ua-b')
    const deviceA = store.validate(t1)!.deviceId
    store.revoke(t1)
    expect(store.validate(t1)).toBeNull()
    expect(store.validate(t2)).not.toBeNull()
    store.revokeByDevice(deviceA)
    expect(store.listDevices().find((d) => d.deviceId === deviceA)).toBeUndefined()
    // t1 already revoked; t2 survives
    expect(store.validate(t2)).not.toBeNull()
  })

  it('lists devices de-duplicated per device id', () => {
    const t1 = store.issue('ua-a')
    const deviceA = store.validate(t1)!.deviceId
    const t2 = store.issue('ua-a') // same UA but new device id
    const deviceB = store.validate(t2)!.deviceId
    expect(deviceA).not.toBe(deviceB)
    const devices = store.listDevices()
    expect(devices.length).toBe(2)
  })
})

describe('persistence', () => {
  it('flushes and reloads sessions and epoch', async () => {
    const t1 = store.issue('ua-1')
    await store.setPasswordHash('hash:abc')
    const t2 = store.issue('ua-2')
    expect(store.validate(t1)).toBeNull() // cleared by password change
    expect(store.validate(t2)).not.toBeNull()
    await store.flush()

    const reloaded = new LanWebStore({
      filePath: file,
      now: () => now,
      getSessionDays: () => 30,
      randomToken: () => 'tok-x',
    })
    await reloaded.load()
    expect(reloaded.hasPassword()).toBe(true)
    expect(reloaded.validate(t2)).not.toBeNull() // session survives restart
    expect(reloaded.validate(t1)).toBeNull()
  })

  it('writes a 0600 file', async () => {
    await store.flush()
    const raw = await readFile(file, 'utf8')
    expect(raw).toContain('"sessions"')
    const stat = await import('node:fs/promises').then((m) => m.stat(file))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('tolerates a corrupt file', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{not json')
    const fresh = new LanWebStore({ filePath: file, randomToken: () => 'tok-x' })
    await fresh.load()
    expect(fresh.hasPassword()).toBe(false)
    expect(fresh.sessionCount()).toBe(0)
  })

  it('rethrows on EACCES instead of silently resetting (password loss would lock the gate)', async () => {
    const { chmod, writeFile } = await import('node:fs/promises')
    await store.issue()
    await store.flush()
    await chmod(file, 0o000)
    const fresh = new LanWebStore({ filePath: file, randomToken: () => 'tok-x' })
    await expect(fresh.load()).rejects.toThrow()
    await chmod(file, 0o600)
  })

  it('concurrent flush() calls never race (serialized chain, no ENOENT)', async () => {
    for (let i = 0; i < 10; i += 1) store.issue(`ua-${i}`)
    // Fire several flushes at once (debounce timer may also be pending).
    await Promise.all([store.flush(), store.flush(), store.flush()])
    const { readFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(file, 'utf8'))
    expect(Object.keys(raw.sessions).length).toBe(10)
  })

  it('flushSync writes the current state synchronously (exit-time path)', async () => {
    const token = store.issue('ua-exit')
    store.flushSync()
    // Same injected clock as the issuing store, or the sliding window sees
    // a multi-year gap and expires the session.
    const fresh = new LanWebStore({ filePath: file, now: () => now, randomToken: () => 'tok-x' })
    await fresh.load()
    expect(fresh.validate(token)).not.toBeNull()
  })

  it('flushes on the process exit event via installExitFlush', async () => {
    const token = store.issue('ua-exit2')
    store.installExitFlush()
    process.emit('exit', 0)
    const fresh = new LanWebStore({ filePath: file, now: () => now, randomToken: () => 'tok-x' })
    await fresh.load()
    expect(fresh.validate(token)).not.toBeNull()
  })
})
