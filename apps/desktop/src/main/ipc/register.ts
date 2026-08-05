import { app, ipcMain } from 'electron'

import {
  applyStyleProfilePatch,
  createDefaultStyleProfiles,
  createMainIpc,
  type MainIpc,
  type StyleProfileSet,
} from '@murmur/shared'

import type { DictationStateMachine } from '../dictation/state-machine'
import type { LoadedCatalog } from '../models/catalog'
import type { SettingsStore } from '../store/settings-store'
import type { WindowManager } from '../windows/manager'
import { native } from '../native'
import { simulateDictation } from '../dictation/simulator'

/**
 * Every `ipcMain` handler the app registers.
 *
 * Three tiers live here, and each one is labelled so the next stage knows what
 * it is looking at:
 *
 *  - **wired** — backed by real state, round-trips for real today.
 *  - **read-only placeholder** — returns a truthful empty result because the
 *    store behind it does not exist yet (PLAN §9's SQLite arrives in Stage 2).
 *  - **not implemented** — throws a clear error rather than lying.
 *
 * To add a channel: declare it in `@murmur/shared/src/ipc/contract.ts`, then
 * register it here. The payload types follow automatically.
 */

export interface IpcContext {
  windows: WindowManager
  settings: SettingsStore
  dictation: DictationStateMachine
  catalog: LoadedCatalog
  isDev: boolean
  quit: () => void
}

function notImplemented(channel: string): never {
  throw new Error(
    `IPC channel "${channel}" is declared but not implemented yet (arrives in Stage 2).`,
  )
}

export function registerIpcHandlers(context: IpcContext): MainIpc {
  const ipc = createMainIpc(ipcMain)
  const { windows, settings, dictation, catalog } = context

  // In-memory until PLAN §9's `style_profiles` table exists.
  // TODO(stage-2): persist alongside history and the dictionary in SQLite.
  let styleProfiles: StyleProfileSet = createDefaultStyleProfiles()

  // -- app: wired ----------------------------------------------------------
  ipc.handle('app.version', () => app.getVersion())
  ipc.handle('app.quit', () => {
    context.quit()
  })
  ipc.handle('app.openHub', () => {
    windows.showHub()
  })

  // -- settings: wired (round-trips to <userData>/settings.json) ------------
  ipc.handle('settings.get', () => settings.get())
  ipc.handle('settings.set', (patch) => settings.set(patch))

  // -- dictation: wired ----------------------------------------------------
  ipc.handle('dictation.getState', () => dictation.getState())
  ipc.handle('dictation.cancel', () => {
    dictation.reset()
  })
  ipc.handle('dictation.startHandsFree', () => {
    // TODO(stage-2): latch the mode and start capture; for now this only moves
    // the state machine so the Bar's hands-free visual can be developed.
    dictation.startListening(true)
  })
  ipc.handle('dictation.stopHandsFree', () => {
    dictation.reset()
  })

  // -- models --------------------------------------------------------------
  // `models.list` is wired: it serves the catalog that already passed the
  // origin policy at boot (PLAN §8). Installed/imported sets are empty until
  // the downloader exists.
  ipc.handle('models.list', () => ({
    catalog: catalog.catalog,
    installed: [],
    imported: [],
    diskUsageBytes: 0,
  }))
  // Selecting a model is a settings write, so it works today.
  ipc.handle('models.select', ({ kind, modelId }) =>
    settings.set(kind === 'stt' ? { sttModelId: modelId } : { polishModelId: modelId }),
  )
  ipc.handle('models.downloadStart', () => notImplemented('models.downloadStart'))
  ipc.handle('models.downloadCancel', () => notImplemented('models.downloadCancel'))
  ipc.handle('models.delete', () => notImplemented('models.delete'))
  ipc.handle('models.import', () => notImplemented('models.import'))

  // -- history: read-only placeholders (SQLite + FTS5 land in Stage 2) ------
  ipc.handle('history.query', () => ({ records: [], total: 0 }))
  ipc.handle('history.stats', () => ({ totalWords: 0, avgWpm: 0, streakDays: 0 }))
  ipc.handle('history.delete', () => notImplemented('history.delete'))
  ipc.handle('history.clear', () => notImplemented('history.clear'))

  // -- dictionary: read-only placeholder ------------------------------------
  ipc.handle('dictionary.list', () => [])
  ipc.handle('dictionary.create', () => notImplemented('dictionary.create'))
  ipc.handle('dictionary.update', () => notImplemented('dictionary.update'))
  ipc.handle('dictionary.delete', () => notImplemented('dictionary.delete'))

  // -- style: in-memory ----------------------------------------------------
  ipc.handle('style.get', () => styleProfiles)
  ipc.handle('style.set', (patch) => {
    styleProfiles = applyStyleProfilePatch(styleProfiles, patch)
    return styleProfiles
  })

  // -- permissions: wired through the native module (stub-safe) -------------
  ipc.handle('permissions.status', () => native().permissions.check())
  ipc.handle('permissions.request', async ({ kind }) => {
    await native().permissions.request(kind)
    return native().permissions.check()
  })
  ipc.handle('permissions.openSystemSettings', ({ kind }) => {
    native().permissions.openSettings(kind)
  })

  // -- audio: frames from the hidden capture renderer ------------------------
  ipc.receive('audio.frame', () => {
    // TODO(stage-2): ring-buffer, VAD-trim, hand to the STT engine (PLAN §5).
  })
  ipc.receive('audio.status', (status) => {
    console.log('[audio] capture status:', status.status)
  })

  // -- debug: unpackaged builds only ---------------------------------------
  if (context.isDev) {
    ipc.handle('debug.simulateDictation', async () => {
      await simulateDictation(dictation)
    })
  }

  return ipc
}
