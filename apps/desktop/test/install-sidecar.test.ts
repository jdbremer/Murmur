import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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

/**
 * A release-fetch double, and the reason these tests take a `fetchImpl` at all.
 *
 * Windows is the one platform that gets past the guard, so it is the one place
 * the coordination tests below used to run the *whole* install: two real
 * multi-hundred-MB archives off GitHub, unzipped by PowerShell, on every CI
 * run. That put a network dependency in a unit suite and left the two cases
 * sitting at ~2.5s against vitest's 5s default — close enough that a slow
 * runner turned them red for reasons that had nothing to do with the code.
 */
function stubRelease() {
  const urls: string[] = []
  const fetchImpl = async (url: string): Promise<Response> => {
    urls.push(url)
    return new Response(null, { status: 404, statusText: 'Not Found' })
  }
  return { urls, fetchImpl }
}

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

  // On Windows the install really runs, so give it a scratch userData: the
  // install and cache dirs are derived from the path it is handed, and the
  // repo-checkout branch resolves two levels up from the app dir — which for
  // a throwaway path means writing to the root of the drive.
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'murmur-sidecar-'))
  })

  afterEach(() => {
    rmSync(userData, { recursive: true, force: true })
  })

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
    const { urls, fetchImpl } = stubRelease()

    const first = installSidecarBinary('llama-server', userData, userData, { fetchImpl })
    const second = installSidecarBinary('llama-server', userData, userData, { fetchImpl })

    expect(second).toBe(first)
    await Promise.all([first, second])
    // "One attempt" is the actual claim, so assert it where it is observable
    // rather than inferring it from the promise identity alone: on Windows one
    // download starts, and elsewhere the guard returns before any fetch.
    expect(urls).toHaveLength(nonWindows ? 0 : 1)
  })

  it('does not collapse installs of different sidecars', async () => {
    const { urls, fetchImpl } = stubRelease()

    const llama = installSidecarBinary('llama-server', userData, userData, { fetchImpl })
    const whisper = installSidecarBinary('whisper-server', userData, userData, { fetchImpl })

    expect(whisper).not.toBe(llama)
    await Promise.all([llama, whisper])
    expect(urls).toHaveLength(nonWindows ? 0 : 2)
  })
})
