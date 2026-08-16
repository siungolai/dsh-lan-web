/**
 * dsh-lan-web — crypto primitives unit tests.
 */
import { describe, expect, it } from 'vitest'
import { hashPassword, randomToken, uuidV4Fallback, verifyPassword } from '../src/crypto.ts'

describe('password hashing', () => {
  it('round-trips a password', async () => {
    const stored = await hashPassword('s3cret-pass')
    expect(stored).toContain(':')
    await expect(verifyPassword('s3cret-pass', stored)).resolves.toBe(true)
  })

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('right')
    await expect(verifyPassword('wrong', stored)).resolves.toBe(false)
  })

  it('salts: same password hashes differently', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
    await expect(verifyPassword('same', a)).resolves.toBe(true)
    await expect(verifyPassword('same', b)).resolves.toBe(true)
  })

  it('rejects malformed stored values', async () => {
    await expect(verifyPassword('x', '')).resolves.toBe(false)
    await expect(verifyPassword('x', 'noseparator')).resolves.toBe(false)
    await expect(verifyPassword('x', ':hashonly')).resolves.toBe(false)
    await expect(verifyPassword('x', 'salt:')).resolves.toBe(false)
  })

  it('rejects non-hex stored values (auth-bypass regression: Buffer.from("zz","hex") is empty)', async () => {
    const good = await hashPassword('secret')
    const [salt] = good.split(':')
    // 128-char 'z' hash: valid length, invalid hex
    await expect(verifyPassword('anything', `${salt}:${'z'.repeat(128)}`)).resolves.toBe(false)
    // 32-char 'z' salt: valid length, invalid hex
    await expect(verifyPassword('anything', `${'z'.repeat(32)}:${'0'.repeat(128)}`)).resolves.toBe(false)
    // correct-length garbage hex
    await expect(verifyPassword('anything', `${'0'.repeat(32)}:${'1'.repeat(128)}`)).resolves.toBe(false)
  })

  it('rejects wrong-length stored values', async () => {
    await expect(verifyPassword('x', `${'0'.repeat(31)}:${'1'.repeat(128)}`)).resolves.toBe(false)
    await expect(verifyPassword('x', `${'0'.repeat(32)}:${'1'.repeat(127)}`)).resolves.toBe(false)
  })

  it('rejects empty passwords', async () => {
    const good = await hashPassword('secret')
    await expect(verifyPassword('', good)).resolves.toBe(false)
  })
})

describe('randomToken', () => {
  it('produces 32 hex chars and is unique', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i += 1) {
      const token = randomToken()
      expect(token).toMatch(/^[0-9a-f]{32}$/)
      expect(seen.has(token)).toBe(false)
      seen.add(token)
    }
  })
})

describe('uuidV4Fallback', () => {
  it('produces a valid v4-shaped UUID', () => {
    const uuid = uuidV4Fallback()
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
