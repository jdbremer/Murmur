import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Main-process modules that import `electron` at the top level (the
      // injector's clipboard, the ONNX engine's utilityProcess) are still worth
      // unit-testing. The stub provides only what Murmur touches — see the
      // header comment in test/helpers/electron.ts.
      electron: resolve(__dirname, 'test/helpers/electron.ts'),
    },
  },
  test: {
    environment: 'node',
    // Window and tray code stays out: it needs a real Electron runtime and is
    // covered by the Playwright smoke suite once CI has macOS runners.
    include: ['test/**/*.test.ts'],

    // Much of this suite is disk-bound — real SQLite files, real WAVs — and
    // CI's Windows runner is occasionally an order of magnitude slower at that
    // than the Mac and Linux legs. A case that takes ~200ms locally has been
    // seen at 15s there, with the whole file suite going 13s → 81s, so the
    // 5s default was really an assertion about runner speed rather than about
    // the code. Budget from the slowest honest run instead; a genuine hang
    // still fails, just later. Hooks get the same because `store.test.ts`
    // opens and migrates a database in `beforeEach`.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
