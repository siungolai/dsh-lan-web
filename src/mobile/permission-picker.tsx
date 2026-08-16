/**
 * dsh-lan-web — mobile permission picker: bottom sheet with the three
 * sandbox presets (read-only / workspace-write / danger-full-access) from
 * the live permissions projection; danger-full-access requires an explicit
 * risk confirmation (desktop RiskConfirmation parity).
 */
import { createElement, useState } from 'react'
import { PERMISSION_ICONS, type PermissionOption, type PermissionsState } from './api'

export function PermissionPicker({
  state,
  onSelect,
  onClose,
}: {
  state: PermissionsState
  onSelect: (value: string) => void
  onClose: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const current = state.currentValue

  const s: Record<string, import('react').CSSProperties> = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 100, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' },
    sheet: { background: '#14171d', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 'env(safe-area-inset-bottom)' },
    header: { display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #232833', minHeight: 48 },
    headerTitle: { flex: 1, fontSize: 16, fontWeight: 600, color: '#e6e6e6' },
    close: { minWidth: 44, minHeight: 44, background: 'none', border: 'none', color: '#9aa0ab', fontSize: 18 },
    row: { display: 'flex', alignItems: 'center', gap: 12, width: '100%', minHeight: 56, padding: '10px 16px', background: 'none', border: 'none', borderBottom: '1px solid #1c2129', textAlign: 'left', color: '#e6e6e6', fontFamily: 'inherit' },
    icon: { fontSize: 18, width: 28, textAlign: 'center' as const },
    name: { fontSize: 15, fontWeight: 500, flex: 1 },
    desc: { fontSize: 12, color: '#7c8494', marginTop: 2 },
    mark: { color: '#3b82f6', fontSize: 13 },
    confirmBox: { padding: '16px 16px 20px' },
    confirmTitle: { fontSize: 15, fontWeight: 600, color: '#f87171', marginBottom: 8 },
    confirmText: { fontSize: 13, color: '#c3c7cf', lineHeight: 1.6, marginBottom: 14 },
    confirmBtn: { width: '100%', minHeight: 44, borderRadius: 10, border: 'none', background: '#dc2626', color: '#fff', fontSize: 15, fontWeight: 600 },
    cancelBtn: { width: '100%', minHeight: 44, marginTop: 8, borderRadius: 10, border: 'none', background: '#1a1d24', color: '#9aa0ab', fontSize: 14 },
  }

  if (confirming) {
    return createElement(
      'div',
      { style: s.overlay, onClick: onClose },
      createElement(
        'div',
        { style: s.sheet, onClick: (e: { stopPropagation(): void }) => e.stopPropagation() },
        createElement('div', { style: s.confirmBox },
          createElement('div', { style: s.confirmTitle }, '⚠️ 完全访问确认'),
          createElement('div', { style: s.confirmText },
            '切换到「完全访问」后，AI 可直接执行任意命令（含删除文件、修改系统配置），且审批策略将改为「永不询问」。请确认你了解风险。',
          ),
          createElement('button', { type: 'button', style: s.confirmBtn, onClick: () => { setConfirming(false); onSelect('danger-full-access') } }, '确认切换'),
          createElement('button', { type: 'button', style: s.cancelBtn, onClick: () => setConfirming(false) }, '取消'),
        ),
      ),
    )
  }

  return createElement(
    'div',
    { style: s.overlay, onClick: onClose },
    createElement(
      'div',
      { style: s.sheet, onClick: (e: { stopPropagation(): void }) => e.stopPropagation() },
      createElement('div', { style: s.header },
        createElement('div', { style: s.headerTitle }, '沙箱权限'),
        createElement('button', { type: 'button', style: s.close, onClick: onClose }, '✕'),
      ),
      state.options.map((opt: PermissionOption) => {
        const active = opt.value === current
        return createElement(
          'button',
          {
            key: opt.value,
            type: 'button',
            style: s.row,
            onClick: () => {
              if (opt.value === 'danger-full-access') setConfirming(true)
              else onSelect(opt.value)
            },
          },
          createElement('span', { style: s.icon }, PERMISSION_ICONS[opt.value] ?? '🔒'),
          createElement('span', { style: { flex: 1 } },
            createElement('span', { style: s.name }, opt.name),
            opt.description !== undefined ? createElement('div', { style: s.desc }, opt.description) : null,
          ),
          active ? createElement('span', { style: s.mark }, '● 当前') : null,
        )
      }),
    ),
  )
}
