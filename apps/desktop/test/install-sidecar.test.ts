import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { defaultSidecarInstallDir, installSidecarBinary } from '../src/main/engines/install-sidecar'

/**
 * The in-app sidecar installer (WINDOWS-HANDOFF Phase G).
 *
 * This is the one path in the app that downloads an **executable**, so the
 * parts asserted here are the ones whose failure is not merely an inconvenience:
 * that it refuses to run anywhere it has not been proven, that it writes
 * somewhere a packaged app can actually write, and that two clicks cannot race
 * each other onto the same file.
 */

describe('install destination', () => {
  it('uses the repo checkout when unpackaged', () => {
    const dir = defaultSidecarInstallDir('/repo/apps/desktop')
    expect(dir).toContain('.sidecars')
    expect(dir).not.toContain('userData')
  })

  it('uses userData when packaged, because the app dir is read-only there', () => {
    // C:\Program Files\Murmur is not writable by a standard user; landing there
    // surfaces a raw EPERM in the install card instead of a working binary.
    expect(defaultSidecarInstallDir('/Applications/Murmur.app', '/userData')).toBe(
      join('/userData', 'sidecars', 'bin'),
    )
  })
})

describe('installSidecarBinary', () => {
  const nonWindows = process.platform !== 'win32'

  it.runIf(nonWindows)('refuses on platforms it has no build for', async () => {
    const result = await installSidecarBinary('llama-server', '/repo/apps/desktop')
    expect(result.ok).toBe(false)
    expect(result.error).toBe('unsupported-platform')
    // The message has to name a way forward on the platform the user is on.
    expect(result.detail).toMatch(/build-\*\.sh/)
    expect(result.path).toBeNull()
  })

  it.runIf(nonWindows)('never partially applies: a refusal writes nothing', async () => {
    const result = await installSidecarBinary('whisper-server', '/nonexistent/apps/desktop')
    expect(result.ok).toBe(false)
    expect(result.path).toBeNull()
  })

  it('collapses concurrent installs of the same sidecar into one attempt', async () => {
    // Two overlapping downloads write the same zip path with interleaved bytes;
    // the corrupt archive then poisons the cache for every later attempt.
    const first = installSidecarBinary('llama-server', '/repo/apps/desktop')
    const second = installSidecarBinary('llama-server', '/repo/apps/desktop')
    expect(second).toBe(first)
    await Promise.all([first, second])
  })

  it('does not collapse installs of different sidecars', async () => {
    const llama = installSidecarBinary('llama-server', '/repo/apps/desktop')
    const whisper = installSidecarBinary('whisper-server', '/repo/apps/desktop')
    expect(whisper).not.toBe(llama)
    await Promise.all([llama, whisper])
  })
})
