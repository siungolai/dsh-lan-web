/**
 * Permissions projection parsing tests.
 */
import { describe, expect, it } from 'vitest'
import { permissionsOf } from '../src/mobile/api'

describe('permissionsOf', () => {
  it('parses a valid permissions projection block', () => {
    const state = permissionsOf({
      asOfSeq: 3,
      values: {
        permissions: {
          options: [
            { value: 'read-only', name: 'Read Only' },
            { value: 'workspace-write', name: 'Workspace Write' },
            { value: 'danger-full-access', name: 'Full Access' },
          ],
          currentValue: 'workspace-write',
        },
      },
    })
    expect(state).toEqual({
      options: [
        { value: 'read-only', name: 'Read Only' },
        { value: 'workspace-write', name: 'Workspace Write' },
        { value: 'danger-full-access', name: 'Full Access' },
      ],
      currentValue: 'workspace-write',
    })
  })

  it('returns null for missing or malformed blocks', () => {
    expect(permissionsOf(undefined)).toBeNull()
    expect(permissionsOf({ asOfSeq: 0, values: {} })).toBeNull()
    expect(permissionsOf({ asOfSeq: 0, values: { permissions: { options: [] } } })).toBeNull()
  })
})
