/**
 * Mobile viewport helpers: keyboard avoidance via visualViewport (iOS Safari
 * does not resize the layout viewport with the keyboard; interactive-widget
 * meta covers Chromium). Safe areas are handled by plain CSS env() strings in
 * the app shell — no JS measurement needed.
 */
import { useEffect, useState } from 'react'

export interface ViewportState {
  /** Height of the visible (keyboard-adjusted) viewport in px, or null when unknown. */
  visualHeight: number | null
}

export function useViewport(): ViewportState {
  const [visualHeight, setVisualHeight] = useState<number | null>(() =>
    window.visualViewport !== null && window.visualViewport !== undefined ? window.visualViewport.height : null,
  )

  useEffect(() => {
    const vv = window.visualViewport
    if (vv === null || vv === undefined) return
    const onResize = (): void => setVisualHeight(vv.height)
    vv.addEventListener('resize', onResize)
    vv.addEventListener('scroll', onResize)
    return () => {
      vv.removeEventListener('resize', onResize)
      vv.removeEventListener('scroll', onResize)
    }
  }, [])

  return { visualHeight }
}
