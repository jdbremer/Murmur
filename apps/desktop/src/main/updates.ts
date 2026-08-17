import { app } from 'electron'
import electronUpdater from 'electron-updater'

import type { UpdateSettings, UpdateState } from '@murmur/shared'

import { createLogger } from './logging'

/**
 * Updates (PLAN §10.2) — automatic by default, and disclosed because of it.
 *
 * This used to be strictly user-pressed, on the grounds that a background poll
 * tells GitHub this machine's IP, its version and roughly when it is awake, on
 * a cadence nobody agreed to. That reasoning was sound and the conclusion was
 * still wrong for a shipped product: the people most likely to sit three
 * versions behind are exactly the ones who never open Help to press a button,
 * and every fix reaches them through this path.
 *
 * So it now checks on launch and every {@link CHECK_INTERVAL_MS}, and fetches
 * the installer as soon as it finds one. What keeps that honest is not the
 * absence of traffic but its description: `settings.updates` carries a switch
 * for each half, Help's Network activity row names this as the one thing that
 * happens without being asked in the moment, and both defaults are stated
 * there rather than discovered.
 *
 * The two switches are separate because the consents are: finding out a
 * release exists is one HTTPS request for a small YAML feed, and fetching it
 * is ~190 MB, which is a different proposition on a tethered phone.
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

  // Left off at the library level even when the *setting* is on, so the
  // decision stays here where the setting can be read. electron-updater's own
  // autoDownload would fire inside `checkForUpdates` before this module could
  // consult anything.
  autoUpdater.autoDownload = false
  // Never swap the app out from under someone at quit: they pressed Restart or
  // they did not.
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = null

  autoUpdater.on('update-available', (info) => {
    log.info(`update available: ${info.version}`)
    setState({ status: 'available', latestVersion: info.version, percent: null })
    // The second half of "all the user has to do is install".
    if (wantsAutoDownload()) void downloadUpdate()
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

// ---------------------------------------------------------------------------
// Automatic checking
// ---------------------------------------------------------------------------

/** How often a long-running Murmur looks again. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000
/**
 * Grace period after launch before the first check.
 *
 * Boot is the busiest moment this process has — engines loading, the model
 * catalog validating, the window painting — and an update check is the least
 * urgent thing in it. Twenty seconds keeps it off that critical path without
 * being long enough for anyone to close the app first.
 */
export const FIRST_CHECK_DELAY_MS = 20_000

let timer: NodeJS.Timeout | null = null
let lastCheckAt = 0
let readSettings: (() => UpdateSettings) | null = null

function wantsAutoDownload(): boolean {
  const settings = readSettings?.()
  return settings ? settings.checkAutomatically && settings.autoDownload : false
}

/**
 * Whether a check should run now.
 *
 * Pure, and exported for the tests: this is the whole of the scheduling policy
 * and it is much easier to assert on than a timer. `lastAt` of 0 means "never
 * checked", which is always due.
 */
export function isCheckDue(
  settings: UpdateSettings,
  lastAt: number,
  now: number,
  interval = CHECK_INTERVAL_MS,
): boolean {
  if (!settings.checkAutomatically) return false
  if (lastAt === 0) return true
  return now - lastAt >= interval
}

/**
 * Start the background schedule.
 *
 * Re-callable: `settings.changed` runs it again, which is what makes toggling
 * the switch take effect immediately rather than at next launch. Reads the
 * settings through a getter rather than a snapshot for the same reason.
 */
export function startAutoUpdates(getSettings: () => UpdateSettings): void {
  readSettings = getSettings
  stopAutoUpdates()

  if (!getSettings().checkAutomatically) {
    log.info('automatic update checks are off')
    return
  }
  if (!isSelfUpdateSupported().ok) return

  const tick = (): void => {
    if (!readSettings) return
    if (!isCheckDue(readSettings(), lastCheckAt, Date.now())) return
    lastCheckAt = Date.now()
    void checkForUpdate()
  }

  const first = setTimeout(tick, FIRST_CHECK_DELAY_MS)
  first.unref?.()
  // Polled rather than scheduled exactly, so a machine that slept through its
  // window checks on the next tick instead of waiting another six hours.
  timer = setInterval(tick, 15 * 60_000)
  timer.unref?.()
}

export function stopAutoUpdates(): void {
  if (timer) clearInterval(timer)
  timer = null
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
