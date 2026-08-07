import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every manifest in the repo carries the same version.
 *
 * This exists because releasing is the one workflow where getting it wrong is
 * both easy and invisible. `npm version --workspaces` covers the root,
 * `apps/desktop` and `packages/shared` — but **not `packages/native`**, which
 * is deliberately not a workspace: `apps/desktop` declares it as an
 * *optional* dependency so that a machine which cannot run node-gyp still
 * installs and runs against the stub. Promoting it to a workspace to make one
 * npm command tidier would make a failed native build fail the whole install.
 *
 * So the manual step stays, and this is what stops anyone forgetting it: bump
 * three of four and the gate says so, rather than a release shipping with a
 * native module that reports the previous version.
 */

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const MANIFESTS = [
  'package.json',
  'apps/desktop/package.json',
  'packages/shared/package.json',
  'packages/native/package.json',
] as const

/** The lock's own copies, which `npm version` updates for workspaces only. */
const LOCK_PATHS = ['', 'apps/desktop', 'packages/shared', 'packages/native'] as const

function read(path: string): { version?: string } {
  return JSON.parse(readFileSync(join(repo, path), 'utf8')) as { version?: string }
}

describe('release versions', () => {
  it('are identical across every manifest', () => {
    const versions = MANIFESTS.map((path) => [path, read(path).version] as const)
    const expected = versions[0]?.[1]
    expect(expected, 'the root package.json has no version').toBeTruthy()
    for (const [path, version] of versions) {
      expect(version, `${path} is out of step with package.json`).toBe(expected)
    }
  })

  it('match the lockfile, including the package npm version skips', () => {
    const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')) as {
      version?: string
      packages?: Record<string, { version?: string }>
    }
    const expected = read('package.json').version
    expect(lock.version, 'package-lock.json is out of step with package.json').toBe(expected)
    for (const path of LOCK_PATHS) {
      expect(
        lock.packages?.[path]?.version,
        `package-lock.json entry "${path || '.'}" is out of step`,
      ).toBe(expected)
    }
  })
})
