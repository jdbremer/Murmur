import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The update flow (PLAN §10.2).
 *
 * Two things carry real risk. `openReleasePage` feeds a string to
 * `shell.openExternal`, which is an arbitrary-URL-open primitive if the
 * renderer can choose it. And the state machine decides whether the user is
 * shown "up to date" — a claim that must never be made on a failure, because
 * silently stranding someone on an old build is the one outcome an update
 * feature exists to prevent.
 *
 * The network itself belongs to electron-updater and is not re-tested here;
 * what is tested is everything we decide on top of it.
 */

const emitters = new Map<string, (payload?: unknown) => void>()
const autoUpdater = {
  autoDownload: true,
  autoInstallOnAppQuit: true,
  logger: undefined as unknown,
  on: (event: string, cb: (payload?: unknown) => void) => emitters.set(event, cb),
  checkForUpdates: vi.fn(async () => ({})),
  downloadUpdate: vi.fn(async () => []),
  quitAndInstall: vi.fn(),
}

vi.mock('electron', () => ({
  app: { getVersion: () => '0.1.1', isPackaged: true },
}))
vi.mock('electron-updater', () => ({ default: { autoUpdater } }))

const {
  CHECK_INTERVAL_MS,
  checkForUpdate,
  compareVersions,
  initUpdates,
  isCheckDue,
  isUpdateReleaseUrl,
  updateState,
} = await import('../src/main/updates')

function emit(event: string, payload?: unknown): void {
  const cb = emitters.get(event)
  if (!cb) throw new Error(`nothing listening for "${event}"`)
  cb(payload)
}

describe('compareVersions', () => {
  it('orders by numeric component, not lexically', () => {
    // The lexical trap: "0.10.0" < "0.9.0" as strings.
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0)
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0)
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

describe('the update state machine', () => {
  let seen: string[]

  beforeEach(() => {
    seen = []
    autoUpdater.checkForUpdates.mockClear()
    autoUpdater.downloadUpdate.mockClear()
    initUpdates((s) => seen.push(s.status))
  })

  it('keeps the library flags off so the settings decide, not electron-updater', () => {
    // `autoDownload` false does *not* mean downloads never happen
    // automatically — they do, when `settings.updates.autoDownload` is on. It
    // means the library must not start one inside `checkForUpdates`, before
    // this module can consult the setting at all.
    expect(autoUpdater.autoDownload).toBe(false)
    // And never swap the app out at quit: the user pressed Restart, or nothing
    // happens.
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('reports an available update with its version', async () => {
    await checkForUpdate()
    emit('update-available', { version: '0.2.0' })
    expect(updateState().status).toBe('available')
    expect(updateState().latestVersion).toBe('0.2.0')
    expect(seen).toContain('checking')
  })

  it('tracks download progress and then readiness', async () => {
    await checkForUpdate()
    emit('update-available', { version: '0.2.0' })
    emit('download-progress', { percent: 42.7 })
    expect(updateState().status).toBe('downloading')
    expect(updateState().percent).toBe(43)

    emit('update-downloaded', { version: '0.2.0' })
    expect(updateState().status).toBe('downloaded')
    expect(updateState().percent).toBe(100)
  })

  it('reports current when nothing is newer', async () => {
    await checkForUpdate()
    emit('update-not-available')
    expect(updateState().status).toBe('current')
  })

  it('distinguishes "nothing published" from a real failure', async () => {
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('HttpError: 404 Not Found'))
    await checkForUpdate()
    // A repo with no published release must not be reported as confirmation
    // that the running build is newest.
    expect(updateState().status).toBe('none')
  })

  it('surfaces a network failure as an error, never as up to date', async () => {
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED'))
    await checkForUpdate()
    expect(updateState().status).toBe('error')
    expect(updateState().message).toBeTruthy()
    expect(seen).not.toContain('current')
  })

  it('surfaces an updater error event', async () => {
    await checkForUpdate()
    emit('error', new Error('code signature did not match'))
    expect(updateState().status).toBe('error')
    expect(updateState().message).toContain('signature')
  })
})

describe('isCheckDue', () => {
  const on = { checkAutomatically: true, autoDownload: true }
  const off = { checkAutomatically: false, autoDownload: true }

  it('never checks when the setting is off', () => {
    // "Off" has to mean no request at all, not a request whose result is
    // ignored — the whole point of the switch is the traffic.
    expect(isCheckDue(off, 0, Date.now())).toBe(false)
    expect(isCheckDue(off, 1, Date.now() + CHECK_INTERVAL_MS * 10)).toBe(false)
  })

  it('checks once at launch, having never checked', () => {
    expect(isCheckDue(on, 0, 1_000)).toBe(true)
  })

  it('waits out the interval before checking again', () => {
    const now = 10_000_000
    expect(isCheckDue(on, now, now)).toBe(false)
    expect(isCheckDue(on, now, now + CHECK_INTERVAL_MS - 1)).toBe(false)
    expect(isCheckDue(on, now, now + CHECK_INTERVAL_MS)).toBe(true)
  })

  it('checks on the next tick after a long sleep rather than missing the window', () => {
    // The timer polls every 15 minutes; a machine asleep for two days must not
    // have to wait another full interval on waking.
    const now = 10_000_000
    expect(isCheckDue(on, now, now + 48 * 3_600_000)).toBe(true)
  })
})
