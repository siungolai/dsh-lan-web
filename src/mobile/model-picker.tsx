/**
 * dsh-lan-web — mobile model picker: bottom sheet with provider groups →
 * model rows → reasoning-effort chips (desktop-parity, two-step in one sheet).
 */
import { createElement, useState } from 'react'
import type { ModelCatalog, ModelGroup, ModelInfo, ModelSelection } from './api'

export function ModelPicker({
  catalog,
  current,
  onSelect,
  onClose,
}: {
  catalog: ModelCatalog
  current: ModelSelection
  onSelect: (selection: ModelSelection) => void
  onClose: () => void
}) {
  // Second step: the picked model shows its reasoning-effort chips.
  const [picked, setPicked] = useState<{ group: ModelGroup; model: ModelInfo } | null>(null)

  const s: Record<string, import('react').CSSProperties> = {
    overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 100, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' },
    sheet: { background: '#14171d', borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '70vh', display: 'flex', flexDirection: 'column', paddingBottom: 'env(safe-area-inset-bottom)' },
    header: { display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #232833', minHeight: 48 },
    headerTitle: { flex: 1, fontSize: 16, fontWeight: 600, color: '#e6e6e6' },
    close: { minWidth: 44, minHeight: 44, background: 'none', border: 'none', color: '#9aa0ab', fontSize: 18 },
    body: { overflowY: 'auto', padding: '4px 0' },
    groupLabel: { padding: '12px 16px 4px', fontSize: 12, color: '#7c8494', fontWeight: 600 },
    modelRow: { display: 'flex', flexDirection: 'column', gap: 2, width: '100%', minHeight: 52, padding: '10px 16px', background: 'none', border: 'none', textAlign: 'left', color: '#e6e6e6', fontFamily: 'inherit', borderBottom: '1px solid #1c2129' },
    modelName: { fontSize: 15, fontWeight: 500 },
    modelDesc: { fontSize: 12, color: '#7c8494' },
    currentMark: { color: '#3b82f6', marginLeft: 6, fontSize: 13 },
    chips: { display: 'flex', gap: 8, padding: '10px 16px 14px', flexWrap: 'wrap' },
    chip: { minHeight: 40, padding: '0 14px', borderRadius: 20, border: '1px solid #333a45', background: '#0f1115', color: '#c3c7cf', fontSize: 13 },
    chipActive: { borderColor: '#3b82f6', background: '#1d4ed8', color: '#fff' },
  }

  const currentKey = `${current.provider}/${current.model}`
  const isCurrent = (g: ModelGroup, m: ModelInfo): boolean => `${g.id}/${m.id}` === currentKey

  return createElement(
    'div',
    { style: s.overlay, onClick: onClose },
    createElement(
      'div',
      { style: s.sheet, onClick: (e: { stopPropagation(): void }) => e.stopPropagation() },
      createElement(
        'div',
        { style: s.header },
        createElement('div', { style: s.headerTitle }, picked !== null ? picked.model.name : '选择模型'),
        createElement('button', { type: 'button', style: s.close, onClick: onClose }, '✕'),
      ),
      picked === null
        ? createElement(
            'div',
            { style: s.body },
            catalog.groups.map((g) =>
              createElement(
                'div',
                { key: g.id },
                createElement('div', { style: s.groupLabel }, g.name),
                g.models.map((m) =>
                  createElement(
                    'button',
                    {
                      key: m.id,
                      type: 'button',
                      style: s.modelRow,
                      onClick: () => {
                        if (m.reasoning !== undefined && m.reasoning.efforts.length > 0) setPicked({ group: g, model: m })
                        else onSelect({ provider: g.id, model: m.id })
                      },
                    },
                    createElement('span', { style: s.modelName },
                      m.name,
                      isCurrent(g, m) ? createElement('span', { style: s.currentMark }, '● 当前') : null,
                    ),
                    m.description !== undefined ? createElement('span', { style: s.modelDesc }, m.description) : null,
                  ),
                ),
              ),
            ),
          )
        : createElement(
            'div',
            { style: s.body },
            createElement('div', { style: s.groupLabel }, '推理强度'),
            createElement(
              'div',
              { style: s.chips },
              picked.model.reasoning?.efforts.map((e) => {
                const active = current.provider === picked!.group.id && current.model === picked!.model.id && current.reasoningEffort === e.id
                return createElement(
                  'button',
                  {
                    key: e.id,
                    type: 'button',
                    style: active ? { ...s.chip, ...s.chipActive } : s.chip,
                    onClick: () => onSelect({ provider: picked!.group.id, model: picked!.model.id, reasoningEffort: e.id }),
                  },
                  e.name,
                )
              }),
            ),
            createElement(
              'div',
              { style: { padding: '0 16px 14px' } },
              createElement('button', { type: 'button', style: { minHeight: 40, background: 'none', border: 'none', color: '#3b82f6', fontSize: 13 }, onClick: () => setPicked(null) }, '‹ 返回模型列表'),
            ),
          ),
    ),
  )
}
