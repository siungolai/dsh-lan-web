/**
 * vitest config — default excludes plus the iCloud `.nosync` dependency
 * directory (vitest only excludes the literal `node_modules` segment).
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/node_modules.nosync/**',
      '**/dist/**',
      '**/lib/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
  },
})
