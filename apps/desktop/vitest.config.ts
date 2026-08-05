import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Only the Electron-free modules are unit-testable; window/tray code is
    // covered by the Playwright smoke suite once CI has macOS runners.
    include: ['test/**/*.test.ts'],
  },
})
