import { app } from 'electron'

import type { UpdateCheckResult } from '@murmur/shared'

import { createLogger } from './logging'
import { updateCheckFetch } from './net/fetch'

/**
 * "Check for updates" — user-pressed, never on a timer (PLAN §10.2).
 *
 * Murmur's Help panel promises no telemetry and no update pings, and a
 * background check would quietly make that false: it would tell GitHub this
 * machine's IP, which version it runs and when it is awake, on a schedule the
 * user never agreed to. So this is a button, the panel says what it contacts,
 * and nothing calls it automatically.
 *
 * It reports what is available; it does not install. On macOS Squirrel refuses
 * to update an app that is not Developer-ID signed, so an installer that
 * claimed it could self-update would fail at the last step — after downloading
 * — which is a worse experience than an honest link.
 */

const RELEASES_API = 'https://api.github.com/repos/jdbremer/Murmur/releases/latest'
const RELEASES_PAGE = 'https://github.com/jdbremer/Murmur/releases/latest'
const TIMEOUT_MS = 10_000

const log = createLogger('updates')

/**
 * Compare two dotted numeric versions.
 *
 * @returns positive when `a` is newer, negative when older, 0 when equal.
 *
 * Deliberately small: the tags this compares are our own, and pulling in a
 * semver library to read three integers would be the larger risk. Anything
 * non-numeric (a `-beta` suffix) is ignored rather than guessed at, which makes
 * a prerelease compare equal to its release — acceptable because the GitHub
 * endpoint used here never returns prereleases.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10))
      .filter((n) => Number.isFinite(n))

  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.length, right.length)

  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * True only for this project's own release pages on github.com over https.
 *
 * `shell.openExternal` hands a string straight to the OS, so the renderer must
 * never be able to choose it freely — the URL travelling out and back over IPC
 * is re-checked here rather than trusted because we produced it a moment ago.
 */
export function isUpdateReleaseUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.hostname.toLowerCase() !== 'github.com') return false
  return parsed.pathname.startsWith('/jdbremer/Murmur/releases')
}

interface GithubRelease {
  tag_name?: unknown
  html_url?: unknown
  draft?: unknown
  prerelease?: unknown
}

export interface CheckOptions {
  /** Injected in tests. */
  fetchImpl?: typeof globalThis.fetch
  currentVersion?: string
}

export async function checkForUpdate(options: CheckOptions = {}): Promise<UpdateCheckResult> {
  const currentVersion = options.currentVersion ?? app.getVersion()

  try {
    const response = await updateCheckFetch(RELEASES_API, {
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (response.status === 404) {
      // No published release yet — a draft does not count, and this is the
      // normal answer for a repo that has never shipped.
      return { status: 'none', currentVersion, latestVersion: null, url: RELEASES_PAGE }
    }
    if (!response.ok) {
      return {
        status: 'error',
        currentVersion,
        latestVersion: null,
        url: RELEASES_PAGE,
        message: `GitHub replied ${response.status}.`,
      }
    }

    const release = (await response.json()) as GithubRelease
    const tag = typeof release.tag_name === 'string' ? release.tag_name : null
    if (tag === null) {
      return {
        status: 'error',
        currentVersion,
        latestVersion: null,
        url: RELEASES_PAGE,
        message: 'The release feed did not include a version.',
      }
    }

    const latestVersion = tag.replace(/^v/i, '')
    const url = typeof release.html_url === 'string' ? release.html_url : RELEASES_PAGE
    const newer = compareVersions(latestVersion, currentVersion) > 0
    log.info(`update check: running ${currentVersion}, latest ${latestVersion}`)

    return {
      status: newer ? 'available' : 'current',
      currentVersion,
      latestVersion,
      url,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`update check failed: ${message}`)
    return {
      status: 'error',
      currentVersion,
      latestVersion: null,
      url: RELEASES_PAGE,
      message: 'Could not reach GitHub. Check your connection and try again.',
    }
  }
}
