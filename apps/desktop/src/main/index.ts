import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { app, ipcMain, Menu, nativeTheme, Notification, powerMonitor } from 'electron'

import {
  createMainIpc,
  MOMENTARY_HOLD_MS,
  sanitizeHotkeyForPlatform,
  type DictationEvent,
  type EnginesStatus,
  type Settings,
} from '@murmur/shared'

import { CaptureController } from './audio/controller'
import { AUDIO } from './config'
import { EscapeCancel } from './dictation/escape'
import { HotkeyBridge } from './dictation/hotkey'
import { TextInjector } from './dictation/injector'
import { CodeContextReader, ideForBundleId, supportsFileTagging } from './dictation/code-context'
import { DictationOrchestrator } from './dictation/orchestrator'
import { DictationStateMachine } from './dictation/state-machine'
import { EngineCoordinator } from './engines/coordinator'
import { registerIpcHandlers } from './ipc/register'
import { AskService } from './ask/service'
import { RetrievalRepository } from './store/retrieval'
import { createLogger } from './logging'
import { loadCatalog } from './models/catalog'
import { ModelManager } from './models/manager'
import { describeNative, native } from './native'
import { installSecurityPolicies } from './security'
import { databasePath, openDatabase } from './store/db'
import {
  AskRepository,
  DictationsRepository,
  DictionaryRepository,
  NotesRepository,
  SnippetsRepository,
  MeetingsRepository,
  StyleRepository,
  applyReplacementsWithCount,
} from './store/repositories'
import { FrameBus } from './audio/frame-bus'
import {
  NativeSystemAudio,
  UnsupportedSystemAudio,
  systemAudioBinary,
  type SystemAudioSource,
} from './audio/system-capture'
import { LoopbackSystemAudio } from './audio/loopback-capture'
import { MeetingRecorder } from './meeting/recorder'
import { FileTranscriber } from './transcription/file-transcriber'
import { startAutoUpdates, stopAutoUpdates } from './updates'
import { MeetingWatcher, listAudioProcessesVia } from './meeting/watcher'
import { TranscribeQueue } from './engines/stt-queue'
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
// Unpackaged only, deliberately: the agent profile auto-approves the
// microphone and relocates userData to a fixed, world-readable temp path.
// A packaged build must never honour an environment variable that turns those
// on — a login item or `launchctl setenv` would be enough to arm it.
const isAgent = isDev && process.env['MURMUR_AGENT'] === '1'

// The workspace package is called `@murmur/desktop`, which Electron would
// otherwise use for the user-data directory. Name it before anything reads
// `app.getPath('userData')`, so dev and packaged builds share one location:
// `~/Library/Application Support/Murmur` (PLAN §9).
app.setName('Murmur')

// Agent loop: isolate userData so unattended runs never fight a human session,
// and optionally feed Chromium a fake media device / WAV as the "mic".
// Switches must be set before ready (Chromium command line).
if (isAgent) {
  app.setPath('userData', join(tmpdir(), 'murmur-agent-userdata'))
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  const fakeAudio = process.env['MURMUR_AGENT_FAKE_AUDIO']
  if (fakeAudio) {
    app.commandLine.appendSwitch('use-fake-device-for-media-stream')
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fakeAudio)
  }
}

// Single instance: a second launch focuses the running app's Hub instead of
// starting a rival tray icon, event tap and set of sidecars.
// Agent runs use a separate userData but still take the lock within that profile.
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

  // macOS ships as an LSUIElement (menu-bar) app: no Dock icon means no
  // default menu bar, and without an application menu an accessory app loses
  // ⌘Q *and* the Edit shortcuts (⌘C/⌘V/⌘A) inside the Hub. Install a real one.
  // Windows/Linux keep Electron's default in dev and drop the stock File/View
  // menu bar in packaged builds, where it is pure noise on the Hub window.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]),
    )
    // Unpackaged runs otherwise show Electron's own Dock icon; packaged builds
    // get theirs from the bundle.
    if (isDev) {
      const devIcon = join(app.getAppPath(), 'buildResources', 'icon.png')
      try {
        app.dock?.setIcon(devIcon)
      } catch {
        /* purely cosmetic in dev */
      }
    }
  } else if (!isDev) {
    Menu.setApplicationMenu(null)
  }

  // Before any window exists, so every renderer is covered from its first load.
  installSecurityPolicies(isDev)

  /**
   * Point Electron's native theme at the user's Appearance choice.
   *
   * The renderers already honour it through `data-theme`, but `nativeTheme` is
   * what decides everything drawn *outside* the page: the window's own
   * background colour behind and around the web contents, native scrollbars,
   * and the system dialogs. Leaving it on `system` while the user had chosen
   * Dark meant a light window frame around a dark app.
   */
  function applyAppearance(current: Settings): void {
    nativeTheme.themeSource = current.appearance
  }

  const userDataPath = app.getPath('userData')
  const settings = SettingsStore.inUserData(userDataPath)
  // Heal hotkey config so native never throws at boot (custom without a code,
  // or a Mac-only preset on Windows). Schema still accepts those shapes.
  {
    const current = settings.get()
    const healed = sanitizeHotkeyForPlatform(current.hotkey, process.platform)
    if (
      healed.key !== current.hotkey.key ||
      healed.customKeyCode !== current.hotkey.customKeyCode
    ) {
      settings.set({ hotkey: healed })
      log.info(
        `hotkey healed: ${current.hotkey.key}/${current.hotkey.customKeyCode} → ${healed.key}`,
      )
    }
  }
  const catalog = loadCatalog(app.getAppPath(), process.resourcesPath)

  log.info(`${app.getName()} ${app.getVersion()} on ${process.platform}`)
  log.info(describeNative())

  // -- persistence ---------------------------------------------------------
  const database = openDatabase(databasePath(userDataPath))
  if (database.recoveredFrom) {
    log.warn(`history database was unusable; the old file is at ${database.recoveredFrom}`)
  }
  /**
   * Vibe coding's editor read (PLAN §18.3).
   *
   * Constructed unconditionally, like the meeting recorder, and for the same
   * reason: building it starts nothing. Every gate — the setting, the IDE
   * allowlist, the native call's own refusals — lives inside `read()`, which
   * returns nothing at all until the user has opted in.
   */
  const codeContext = new CodeContextReader({
    native,
    settings: () => settings.get().vibeCoding,
  })

  const dictations = new DictationsRepository(database.db)
  const dictionary = new DictionaryRepository(database.db)
  const snippets = new SnippetsRepository(database.db)
  const notes = new NotesRepository(database.db)
  const style = new StyleRepository(database.db)
  const meetingStore = new MeetingsRepository(database.db)
  const askStore = new AskRepository(database.db)
  const retrieval = new RetrievalRepository(database.db)

  // Retention sweep at boot (PLAN §9). Cheap, and it means a user who lowers
  // the window sees it take effect without waiting for a background job.
  applyHistoryRetention()

  // Before the Hub exists, so its very first frame is painted in the right
  // theme rather than corrected a moment later.
  applyAppearance(settings.get())

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
    userDataPath: app.getPath('userData'),
    hostDirectory: __dirname,
    dictionary: () => dictionary.enabled().map((entry) => entry.term),
  })

  // -- windows + IPC -------------------------------------------------------
  // The layout is read as a function, not a value: the Bar window is placed
  // again on every show and on every display change, and by then the user may
  // have moved it from the bottom-centre pill to a corner orb.
  windows.start(() => ({
    style: settings.get().barStyle,
    corner: settings.get().barCorner,
  }))
  const injector = new TextInjector({ native })

  // The typed IPC surface is created here rather than inside
  // `registerIpcHandlers`, because subsystems built below need to *emit* on it
  // before any handler is registered.
  const ipc = createMainIpc(ipcMain)

  // Ask (PLAN §2.2.9). Built here rather than in `registerIpcHandlers` because
  // it emits on `ask.event` from its own async loop, long after the handler
  // that started it has returned.
  const ask = new AskService({
    retrieval,
    store: askStore,
    // Read through the coordinator on every call rather than captured once: the
    // polish engine is disposed and rebuilt whenever the model or endpoint
    // changes, and a captured reference would keep answering into a dead
    // sidecar.
    engine: () => engines.polish(),
    emit: (event) => ipc.broadcast(windows.uiWebContents(), 'ask.event', event),
  })

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
    applyDictionary: (text) => applyReplacementsWithCount(text, dictionary.enabled()),
    // Read per utterance, not captured once: a snippet added in the Hub should
    // work on the next dictation without a restart.
    snippets: () => snippets.enabled(),
    styleFor: (category) => style.forCategory(category),
    frontmostApp: () => native().getFrontmostApp(),
    codeContext: (bundleId) => codeContext.read(bundleId),
    fileTagging: (bundleId) => {
      const vibe = settings.get().vibeCoding
      const ide = ideForBundleId(bundleId)
      return {
        // Tagging needs the editor read to supply the real filenames, so it
        // cannot run on its own — a rewrite against a guessed file list would
        // put broken references in the user's message.
        enabled: ide !== null && vibe.fileTagging && vibe.variableRecognition,
        // Only Cursor and Windsurf understand `@file`; VS Code gets the real
        // filename with no prefix, which is still an improvement on "index dot
        // ts" but is not a chat attachment.
        at: ide !== null && supportsFileTagging(ide),
      }
    },
    // Command mode (PLAN §18.1): a non-empty selection at hotkey-down flips
    // the utterance into an edit instruction. Gated on the setting and read
    // through AX, which is already granted for insertion.
    selection: () => {
      if (!settings.get().commandModeEnabled) return null
      const result = native().getSelectedText()
      if (!result.ok) return null
      const text = (result.text ?? '').trim()
      if (text.length === 0) return null
      // A selection this large cannot be edited within the polish model's
      // context window — the result would be refused as truncated every time.
      // Treat it as plain dictation instead of a guaranteed failure.
      if (text.length > 6_000) return null
      return text
    },
    // A handful of characters before the cursor, so text dictated into the
    // middle of a sentence does not arrive capitalised. Much narrower than the
    // selection read above — the user did not select this — so it is bounded
    // hard, never logged, and only ever reaches the pure decision in
    // sentence-case.ts. `ok: false` means unknown, which leaves text untouched.
    textBeforeCursor: () => {
      const result = native().getTextBeforeCursor(8)
      return result.ok ? (result.text ?? '') : null
    },
    persist: (record, fixes) => {
      dictations.insert(record, {
        fixes,
        // Read per dictation, not captured at boot: turning the switch off in
        // Settings must stop the next dictation being tallied, not the next
        // launch. Only the per-app breakdown is gated — the word, streak and
        // fix counters are the lifetime totals Murmur has always kept.
        collectAppUsage: settings.get().insightsEnabled,
      })
    },
    // No `onLevel` from PCM frames: the Bar is fed by the capture renderer's
    // ~30 Hz `audio.meter` → `audio.level` relay (PLAN §2.1).
    // Through the bridge, not straight to native: the bridge has to forget the
    // in-progress press too, or it swallows the user's next one.
    releaseHotkeyLatch: () => {
      hotkeys.releaseLatch()
    },
  })

  // -- meetings (PLAN §18.2) -----------------------------------------------
  // Built even when the feature is off: constructing a recorder starts no
  // timers, spawns no subprocess and takes no lease. Everything it can do is
  // gated behind `settings.meetings.enabled`, which is false by default.

  const frames = new FrameBus()

  const tapBinary = systemAudioBinary(
    isDev ? join(app.getAppPath(), 'resources') : process.resourcesPath,
  )
  const loopbackAudio =
    process.platform === 'win32'
      ? new LoopbackSystemAudio({
          ipc,
          target: () => {
            const window = windows.audio()
            return window.isDestroyed() ? null : window.webContents
          },
        })
      : null

  const systemAudio: SystemAudioSource =
    process.platform === 'darwin'
      ? new NativeSystemAudio({
          binary: tapBinary,
          statusPath: join(userDataPath, 'system-audio-permission'),
        })
      : (loopbackAudio ??
        new UnsupportedSystemAudio(
          'Capturing other participants needs macOS 14.2 or Windows; meetings record your microphone.',
        ))

  // One queue in front of the engine. Not an optimisation: whisper-server
  // serialises internally and the ONNX host does not serialise at all, so
  // overlapping calls are a correctness problem, not just a slow one.
  // `listening` is the important one: it starts at hotkey-*down*, seconds
  // before the transcription request actually arrives, which is exactly the
  // warning the queue needs to stop handing the engine meeting work.
  // `inserted` and `error` are terminal display states — holding background
  // work for those would stall the queue until the next dictation.
  const sttQueue = new TranscribeQueue({
    isBusy: () => {
      const state = machine.getState().state
      return state === 'listening' || state === 'processing' || state === 'inserting'
    },
  })

  // File transcription (PLAN §18.4) shares the queue at background priority,
  // so a dropped audiobook and a live meeting obey the same rule: neither may
  // ever add a millisecond to a dictation.
  const transcriber = new FileTranscriber({
    queue: sttQueue,
    stt: () => engines.stt(),
    settings: () => settings.get(),
    dictionary: () => dictionary.enabled().map((entry) => entry.term),
  })

  const meetingsFolder = join(app.getPath('documents'), 'Murmur Meetings')

  const meetings = new MeetingRecorder({
    capture: audio,
    frames,
    systemAudio,
    queue: sttQueue,
    stt: () => engines.stt(),
    settings: () => settings.get(),
    defaultFolder: meetingsFolder,
    persist: (record) => {
      meetingStore.save(record)
    },
  })

  const watcher = new MeetingWatcher({
    recorder: meetings,
    settings: () => settings.get(),
    listProcesses: listAudioProcessesVia(tapBinary),
  })

  const hotkeys = new HotkeyBridge({
    native,
    intents: {
      begin: () => orchestrator.begin(),
      end: (options) => orchestrator.end(options),
      toggleHandsFree: () => {
        if (orchestrator.handsFree) orchestrator.stopHandsFree()
        else orchestrator.startHandsFree()
      },
      isHandsFree: () => orchestrator.handsFree,
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
    audio,
    injector,
    codeContext,
    dictations,
    dictionary,
    notes,
    snippets,
    style,
    frames,
    meetings,
    meetingStore,
    systemAudio,
    loopbackAudio,
    meetingsFolder,
    transcriber,
    ask,
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
    isListening: () => machine.getState().state === 'listening',
    meetings: {
      enabled: () => settings.get().meetings.enabled,
      recording: () => meetings.recording,
      start: () => {
        void meetings.start('', null).catch((error: unknown) => {
          log.error(`could not start the meeting: ${String(error)}`)
        })
      },
      stop: () => {
        void meetings.stop()
      },
    },
  })
  // The tray is the app's only permanent handle, so its absence must never be
  // silent: log where macOS actually placed it (a crowded menu bar on a
  // notched MacBook can hide it entirely), and survive if creation fails —
  // the Hub's Dock presence still offers a way to quit.
  try {
    const trayHandle = tray.start()
    log.info(`tray created at ${JSON.stringify(trayHandle.getBounds())}`)
  } catch (cause) {
    log.warn(`tray failed to start: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  // No-op unless the user has turned meeting detection on.
  watcher.sync()

  /**
   * Follow the user between displays while nothing is happening.
   *
   * The `listening` hook above covers dictation; this covers the rest of the
   * day, which is most of it now that the pill is visible by default — someone
   * who moves to their second monitor should not have to start speaking to
   * find out where the indicator went.
   *
   * Idle only, and deliberately unhurried. `followActiveDisplay` returns
   * immediately when the pill is already on the cursor's screen, so on a
   * single-monitor machine this costs two `screen` reads a second and never
   * touches a window.
   */
  const displayFollow = setInterval(() => {
    // `machine.state`, NOT `machine.getState().state`. The first is the resting
    // state; the second is the last *event*, which stays `inserted` (or
    // `error`) for the rest of the session, because those are momentary and no
    // trailing idle event ever follows them. Guarding on the event meant this
    // worked until the first successful dictation and never again — and it
    // survived review because the obvious test moves the cursor *before*
    // dictating, which is precisely the window in which the bug is invisible.
    if (machine.state !== 'idle') return
    windows.followActiveDisplay()
  }, 1_000)
  displayFollow.unref?.()

  // Look for a new release shortly after boot, then periodically. On by
  // default and switchable in Settings — see `updates.ts` and Help's Network
  // activity row, which names this as the one request nobody presses a button
  // for.
  startAutoUpdates(() => settings.get().updates)

  // Sleeping mid-meeting must not look like nobody spoke for two hours: mark
  // the break in the transcript and rebuild the tap on the way back. Nothing
  // else in the app cares about power state, which is why this is the only
  // powerMonitor use.
  powerMonitor.on('suspend', () => meetings.suspend())
  powerMonitor.on('resume', () => meetings.resume())

  // -- fan-out -------------------------------------------------------------

  settings.on('changed', (next: Settings) => {
    ipc.broadcast(windows.allWebContents(), 'settings.changed', next)
    applyBarVisibility(next, machine.getState())
    hotApply(next)
    // Turning detection off has to actually tear the timer down, not just make
    // its result unused — "off" means inert.
    watcher.sync()
    // Same for the update schedule: switching it off stops the timer now, not
    // at next launch.
    startAutoUpdates(() => settings.get().updates)
    // Same discipline for the editor read: switching vibe coding off must drop
    // what was already extracted, not merely stop extracting more.
    codeContext.forget()
  })

  // A detected meeting has to reach someone who may not have the Hub open —
  // and it must *ask*, never just start. Other people are in the room and have
  // not agreed to anything.
  let offerNotification: Notification | null = null
  const closeOffer = (): void => {
    offerNotification?.close()
    offerNotification = null
  }

  meetings.on('changed', (event) => {
    ipc.broadcast(windows.uiWebContents(), 'meeting.changed', event)
    applyBarVisibility(settings.get(), machine.getState())

    if (event.state === 'offered' && !offerNotification && Notification.isSupported()) {
      const bundleId = event.appBundleId
      const notification = new Notification({
        title: 'Record this meeting?',
        body: `Murmur can transcribe “${event.title}” as it happens.`,
        actions: [{ type: 'button', text: 'Record' }],
        closeButtonText: 'Not now',
        silent: true,
      })
      notification.on('action', () => {
        void meetings.start(event.title, bundleId).catch((error: unknown) => {
          log.error(`could not start the offered meeting: ${String(error)}`)
        })
      })
      // Dismissing is a "no": stay quiet about this app for a while rather
      // than asking again on the next poll.
      notification.on('close', () => {
        if (meetings.state().state === 'offered') {
          meetings.clearOffer()
          watcher.declined(bundleId)
        }
        offerNotification = null
      })
      notification.show()
      offerNotification = notification
    } else if (event.state !== 'offered') {
      closeOffer()
    }
    // The tray rebuilds its whole menu on refresh, and until now was only
    // refreshed by start() and the pause toggle — so a recording state would
    // never have appeared in it.
    tray.refresh()
  })

  meetings.on('completed', () => {
    watcher.declined(null)
  })

  transcriber.on('changed', (event) => {
    ipc.broadcast(windows.uiWebContents(), 'transcribe.changed', event)
  })

  machine.on('event', (event: DictationEvent) => {
    // Every window, not just the ones with pixels: the hidden capture page
    // sounds the start/stop cue off these transitions (PLAN §2.1), and it is
    // the only renderer guaranteed to still be alive when the Bar is hidden.
    ipc.broadcast(windows.allWebContents(), 'dictation.state', event)
    // A dictation beginning is the one moment the pill *must* be on the right
    // screen, and the last moment it is safe to move it: from here until the
    // text lands, the user is watching it. Before `applyBarVisibility`, so a
    // pill about to be shown is positioned before it appears rather than
    // appearing and then jumping.
    if (event.state === 'listening') windows.followActiveDisplay()
    applyBarVisibility(settings.get(), event)
  })

  // Esc cancels while listening, and only while listening (PLAN §2.1).
  const escape = new EscapeCancel({ cancel: () => orchestrator.cancel() })
  machine.on('state', (next) => {
    if (next === 'listening') escape.arm()
    else escape.disarm()
    // The menu-bar glyph leans into its listening shape. On `state` rather
    // than `event`: the latter re-fires with every level update, and this only
    // cares about the transition.
    tray.refreshIcon()
  })

  engines.on('status', (status: EnginesStatus) => {
    ipc.broadcast(windows.uiWebContents(), 'engines.changed', status)
  })

  // The Hub reads its stats when the Home section mounts, so a window left open
  // on Home while the user dictates would otherwise show the same numbers all
  // day. Recomputed from the store rather than derived from the record here:
  // the counters are the source of truth, and reading them back is a couple of
  // indexed lookups.
  orchestrator.on('completed', () => {
    try {
      ipc.broadcast(windows.uiWebContents(), 'history.changed', dictations.stats())
    } catch (error) {
      log.error('could not broadcast the updated history stats:', error)
    }
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
    // A live recording overrides every visibility preference, Hidden included.
    // The pill's red dot is the only always-visible sign that other people are
    // being recorded; letting a setting suppress it would make the app capable
    // of recording a room with no indication at all.
    if (meetings.recording) {
      windows.showBar()
      return
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

    // Sanitize here too, not just at boot: a settings.json hand-edited (or
    // written by a sync client) while the app is running would otherwise bind
    // a key this platform's backend cannot install, until the next launch.
    if (!paused && hotkeyChanged(previous, next)) {
      hotkeys.rebind(sanitizeHotkeyForPlatform(next.hotkey, process.platform))
    }
    if (previous.micDeviceId !== next.micDeviceId) audio.setDevice(next.micDeviceId)
    if (previous.launchAtLogin !== next.launchAtLogin) applyLaunchAtLogin(next)
    if (previous.appearance !== next.appearance) applyAppearance(next)
    // Style and corner move the *window*, not just what is drawn in it, so the
    // renderer changing shape is only half the switch.
    if (previous.barStyle !== next.barStyle || previous.barCorner !== next.barCorner) {
      windows.refreshBarBounds()
    }
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
    if (process.platform === 'linux') {
      applyLinuxAutostart(current.launchAtLogin)
      return
    }
    if (process.platform !== 'darwin' && process.platform !== 'win32') return
    app.setLoginItemSettings({ openAtLogin: current.launchAtLogin, openAsHidden: true })
  }

  /**
   * Linux autostart, by hand.
   *
   * Electron's `setLoginItemSettings` is a no-op on Linux, so the toggle would
   * flip and do nothing — the silent-dead-setting shape this app keeps
   * refusing to ship. The XDG spec's answer is a .desktop file in
   * `~/.config/autostart`, which every mainstream desktop honours. Failure is
   * logged and swallowed: an unwritable config dir must not take down boot.
   */
  function applyLinuxAutostart(enabled: boolean): void {
    const configHome = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config')
    const file = join(configHome, 'autostart', 'murmur.desktop')

    try {
      if (!enabled) {
        rmSync(file, { force: true })
        return
      }
      // APPIMAGE is set by the AppImage runtime and points at the .AppImage the
      // user actually launched; argv[0] there is the unpacked temp binary,
      // which is gone by the next boot.
      const exec = process.env['APPIMAGE'] || app.getPath('exe')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(
        file,
        [
          '[Desktop Entry]',
          'Type=Application',
          'Name=Murmur',
          `Exec=${exec}`,
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          '',
        ].join('\n'),
        'utf8',
      )
    } catch (error) {
      log.warn('could not update the Linux autostart entry:', error)
    }
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
  // Clear any stuck Space latch from a previous crash / bad chord session.
  hotkeys.releaseLatch()
  await engines.apply(settings.get())

  // Warm the mic so the first dictation does not pay `getUserMedia`'s
  // cold-start cost; it is released again after AUDIO.warmIdleMs (PLAN §5).
  if (AUDIO.warmIdleMs > 0) audio.warm(settings.get().micDeviceId)

  windows.showHub()

  // -- lifecycle -----------------------------------------------------------

  app.on('activate', () => {
    if (quitting) return
    /*
     * macOS: clicking the Dock icon reopens the Hub — but *only* when there is
     * nothing already open to come back to.
     *
     * This used to call `showHub()` unconditionally, and `showHub()` ends in
     * `show()` + `focus()`. Focusing a window is how you ask macOS to take the
     * user to whichever Space and display that window lives on, so any
     * activation at all — not just a deliberate Dock click — could yank
     * someone off the screen they had just moved to and dump them in front of
     * the Hub. Activation happens for plenty of reasons that are not "please
     * show me your window".
     */
    if (windows.hubIsOpen()) return
    windows.showHub()
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
    clearInterval(displayFollow)
    stopAutoUpdates()
    escape.dispose()
    hotkeys.stop()
    // Before the engines: a meeting in progress has to finish transcribing
    // what it already captured and close its file. Tearing the engines down
    // first would strand the last minute of a recording the user thought was
    // being saved.
    watcher.dispose()
    await meetings.dispose().catch((error: unknown) => log.error('meeting teardown failed:', error))
    await transcriber
      .dispose()
      .catch((error: unknown) => log.error('transcriber teardown failed:', error))
    sttQueue.clear('Murmur is shutting down')
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
