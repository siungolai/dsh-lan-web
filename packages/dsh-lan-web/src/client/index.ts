/**
 * dsh-lan-web — browser half (injected into the DSH web GUI).
 *
 * Responsibilities (see PLAN.md):
 *   M2: login page + settings card (password, device list, kick device)
 *   M3: responsive layout / touch-friendly styles
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-lan-web-client'

export function apply(ctx: Context) {
  // TODO(M2): login page slot — show when LAN session is invalid,
  //   POST /api/lan-web/login, remember-me handling.
  // TODO(M2): settings card — set/change password, list devices, revoke device.
  // TODO(M3): inject responsive CSS (<=768px breakpoints, touch targets >=44px).
}
