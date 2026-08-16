/**
 * Mobile viewport helpers: keyboard avoidance via visualViewport (iOS Safari
 * does not resize the layout viewport with the keyboard; interactive-widget
 * meta covers Chromium) and safe-area insets for notched devices.
 */
import { useEffect, useState } from 'react'

export interface ViewportState {
  /** Height of the visible (keyboard-adjusted) viewport in px, or null when unknown. */
  visualHeight: number | null
  /** Safe-area insets, e.g. 'env(safe-area-inset-top)'. */
  insets: { top: string; right: string; bottom: string; left: string }
}

function readInsets(): ViewportState['insets'] {
  const el = document.createElement('div')
  el.style.cssText = 'position:fixed;top:0;left:0;width:env(safe-area-inset-top);height:env(safe-area-inset-right);visibility:hidden;pointer-events:none'
  document.body.appendChild(el)
  const w = el.offsetWidth
  const h = el.offsetHeight
  el.remove()
  return { top: `${h}px`, right: `${w}px`, bottom: `${h}px`, left: `${w}px` }
}

export function useViewport(): ViewportState {
  const [state, setState] = useState<ViewportState>(() => ({
    visualHeight: window.visualViewport !== null && window.visualViewport !== undefined ? window.visualViewport.height : null,
    insets: readInsets(),
  }))

  useEffect(() => {
    const vv = window.visualViewport
    if (vv === null || vv === undefined) return
    const onResize = (): void => setState((s) => ({ ...s, visualHeight: vv.height }))
    vv.addEventListener('resize', onResize)
    vv.addEventListener('scroll', onResize)
    return () => {
      vv.removeEventListener('resize', onResize)
      vv.removeEventListener('scroll', onResize)
    }
  }, [])

  return state
}
