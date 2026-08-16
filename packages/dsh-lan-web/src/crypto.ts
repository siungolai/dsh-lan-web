/**
 * dsh-lan-web — crypto primitives.
 *
 * Password hashing uses Node's built-in scrypt (salt + 64-byte key, stored as
 * `saltHex:hashHex`). Session tokens are 32-hex random values. The
 * crypto.randomUUID polyfill targets non-secure contexts (LAN plain HTTP)
 * where the Web Crypto API is unavailable to the browser GUI.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

const SALT_BYTES = 16
const KEY_BYTES = 64

/** Hash a password: returns `${saltHex}:${hashHex}`. */
export async function hashPassword(password: string, saltHex?: string): Promise<string> {
  const salt = saltHex !== undefined ? Buffer.from(saltHex, 'hex') : randomBytes(SALT_BYTES)
  const key = await scrypt(password, salt, KEY_BYTES)
  return `${salt.toString('hex')}:${key.toString('hex')}`
}

/** Constant-time verification of a password against a stored hash. */
const HEX_RE = /^[0-9a-f]+$/i
const SALT_HEX_LENGTH = SALT_BYTES * 2 // 32 hex chars = 16 bytes
const KEY_HEX_LENGTH = KEY_BYTES * 2 // 128 hex chars = 64 bytes

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // Reject empty passwords outright.
  if (typeof password !== 'string' || password.length === 0) return false
  const separator = stored.indexOf(':')
  if (separator <= 0) return false
  const saltHex = stored.slice(0, separator)
  const hashHex = stored.slice(separator + 1)
  // Strict shape: exact fixed lengths + valid hex. Without this,
  // Buffer.from('zz', 'hex') yields an EMPTY buffer, scrypt keylen 0
  // succeeds, and timingSafeEqual(empty, empty) is true — a stored value
  // like 'salt:zz' would accept ANY password (auth bypass).
  if (saltHex.length !== SALT_HEX_LENGTH || hashHex.length !== KEY_HEX_LENGTH) return false
  if (!HEX_RE.test(saltHex) || !HEX_RE.test(hashHex)) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const actual = await scrypt(password, salt, expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Random 32-hex-char session token. */
export function randomToken(): string {
  return randomBytes(16).toString('hex')
}

/** Fallback UUID v4 for non-secure contexts. */
export function uuidV4Fallback(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** Script injected into index.html <head>; idempotent, non-secure-context only. */
export const POLYFILL_SCRIPT = `<script>
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
  crypto.randomUUID = ${uuidV4Fallback.toString()};
}
</script>`
