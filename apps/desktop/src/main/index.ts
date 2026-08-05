import { app } from 'electron'

import type { DictationEvent, Settings } from '@murmur/shared'

import { DictationStateMachine } from './dictation/state-machine'
import { registerIpcHandlers } from './ipc/register'
import { loadCatalog } from './models/catalog'
import { describeNative } from './native'
import { installSecurityPolicies } from './security'
import { SettingsStore } from './store/settings-store'
import { TrayController } from './tray'
import { WindowManager } from './windows/manager'

/**
 * Composition root (PLAN §3.1).
 *
 * Boots the tray, the three windows, the settings store, the dictation state
 * machine and the IPC surface, then connects them: settings changes and
 * dictation events fan out to every window, and the Bar's visibility follows
 * both the current state and the user's `barVisibility` preference.
 */

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
  const dictation = new DictationStateMachine()

  let quitting = false
  const quit = (): void => {
    quitting = true
    app.quit()
  }

  app.on('second-instance', () => windows.showHub())

  await app.whenReady()

  // Before any window exists, so every renderer is covered from its first load.
  installSecurityPolicies(isDev)

  // Everything below needs `app.whenReady()` (userData path, screen module,
  // Tray, BrowserWindow).
  const settings = SettingsStore.inUserData(app.getPath('userData'))
  const catalog = loadCatalog(app.getAppPath(), process.resourcesPath)

  console.log(`[murmur] ${app.getName()} ${app.getVersion()} on ${process.platform}`)
  console.log(`[murmur] ${describeNative()}`)
  if (catalog.error) {
    console.error('[murmur] the model catalog was rejected — the picker will be empty')
  }

  windows.start()

  let paused = false
  const tray = new TrayController({
    openHub: () => windows.showHub(),
    setPaused: (next) => {
      paused = next
      // TODO(stage-2): suspend/resume the native hotkey listener here.
      console.log(`[murmur] ${paused ? 'paused' : 'resumed'}`)
      if (paused) dictation.reset()
    },
    isPaused: () => paused,
    quit,
  })
  tray.start()

  const ipc = registerIpcHandlers({ windows, settings, dictation, catalog, isDev, quit })

  // -- fan-out -------------------------------------------------------------

  settings.on('changed', (next: Settings) => {
    ipc.broadcast(windows.allWebContents(), 'settings.changed', next)
    applyBarVisibility(next, dictation.getState())
  })

  dictation.on('event', (event: DictationEvent) => {
    ipc.broadcast(windows.uiWebContents(), 'dictation.state', event)
    applyBarVisibility(settings.get(), event)
  })

  /** PLAN §2.1: show while dictating (default) · always · hidden. */
  function applyBarVisibility(current: Settings, event: DictationEvent): void {
    switch (current.barVisibility) {
      case 'always':
        windows.showBar()
        return
      case 'hidden':
        windows.hideBar()
        return
      case 'showWhileDictating':
        if (event.state === 'idle') windows.hideBar()
        else windows.showBar()
        return
    }
  }

  applyBarVisibility(settings.get(), dictation.getState())
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

  app.on('before-quit', () => {
    quitting = true
    tray.destroy()
  })
}
