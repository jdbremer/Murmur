import { createNativeStub, type MurmurNative } from '@murmur/shared'

/**
 * The one place the app touches `@murmur/native` (PLAN §4, §4.1).
 *
 *  - **macOS / Windows with the addon built** — real module.
 *  - **Supported OS without a build** — package stub / load failure stub.
 *  - **Linux (or missing package)** — `createNativeStub()` from shared.
 *
 * `@murmur/native` is external in electron.vite.config.ts so this `require`
 * stays a runtime lookup.
 */

const SUPPORTED = new Set(['darwin', 'win32'])

let cached: MurmurNative | null = null

function loadNative(): MurmurNative {
  if (!SUPPORTED.has(process.platform)) {
    return createNativeStub(`unsupported platform "${process.platform}"`)
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('@murmur/native') as MurmurNative & { default?: MurmurNative }
    // CJS default export shape.
    const mod = (loaded as { default?: MurmurNative }).default ?? loaded
    return mod
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
