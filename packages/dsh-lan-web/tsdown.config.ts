import { defineConfig } from 'tsdown'

// Dual-half build: Host half (src/index.ts -> lib/index.js) and
// browser half (src/client/index.ts -> lib/client.js).
// TODO(M1): verify tsdown options against the DSH plugin build convention
// (tsc emits types into lib/types, tsdown bundles the two halves).
export default defineConfig({
  entry: ['src/index.ts', 'src/client/index.ts'],
  format: ['esm'],
  outDir: 'lib',
  sourcemap: true,
  target: 'node22',
})
