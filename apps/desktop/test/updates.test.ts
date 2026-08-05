import { describe, expect, it } from 'vitest'

import { checkForUpdate, compareVersions, isUpdateReleaseUrl } from '../src/main/updates'

/**
 * The update check (PLAN §10.2).
 *
 * Two things carry real risk here. A version comparison that says "up to date"
 * when it is not silently strands users on an old build, and `openReleasePage`
 * feeds a string to `shell.openExternal` — an arbitrary-URL-open primitive if
 * the renderer can choose it.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('compareVersions', () => {
  it('orders by numeric component, not lexically', () => {
    // The lexical trap: "0.10.0" < "0.9.0" as strings.
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0)
  })

  it('ignores a leading v, since tags carry one and package.json does not', () => {
    expect(compareVersions('v0.2.0', '0.1.0')).toBeGreaterThan(0)
    expect(compareVersions('v1.2.3', 'v1.2.3')).toBe(0)
  })

  it('treats missing components as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0)
  })
})

describe('isUpdateReleaseUrl', () => {
  it('accepts this project’s release pages over https', () => {
    expect(isUpdateReleaseUrl('https://github.com/jdbremer/Murmur/releases/latest')).toBe(true)
    expect(isUpdateReleaseUrl('https://github.com/jdbremer/Murmur/releases/tag/v0.2.0')).toBe(true)
  })

  it('refuses anything else the renderer could hand it', () => {
    for (const url of [
      'https://github.com/attacker/Murmur/releases/latest', // another owner
      'https://github.com/jdbremer/Other/releases', // another repo
      'https://evil.example.com/jdbremer/Murmur/releases', // another host
      'http://github.com/jdbremer/Murmur/releases', // downgraded scheme
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      expect(isUpdateReleaseUrl(url), url).toBe(false)
    }
  })
})

describe('checkForUpdate', () => {
  it('reports an available update when the release is newer', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: async () =>
        jsonResponse({
          tag_name: 'v0.2.0',
          html_url: 'https://github.com/jdbremer/Murmur/releases/tag/v0.2.0',
        }),
    })
    expect(result.status).toBe('available')
    expect(result.latestVersion).toBe('0.2.0')
    expect(result.currentVersion).toBe('0.1.0')
  })

  it('reports current when the running build matches', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.2.0',
      fetchImpl: async () => jsonResponse({ tag_name: 'v0.2.0' }),
    })
    expect(result.status).toBe('current')
  })

  it('never reports an older release as an update', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.3.0',
      fetchImpl: async () => jsonResponse({ tag_name: 'v0.2.0' }),
    })
    expect(result.status).toBe('current')
  })

  it('distinguishes "nothing published" from "you are up to date"', async () => {
    // A 404 means no published release. Saying "up to date" there would be a
    // claim we cannot support — there is nothing to compare against.
    const result = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: async () => new Response('', { status: 404 }),
    })
    expect(result.status).toBe('none')
    expect(result.latestVersion).toBeNull()
  })

  it('surfaces a network failure as an error, not as up to date', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      },
    })
    expect(result.status).toBe('error')
    expect(result.message).toBeTruthy()
  })

  it('errors rather than guessing when the feed has no version', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: async () => jsonResponse({ name: 'no tag here' }),
    })
    expect(result.status).toBe('error')
  })

  it('falls back to the releases page when the feed omits a url', async () => {
    const result = await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: async () => jsonResponse({ tag_name: 'v9.9.9' }),
    })
    expect(result.status).toBe('available')
    expect(isUpdateReleaseUrl(result.url)).toBe(true)
  })

  it('only ever contacts the GitHub API', async () => {
    const seen: string[] = []
    await checkForUpdate({
      currentVersion: '0.1.0',
      fetchImpl: async (input) => {
        seen.push(String(input))
        return jsonResponse({ tag_name: 'v0.1.0' })
      },
    })
    expect(seen).toHaveLength(1)
    expect(new URL(seen[0]!).hostname).toBe('api.github.com')
  })
})
