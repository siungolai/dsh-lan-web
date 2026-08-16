/**
 * Build config for the dsh-lan-web plugin.
 *
 * Uses the repo's shared client-bundle preset (shared/tsdown.client.ts,
 * standard DSH plugin build convention):
 *  - node half: lib/index.js (ESM, `fixedExtension: false`),
 *  - browser half: lib/client.js — a closure-factory artifact registered via
 *    `window.__ModuleLoader__.load({id, factory})` for the GUI's module
 *    loader, with externals resolved from the platform module table.
 * Types ship from lib/types (tsc); the preset keeps `clean: false` so tsc's
 * output survives the bundling pass.
 */
import { clientBundle, mobileBundle } from './shared/tsdown.client.ts'

const base = clientBundle('dsh-lan-web', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-settings',
  ],
})

// The /m mobile surface is a standalone page bundle (self-contained React,
// served by the plugin's own route — no GUI module loader).
export default (inline: Parameters<typeof base>[0]) => [
  ...base(inline),
  mobileBundle('dsh-lan-web', 'src/mobile/index.tsx'),
]
