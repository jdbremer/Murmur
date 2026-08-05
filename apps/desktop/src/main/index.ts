import { app, ipcMain } from 'electron'

import {
  createMainIpc,
  MOMENTARY_HOLD_MS,
  type DictationEvent,
  type EnginesStatus,
  type Settings,
} from '@murmur/shared'

import { CaptureController } from './audio/controller'
import { AUDIO } from './config'
import { EscapeCancel } from './dictation/escape'
import { HotkeyBridge } from './dictation/hotkey'
import { TextInjector } from './dictation/injector'
import { DictationOrchestrator } from './dictation/orchestrator'
import { DictationStateMachine } from './dictation/state-machine'
import { EngineCoordinator } from './engines/coordinator'
import { registerIpcHandlers } from './ipc/register'
import { createLogger } from './logging'
import { loadCatalog } from './models/catalog'
import { ModelManager } from './models/manager'
import { describeNative, native } from './native'
import { installSecurityPolicies } from './security'
import { databasePath, openDatabase } from './store/db'
import {
  DictationsRepository,
  DictionaryRepository,
  StyleRepository,
  applyReplacements,
} from './store/repositories'
import { SettingsStore } from './store/settings-store'
import { TrayController } from './tray'
import { WindowManager } from './windows/manager'

/**
 * Composition root (PLAN §3.1).
 *
 * Builds every subsystem in dependency order, wires the fan-out (settings and
 * dictation events → every window; engine status → the Hub), and owns the two
 * things nothing else can: the hot-apply reaction to a settings change, and an
 * orderly shutdown that leaves no orphaned sidecars.
 *
 * Read it top to bottom and you have the whole app's shape.
 */

const log = createLogger('app')
const isDev = !app.isPackaged

// The workspace package is called `@murmur/desktop`, which Electron would
// otherwise use for the user-data directory. Name it before anything reads
// `app.getPath('userData')`, so dev and packaged builds share one location:
// `~/Library/Application Support/Murmur` (PLAN §9).
app.setName('Murmur')

// Single instance: a second launch focuses the running app's Hub instead of
// starting a rival tray icon, event tap and set of sidecars.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void bootstrap()
}

async function bootstrap(): Promise<void> {
  const windows = new WindowManager()
  const machine = new DictationStateMachine()

  let quitting = false
  const quit = (): void => {
    quitting = true
    app.quit()
  }

  app.on('second-instance', () => windows.showHub())

  await app.whenReady()

  // Before any window exists, so every renderer is covered from its first load.
  installSecurityPolicies(isDev)

  const userDataPath = app.getPath('userData')
  const settings = SettingsStore.inUserData(userDataPath)
  const catalog = loadCatalog(app.getAppPath(), process.resourcesPath)

  log.info(`${app.getName()} ${app.getVersion()} on ${process.platform}`)
  log.info(describeNative())

  // -- persistence ---------------------------------------------------------
  const database = openDatabase(databasePath(userDataPath))
  if (database.recoveredFrom) {
    log.warn(`history database was unusable; the old file is at ${database.recoveredFrom}`)
  }
  const dictations = new DictationsRepository(database.db)
  const dictionary = new DictionaryRepository(database.db)
  const style = new StyleRepository(database.db)

  // Retention sweep at boot (PLAN §9). Cheap, and it means a user who lowers
  // the window sees it take effect without waiting for a background job.
  applyHistoryRetention()

  // -- models + engines ----------------------------------------------------
  const models = new ModelManager({
    userDataPath,
    catalog: catalog.catalog,
    catalogError: catalog.error,
  })

  const engines = new EngineCoordinator({
    models,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    hostDirectory: __dirname,
    dictionary: () => dictionary.enabled().map((entry) => entry.term),
  })

  // -- windows + IPC -------------------------------------------------------
  windows.start()
  const injector = new TextInjector({ native })

  // The typed IPC surface is created here rather than inside
  // `registerIpcHandlers`, because subsystems built below need to *emit* on it
  // before any handler is registered.
  const ipc = createMainIpc(ipcMain)

  const audio = new CaptureController({
    ipc,
    target: () => {
      const window = windows.audio()
      return window.isDestroyed() ? null : window.webContents
    },
  })

  const orchestrator = new DictationOrchestrator({
    machine,
    stt: () => engines.stt(),
    polish: () => engines.polish(),
    injector,
    audio,
    settings: () => {
      const current = settings.get()
      return {
        language: current.language,
        polishingLevel: current.polishingLevel,
        sttModelId: current.sttModelId,
        polishModelId: current.polishModelId,
        micDeviceId: current.micDeviceId,
      }
    },
    dictionary: () => dictionary.enabled(),
    // Post-STT replacement rules run before polishing, so the polish prompt
    // sees — and preserves — the corrected spelling (PLAN §6.4).
    applyDictionary: (text) => applyReplacements(text, dictionary.enabled()),
    styleFor: (category) => style.forCategory(category),
    frontmostApp: () => native().getFrontmostApp(),
    persist: (record) => {
      dictations.insert(record)
    },
    // No `onLevel`: the Bar's waveform is fed by the capture renderer's ~30 Hz
    // `audio.meter` messages (relayed as `audio.level` in the IPC registry).
    // Deriving it from the ~100 ms PCM frames instead would meter at 10 Hz and
    // make the bars step rather than dance (PLAN §2.1).
  })

  const hotkeys = new HotkeyBridge({
    native,
    intents: {
      begin: () => orchestrator.begin(),
      end: () => orchestrator.end(),
      toggleHandsFree: () => {
        if (orchestrator.handsFree) orchestrator.stopHandsFree()
        else orchestrator.startHandsFree()
      },
    },
  })

  registerIpcHandlers({
    ipc,
    windows,
    settings,
    machine,
    orchestrator,
    engines,
    models,
    hotkeys,
    dictations,
    dictionary,
    style,
    isDev,
    quit,
  })

  // -- tray ----------------------------------------------------------------
  let paused = false
  const tray = new TrayController({
    openHub: () => windows.showHub(),
    setPaused: (next) => {
      paused = next
      if (paused) {
        // Pausing must stop the tap *and* abandon anything in flight, or a
        // half-finished utterance would insert itself after the user paused.
        hotkeys.stop()
        orchestrator.cancel()
        audio.release()
      } else {
        hotkeys.start(settings.get().hotkey)
      }
      log.info(paused ? 'paused' : 'resumed')
    },
    isPaused: () => paused,
    quit,
  })
  tray.start()

  // -- fan-out -------------------------------------------------------------

  settings.on('changed', (next: Settings) => {
    ipc.broadcast(windows.allWebContents(), 'settings.changed', next)
    applyBarVisibility(next, machine.getState())
    hotApply(next)
  })

  machine.on('event', (event: DictationEvent) => {
    ipc.broadcast(windows.uiWebContents(), 'dictation.state', event)
    applyBarVisibility(settings.get(), event)
  })

  // Esc cancels while listening, and only while listening (PLAN §2.1).
  const escape = new EscapeCancel({ cancel: () => orchestrator.cancel() })
  machine.on('state', (next) => {
    if (next === 'listening') escape.arm()
    else escape.disarm()
  })

  engines.on('status', (status: EnginesStatus) => {
    ipc.broadcast(windows.uiWebContents(), 'engines.changed', status)
  })

  models.on('progress', (progress) => {
    ipc.broadcast(windows.uiWebContents(), 'models.downloadProgress', progress)
    // A finished download may be the model that was selected but missing.
    if (progress.status === 'complete') void engines.apply(settings.get())
  })

  /** PLAN §2.1: show while dictating (default) · always · hidden. */
  let barHideTimer: NodeJS.Timeout | null = null
  function applyBarVisibility(current: Settings, event: DictationEvent): void {
    if (barHideTimer) {
      clearTimeout(barHideTimer)
      barHideTimer = null
    }
    switch (current.barVisibility) {
      case 'always':
        windows.showBar()
        return
      case 'hidden':
        windows.hideBar()
        return
      case 'showWhileDictating': {
        if (event.state === 'idle') {
          windows.hideBar()
          return
        }
        windows.showBar()
        // `inserted` and `error` are the last events of their dictation: the
        // machine settles to idle *silently* (RESTING_STATE moves; nothing is
        // emitted), so no idle event will ever hide the window. Retire it
        // ourselves once the renderer's hold — plus the shrink morph — has
        // played out. Any newer event cancels this via the clear above.
        const hold =
          event.state === 'inserted'
            ? MOMENTARY_HOLD_MS.inserted
            : event.state === 'error'
              ? MOMENTARY_HOLD_MS.error
              : 0
        if (hold > 0) {
          barHideTimer = setTimeout(() => {
            barHideTimer = null
            if (settings.get().barVisibility === 'showWhileDictating') windows.hideBar()
          }, hold + 250)
          barHideTimer.unref?.()
        }
        return
      }
    }
  }

  /**
   * Settings changes take effect immediately — no restart, no "apply" button
   * (PLAN §13 M2 acceptance).
   */
  let lastSettings = settings.get()
  function hotApply(next: Settings): void {
    const previous = lastSettings
    lastSettings = next

    if (!paused && hotkeyChanged(previous, next)) hotkeys.rebind(next.hotkey)
    if (previous.micDeviceId !== next.micDeviceId) audio.setDevice(next.micDeviceId)
    if (previous.launchAtLogin !== next.launchAtLogin) applyLaunchAtLogin(next)
    if (
      previous.sttModelId !== next.sttModelId ||
      previous.polishModelId !== next.polishModelId ||
      previous.polishingLevel !== next.polishingLevel ||
      previous.language !== next.language ||
      JSON.stringify(previous.externalEndpoint) !== JSON.stringify(next.externalEndpoint)
    ) {
      void engines.apply(next)
    }
    if (
      previous.historyRetention.mode !== next.historyRetention.mode ||
      (next.historyRetention.mode === 'days' &&
        previous.historyRetention.mode === 'days' &&
        previous.historyRetention.days !== next.historyRetention.days)
    ) {
      applyHistoryRetention()
    }
  }

  function applyLaunchAtLogin(current: Settings): void {
    // Only macOS and Windows implement this; Linux dev builds no-op.
    if (process.platform !== 'darwin' && process.platform !== 'win32') return
    app.setLoginItemSettings({ openAtLogin: current.launchAtLogin, openAsHidden: true })
  }

  function applyHistoryRetention(): void {
    const retention = settings.get().historyRetention
    if (retention.mode !== 'days') return
    const cutoff = Date.now() - retention.days * 86_400_000
    const removed = dictations.pruneOlderThan(cutoff)
    if (removed > 0) log.info(`pruned ${removed} history rows older than ${retention.days} days`)
  }

  // -- start ---------------------------------------------------------------

  applyBarVisibility(settings.get(), machine.getState())
  applyLaunchAtLogin(settings.get())
  hotkeys.start(settings.get().hotkey)
  await engines.apply(settings.get())

  // Warm the mic so the first dictation does not pay `getUserMedia`'s
  // cold-start cost; it is released again after AUDIO.warmIdleMs (PLAN §5).
  if (AUDIO.warmIdleMs > 0) audio.warm(settings.get().micDeviceId)

  windows.showHub()

  // -- lifecycle -----------------------------------------------------------

  app.on('activate', () => {
    // macOS: clicking the Dock icon reopens the Hub.
    if (!quitting) windows.showHub()
  })

  app.on('window-all-closed', () => {
    // Deliberately empty. Electron's default is to quit here on non-macOS;
    // Murmur lives in the menu bar (PLAN §2.3), so closing the Hub must not end
    // the session. Quitting goes through the tray menu or ⌘Q.
  })

  let shuttingDown = false
  app.on('before-quit', (event) => {
    if (shuttingDown) return
    shuttingDown = true
    quitting = true

    // Sidecars and the utility process need an async teardown, and Electron
    // will not wait for one — so hold the quit, clean up, then quit again.
    event.preventDefault()
    void shutdown().finally(() => {
      app.exit(0)
    })
  })

  async function shutdown(): Promise<void> {
    log.info('shutting down')
    tray.destroy()
    escape.dispose()
    hotkeys.stop()
    orchestrator.dispose()
    injector.dispose()
    audio.dispose()
    models.cancelAll()
    // Engines last: they own the child processes that must not be orphaned.
    await engines.dispose().catch((error: unknown) => log.error('engine teardown failed:', error))
    try {
      database.db.close()
    } catch (error) {
      log.warn('closing the database failed:', error)
    }
  }
}

function hotkeyChanged(previous: Settings, next: Settings): boolean {
  return (
    previous.hotkey.key !== next.hotkey.key ||
    previous.hotkey.customKeyCode !== next.hotkey.customKeyCode ||
    previous.hotkey.activation !== next.hotkey.activation ||
    previous.hotkey.doubleTapHandsFree !== next.hotkey.doubleTapHandsFree
  )
}
