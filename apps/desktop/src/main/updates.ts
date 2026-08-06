import { app } from 'electron'
import electronUpdater from 'electron-updater'

import type { UpdateState } from '@murmur/shared'

import { createLogger } from './logging'

/**
 * Updates (PLAN §10.2) — user-pressed, never on a timer.
 *
 * Help promises no telemetry and nothing on a schedule, and a background poll
 * would make that false: it tells GitHub this machine's IP, its version and
 * when it is awake, on a cadence nobody agreed to. So `autoDownload` is off
 * too — finding an update and fetching 190 MB are separate consents.
 *
 * ## Where this sits relative to `net/fetch.ts`
 *
 * It does not go through those wrappers. `electron-updater` owns its own HTTP
 * stack, so the "every outbound request resolves to one of four wrappers"
 * property in that file's header does not cover this path. That is a real
 * exception and it is written down rather than glossed: the hosts are GitHub's
 * release CDN, the requests only happen when a button is pressed, and the
 * payload is verified against the signature and blockmap electron-builder
 * published beside the installer.
 *
 * ## Why macOS needed a certificate first
 *
 * Squirrel refuses to let an app replace itself unless the replacement carries
 * the same Developer ID signature. Before that certificate existed this file
 * could only report and link. `isSelfUpdateSupported` is what keeps the UI
 * honest if it ever runs in a build that cannot do it.
 */

// electron-updater ships CommonJS; the named export is not reachable directly
// from an ESM bundle.
const { autoUpdater } = electronUpdater

const RELEASES_PAGE = 'https://github.com/jdbremer/Murmur/releases/latest'

const log = createLogger('updates')

let state: UpdateState = {
  status: 'idle',
  currentVersion: '0.0.0',
  latestVersion: null,
  percent: null,
  url: RELEASES_PAGE,
}

type Listener = (state: UpdateState) => void
let notify: Listener = () => undefined

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  notify(state)
}

/**
 * Compare two dotted numeric versions.
 *
 * @returns positive when `a` is newer, negative when older, 0 when equal.
 *
 * Kept even though electron-updater does its own comparison: the fallback path
 * (report-and-link, when self-update is unsupported) still needs to decide
 * whether a release is newer, and pulling in a semver library to read three
 * integers would be the larger risk.
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
 * is re-checked rather than trusted because we produced it a moment ago.
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

/**
 * Whether this build can replace itself.
 *
 * An unpackaged dev run has no installer to swap, and macOS additionally needs
 * a Developer ID signature — Squirrel will download an update and then refuse
 * it at the last step, which is worse than never offering.
 */
export function isSelfUpdateSupported(): { ok: boolean; reason?: string } {
  if (!app.isPackaged) {
    return { ok: false, reason: 'Development builds cannot update themselves.' }
  }
  return { ok: true }
}

export function initUpdates(listener: Listener): void {
  notify = listener
  state = { ...state, currentVersion: app.getVersion() }

  // Both off deliberately: see the header. Checking is a button, downloading
  // is a second button.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = null

  autoUpdater.on('update-available', (info) => {
    log.info(`update available: ${info.version}`)
    setState({ status: 'available', latestVersion: info.version, percent: null })
  })
  autoUpdater.on('update-not-available', () => {
    setState({ status: 'current', latestVersion: state.currentVersion, percent: null })
  })
  autoUpdater.on('download-progress', (progress) => {
    setState({ status: 'downloading', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`update downloaded: ${info.version}`)
    setState({ status: 'downloaded', latestVersion: info.version, percent: 100 })
  })
  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`update error: ${message}`)
    setState({ status: 'error', percent: null, message: describeError(message) })
  })
}

export function updateState(): UpdateState {
  return state
}

export async function checkForUpdate(): Promise<UpdateState> {
  const supported = isSelfUpdateSupported()
  if (!supported.ok) {
    // Still worth telling the user a release exists, even when we cannot
    // install it for them.
    setState({ status: 'unsupported', message: supported.reason ?? '' })
    return state
  }

  setState({ status: 'checking', percent: null })
  try {
    const result = await autoUpdater.checkForUpdates()
    if (result === null) {
      setState({ status: 'error', message: 'The update check did not run.' })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`update check failed: ${message}`)
    setState({ status: notFound(message) ? 'none' : 'error', message: describeError(message) })
  }
  return state
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (state.status !== 'available') return state
  setState({ status: 'downloading', percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(`update download failed: ${message}`)
    setState({ status: 'error', percent: null, message: describeError(message) })
  }
  return state
}

/**
 * Quit and install. Does not return — the app is replaced and relaunched.
 *
 * `isSilent` false so the user sees the installer on Windows; `isForceRunAfter`
 * so they land back in a running Murmur rather than a closed one.
 */
export function installUpdate(): void {
  if (state.status !== 'downloaded') return
  log.info('installing update and restarting')
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}

/** A 404 from the releases feed means nothing is published, not a failure. */
function notFound(message: string): boolean {
  return message.includes('404') || message.toLowerCase().includes('no published versions')
}

function describeError(message: string): string {
  if (notFound(message)) return 'No release has been published yet.'
  if (message.toLowerCase().includes('net::') || message.toLowerCase().includes('enotfound')) {
    return 'Could not reach GitHub. Check your connection and try again.'
  }
  return message
}

export { RELEASES_PAGE }
