/**
 * dsh-lan-web — mobile skill menu: desktop-parity `/` gesture.
 *
 * Desktop parity (verified against dsh-client-ui-skill + input-trigger):
 * typing `/` opens a menu of user-invocable skills (name + description,
 * non-model-invocable prefixed "仅用户 ·"); picking one inserts the text
 * `/<skill-name> ` into the composer — NOT sending — and the user hits
 * Enter to send it as a plain prompt; the host's dsh-tool-skill pre-step
 * hook recognizes the `/name` gesture and injects <skill_content>.
 */
import { createElement } from 'react'
import type { SkillSummary } from './api'

/**
 * Detect a `/` gesture ending at the cursor. Returns the gesture start index
 * and the typed prefix ('' when the bare `/` was just typed), or null.
 * Word-boundary rules mirror the desktop: `/name` must be followed by space
 * or end-of-line, preceded by start-of-line or whitespace.
 */
export function detectSkillGesture(text: string, cursor: number): { start: number; prefix: string } | null {
  if (cursor < 1) return null
  const before = text.slice(0, cursor)
  const match = /(^|\s)\/([a-z0-9-]*)$/i.exec(before)
  if (match === null) return null
  // start points at the '/' itself so the leading whitespace is preserved.
  const slashIndex = match.index + match[0].indexOf('/')
  return { start: slashIndex, prefix: match[2] ?? '' }
}

/** Prefix-filter the skill list (desktop filters candidates by name prefix). */
export function filterSkills(skills: SkillSummary[], prefix: string): SkillSummary[] {
  const p = prefix.toLowerCase()
  return skills.filter((s) => s.name.toLowerCase().startsWith(p))
}

/** Build the replacement text for the composer when a skill is picked. */
export function replaceGesture(text: string, start: number, cursor: number, skillName: string): string {
  return `${text.slice(0, start)}/${skillName} ${text.slice(cursor)}`
}

/** Desktop-style label: user-only skills are annotated in the menu. */
export function skillLabel(skill: SkillSummary): string {
  return skill.modelInvocable ? skill.description : `仅用户 · ${skill.description}`
}

export function SkillMenu({
  skills,
  loading,
  error,
  onPick,
  onClose,
}: {
  skills: SkillSummary[]
  loading: boolean
  error: string | null
  onPick: (skill: SkillSummary) => void
  onClose: () => void
}) {
  const s: Record<string, import('react').CSSProperties> = {
    overlay: {
      position: 'absolute',
      bottom: '100%',
      left: 12,
      right: 12,
      maxHeight: 240,
      overflowY: 'auto',
      background: '#1a1d24',
      border: '1px solid #333a45',
      borderRadius: 12,
      boxShadow: '0 -8px 32px rgba(0,0,0,0.4)',
      zIndex: 10,
    },
    row: {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      width: '100%',
      minHeight: 52,
      padding: '10px 14px',
      background: 'none',
      border: 'none',
      borderBottom: '1px solid #232833',
      textAlign: 'left',
      color: '#e6e6e6',
      fontFamily: 'inherit',
    },
    name: { fontSize: 15, fontWeight: 600, color: '#3b82f6' },
    desc: { fontSize: 12, color: '#9aa0ab', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    empty: { padding: '14px 16px', fontSize: 13, color: '#7c8494' },
  }

  return createElement(
    'div',
    { style: s.overlay },
    loading
      ? createElement('div', { style: s.empty }, '技能加载中…')
      : error !== null
        ? createElement('div', { style: s.empty }, error)
        : skills.length === 0
          ? createElement('div', { style: s.empty }, '没有匹配的技能')
          : skills.map((skill) =>
              createElement(
                'button',
                {
                  key: skill.name,
                  type: 'button',
                  style: s.row,
                  // Keep the composer focused: a blur would close the menu
                  // before the tap lands (mobile fires blur before click).
                  onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
                  onClick: () => {
                    onPick(skill)
                    onClose()
                  },
                },
                createElement('span', { style: s.name }, `/${skill.name}`),
                createElement('span', { style: s.desc }, skillLabel(skill)),
              ),
            ),
  )
}
