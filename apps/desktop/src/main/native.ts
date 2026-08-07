import { createNativeStub, type MurmurNative } from '@murmur/shared'

/**
 * The one place the app touches `@murmur/native` (PLAN §4, §4.1).
 *
 *  - **macOS / Windows / Linux with the addon built** — real module.
 *  - **Supported OS without a build** — package stub / load failure stub.
 *  - **Any other OS (or missing package)** — `createNativeStub()` from shared.
 *
 * Note Linux is "supported" here in the sense that the addon compiles and
 * loads. It still answers `available: false` on a Wayland session — that is
 * the binding's own verdict, carried through `describeNative()`, not a reason
 * to refuse to load it.
 *
 * `@murmur/native` is external in electron.vite.config.ts so this `require`
 * stays a runtime lookup.
 */

const SUPPORTED = new Set(['darwin', 'win32', 'linux'])

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
