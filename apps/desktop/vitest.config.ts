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
  },
})
