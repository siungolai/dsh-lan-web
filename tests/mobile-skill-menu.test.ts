/**
 * Skill menu pure-logic tests: `/` gesture detection, prefix filtering,
 * gesture replacement, and user-only labelling (desktop parity).
 */
import { describe, expect, it } from 'vitest'
import { detectSkillGesture, filterSkills, replaceGesture, skillLabel, type SkillMenu } from '../src/mobile/skill-menu'
import type { SkillSummary } from '../src/mobile/api'

const skill = (name: string, description = 'desc', modelInvocable = true): SkillSummary => ({ name, description, modelInvocable })

describe('detectSkillGesture', () => {
  it('detects a bare / at the start', () => {
    expect(detectSkillGesture('/', 1)).toEqual({ start: 0, prefix: '' })
  })

  it('detects /name typed at the start', () => {
    expect(detectSkillGesture('/code-rev', 9)).toEqual({ start: 0, prefix: 'code-rev' })
  })

  it('detects a gesture after whitespace (start at the slash)', () => {
    expect(detectSkillGesture('帮我 /code', 8)).toEqual({ start: 3, prefix: 'code' })
  })

  it('rejects a gesture glued to a word (no leading boundary)', () => {
    expect(detectSkillGesture('abc/code', 8)).toBeNull()
  })

  it('rejects when the slash is not the trailing word', () => {
    expect(detectSkillGesture('/code 后面有字', 13)).toBeNull()
  })

  it('rejects empty text', () => {
    expect(detectSkillGesture('', 0)).toBeNull()
  })
})

describe('filterSkills', () => {
  it('filters by case-insensitive name prefix', () => {
    const all = [skill('Code-Review'), skill('handoff-skill'), skill('codebase-design')]
    expect(filterSkills(all, 'code').map((s) => s.name)).toEqual(['Code-Review', 'codebase-design'])
    expect(filterSkills(all, 'CODE').map((s) => s.name)).toEqual(['Code-Review', 'codebase-design'])
  })
  it('empty prefix returns everything', () => {
    const all = [skill('a'), skill('b')]
    expect(filterSkills(all, '')).toHaveLength(2)
  })
})

describe('replaceGesture', () => {
  it('replaces the gesture with /name + trailing space, keeping the rest', () => {
    expect(replaceGesture('/co 参数', 0, 3, 'code-review')).toBe('/code-review  参数')
  })
  it('replaces mid-text gestures', () => {
    expect(replaceGesture('帮我 /co 看看', 3, 6, 'code-review')).toBe('帮我 /code-review  看看')
  })
})

describe('skillLabel', () => {
  it('annotates user-only skills like the desktop menu', () => {
    expect(skillLabel(skill('x', 'desc', false))).toBe('仅用户 · desc')
    expect(skillLabel(skill('x', 'desc', true))).toBe('desc')
  })
})
