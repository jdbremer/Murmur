import { createNativeStub, type MurmurNative } from '@murmur/shared'

/**
 * The one place the app touches `@murmur/native` (PLAN §4).
 *
 * Three things can happen, and all three are normal:
 *
 *  - **macOS with the addon built** — the real module loads and drives the
 *    event tap, text injection and permission checks.
 *  - **macOS without a build** — `@murmur/native`'s own wrapper hands back its
 *    stub; run `npm run native:build` to get the real thing.
 *  - **Linux/Windows dev** — the package declares `"os": ["darwin"]`, so npm
 *    skips it entirely and `require` throws MODULE_NOT_FOUND. We substitute
 *    `createNativeStub()` from `@murmur/shared` and the app boots as normal,
 *    just without system-wide dictation.
 *
 * `@murmur/native` is marked external in electron.vite.config.ts, so this
 * `require` survives bundling as a genuine runtime lookup.
 */

let cached: MurmurNative | null = null

function loadNative(): MurmurNative {
  if (process.platform !== 'darwin') {
    return createNativeStub(`unsupported platform "${process.platform}"`)
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('@murmur/native') as MurmurNative
    return loaded
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return createNativeStub(`@murmur/native could not be loaded: ${message}`)
  }
}

/** The native module, or an inert stub with the same shape. Never throws. */
export function native(): MurmurNative {
  cached ??= loadNative()
  return cached
}

/** One-line description for logs and the Help panel. */
export function describeNative(): string {
  const module = native()
  return `@murmur/native: ${module.available ? 'active' : 'stub'} — ${module.platformInfo()}`
}
