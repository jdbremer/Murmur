import { app, dialog } from 'electron'

import type { MainIpc } from '@murmur/shared'

import type { DictationOrchestrator } from '../dictation/orchestrator'
import type { DictationStateMachine } from '../dictation/state-machine'
import type { EngineCoordinator } from '../engines/coordinator'
import type { HotkeyBridge } from '../dictation/hotkey'
import type { ModelManager } from '../models/manager'
import type { SettingsStore } from '../store/settings-store'
import type {
  DictationsRepository,
  DictionaryRepository,
  StyleRepository,
} from '../store/repositories'
import type { WindowManager } from '../windows/manager'
import type { CaptureController } from '../audio/controller'
import type { AudioCaptureStatus, AudioDeviceList } from '@murmur/shared'
import { AUDIO } from '../config'
import { framePcm } from '../audio/buffer'
import { describeNative, native } from '../native'
import { simulateDictation } from '../dictation/simulator'
import { installSidecarBinary } from '../engines/install-sidecar'
import { setBarInteractive } from '../windows/bar'

/**
 * Every `ipcMain` handler the app registers.
 *
 * By Stage 2 there are no placeholders left: every channel in the contract is
 * backed by real state. The only conditional handlers are the `debug.*` pair,
 * registered in unpackaged builds only, and `models.import`, which refuses
 * Hugging-Face-repo imports explicitly rather than pretending.
 *
 * To add a channel: declare it in `@murmur/shared/src/ipc/contract.ts`, register
 * it here, expose it in the preload. The payload types follow automatically and
 * zod validates both directions at the boundary.
 */

export interface IpcContext {
  /** Created by the composition root so subsystems can emit before this runs. */
  ipc: MainIpc
  windows: WindowManager
  settings: SettingsStore
  machine: DictationStateMachine
  orchestrator: DictationOrchestrator
  engines: EngineCoordinator
  models: ModelManager
  hotkeys: HotkeyBridge
  /** Mic stream controller — Dev tools re-warm through this. */
  audio: CaptureController
  /** Real paste path — exposed to Dev/agent for G5 insert proof. */
  injector: { insert: (text: string) => { ok: boolean; method: 'paste' | 'accessibility' | 'none'; error?: string } }
  dictations: DictationsRepository
  dictionary: DictionaryRepository
  style: StyleRepository
  isDev: boolean
  quit: () => void
}

export function registerIpcHandlers(context: IpcContext): MainIpc {
  const { ipc, windows, settings, machine, orchestrator, engines, models } = context
  /** Last capture lifecycle, for `debug.snapshot` and Hub Dev tools. */
  let lastCapture: AudioCaptureStatus | null = null

  // -- app -----------------------------------------------------------------
  ipc.handle('app.version', () => app.getVersion())
  ipc.handle('app.info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isDev: context.isDev,
    // Explicit opt-in — never ship the Developer panel to end users.
    showDevTools: context.isDev && process.env['MURMUR_DEV_TOOLS'] === '1',
    native: describeNative(),
  }))
  ipc.handle('app.devMode', () => context.isDev)
  ipc.handle('app.quit', () => {
    context.quit()
  })
  ipc.handle('app.openHub', () => {
    windows.showHub()
  })

  // -- settings ------------------------------------------------------------
  ipc.handle('settings.get', () => settings.get())
  ipc.handle('settings.set', (patch) => settings.set(patch))

  // -- dictation -----------------------------------------------------------
  ipc.handle('dictation.getState', () => machine.getState())
  ipc.handle('dictation.cancel', () => {
    // Esc from the Bar is a deliberate user action, so the pill just closes
    // rather than flashing an error at someone who meant to stop (PLAN §2.1).
    orchestrator.cancel()
  })
  ipc.handle('dictation.startHandsFree', () => {
    orchestrator.startHandsFree()
  })
  ipc.handle('dictation.stopHandsFree', () => {
    orchestrator.stopHandsFree()
  })

  // -- models --------------------------------------------------------------
  ipc.handle('models.list', () => models.list())
  ipc.handle('models.downloadStart', ({ modelId }) => ({
    downloadId: models.startDownload(modelId),
  }))
  ipc.handle('models.downloadCancel', ({ downloadId }) => {
    models.cancelDownload(downloadId)
  })
  ipc.handle('models.select', ({ kind, modelId }) =>
    settings.set(kind === 'stt' ? { sttModelId: modelId } : { polishModelId: modelId }),
  )
  ipc.handle('models.delete', ({ modelId }) => {
    models.delete(modelId)
    // A deleted model must not leave a dangling selection pointing at it.
    const current = settings.get()
    if (current.sttModelId === modelId) settings.set({ sttModelId: null })
    if (current.polishModelId === modelId) settings.set({ polishModelId: null })
  })
  ipc.handle('models.import', (request) => models.import(request))
  ipc.handle('models.chooseFile', async () => {
    // The three weight formats Murmur's engines can actually load: GGUF for the
    // llama.cpp / whisper.cpp sidecars, `.bin` for whisper's older dumps, and
    // ONNX for the utility-process runtime.
    const result = await dialog.showOpenDialog({
      title: 'Choose a model file',
      properties: ['openFile'],
      filters: [
        { name: 'Model weights', extensions: ['gguf', 'bin', 'onnx'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // -- engines -------------------------------------------------------------
  ipc.handle('engines.status', () => engines.status())
  ipc.handle('engines.installSidecar', async ({ which }) => {
    // Consent is gathered in the renderer (Models UI). Main only downloads.
    const result = await installSidecarBinary(which, app.getAppPath())
    if (result.ok) {
      // Reload engines so polish/STT pick up the new binary without restart.
      await engines.apply(settings.get())
    }
    return result
  })

  // -- history -------------------------------------------------------------
  ipc.handle('history.query', (query) => context.dictations.query(query))
  ipc.handle('history.stats', () => context.dictations.stats())
  ipc.handle('history.delete', ({ id }) => {
    context.dictations.delete(id)
  })
  ipc.handle('history.clear', () => {
    context.dictations.clear()
  })

  // -- dictionary ----------------------------------------------------------
  ipc.handle('dictionary.list', () => context.dictionary.list())
  ipc.handle('dictionary.create', (draft) => context.dictionary.create(draft))
  ipc.handle('dictionary.update', ({ id, patch }) => context.dictionary.update(id, patch))
  ipc.handle('dictionary.delete', ({ id }) => {
    context.dictionary.delete(id)
  })

  // -- style ---------------------------------------------------------------
  ipc.handle('style.get', () => context.style.get())
  ipc.handle('style.set', (patch) => context.style.set(patch))

  // -- permissions ---------------------------------------------------------
  ipc.handle('permissions.status', () => native().permissions.check())
  ipc.handle('permissions.request', async ({ kind }) => {
    await native().permissions.request(kind)
    return native().permissions.check()
  })
  ipc.handle('permissions.openSystemSettings', ({ kind }) => {
    native().permissions.openSettings(kind)
  })

  // -- audio: frames from the hidden capture renderer ------------------------
  ipc.receive('audio.frame', (frame) => {
    orchestrator.pushFrame(framePcm(frame.pcm, frame.sampleCount))
  })
  // The orchestrator only cares about errors mid-dictation (an idle error has
  // no dictation to fail). The Hub cares about *every* report — a permission
  // denied at the startup warm used to vanish here (HANDOFF item #4) — so the
  // last one is cached for `audio.captureStatus` and broadcast as
  // `audio.captureChanged`.
  let captureStatus: AudioCaptureStatus = { status: 'idle' }
  ipc.receive('audio.status', (status) => {
    // An error is sticky until the mic *proves itself* with a 'ready': the
    // warm-idle timer releases the stream a few minutes after startup, and the
    // resulting 'idle' must not wash away a "permission denied" the user has
    // never seen. Only working hardware clears the banner.
    const keepError = captureStatus.status === 'error' && status.status === 'idle'
    if (!keepError) {
      captureStatus = status
      lastCapture = status
      ipc.broadcast(windows.uiWebContents(), 'audio.captureChanged', status)
    }
    if (status.status === 'error') orchestrator.reportAudioError(status.message)
  })
  ipc.handle('audio.captureStatus', () => captureStatus)
  // The capture renderer meters at ~30 Hz; main is only the relay to the Bar,
  // which interpolates it up to 60 fps (PLAN §2.1).
  ipc.receive('audio.meter', (level) => {
    ipc.broadcast(windows.uiWebContents(), 'audio.level', level)
  })

  // -- audio devices: enumerated by the capture renderer, cached here --------
  let devices: AudioDeviceList = { devices: [] }
  ipc.receive('audio.devices', (next) => {
    devices = next
    ipc.broadcast(windows.uiWebContents(), 'audio.devicesChanged', next)
  })
  ipc.handle('audio.listDevices', () => devices)

  // -- bar: click-through everywhere except the pill (PLAN §2.1) -------------
  ipc.receive('bar.pointerRegion', ({ interactive }) => {
    setBarInteractive(windows.bar(), interactive)
  })

  // -- debug: unpackaged builds only ---------------------------------------
  if (context.isDev) {
    ipc.handle('debug.simulateDictation', async () => {
      await simulateDictation(machine)
    })
    ipc.handle('debug.simulateHotkey', ({ action }) => {
      // Drives the *real* pipeline, so a dev machine with no event tap can
      // still exercise capture → VAD → STT → polish → insert end to end.
      // `synthetic` keeps the bridge's physical-state watchdog disarmed — the
      // HID system rightly reports "not held" for a key nobody pressed.
      context.hotkeys.handle({ type: action, timestamp: Date.now(), synthetic: true })
    })

    // `kill -USR2 <pid>` is the terminal-driven twin of debug.simulateHotkey:
    // each signal alternates a synthetic hotkey down/up through the real
    // pipeline. It exists so a shell can run a whole dictation hands-off —
    // signal, `say` a sentence at the microphone, signal again — which is how
    // the loop is exercised on a machine nobody is sitting at. Unpackaged
    // builds only, like everything else in this block.
    let signalHeld = false
    process.on('SIGUSR2', () => {
      signalHeld = !signalHeld
      context.hotkeys.handle({
        type: signalHeld ? 'down' : 'up',
        timestamp: Date.now(),
        synthetic: true,
      })
    })
    ipc.handle('debug.warmMic', () => {
      context.audio.warm(settings.get().micDeviceId)
    })
    ipc.handle('debug.injectPcm', ({ durationMs, amplitude, frequencyHz, samples }) => {
      const samplesPerFrame = Math.round((AUDIO.sampleRate * AUDIO.frameMs) / 1000)
      let produced = 0
      let frames = 0

      // Prefer raw samples when the agent injects a real speech file (G7).
      if (samples && samples.length > 0) {
        while (produced < samples.length) {
          const n = Math.min(samplesPerFrame, samples.length - produced)
          const frame = new Float32Array(n)
          for (let i = 0; i < n; i++) {
            const v = samples[produced + i] ?? 0
            frame[i] = Math.max(-1, Math.min(1, v))
          }
          orchestrator.pushFrame(frame)
          produced += n
          frames += 1
        }
        return { frames, sampleCount: produced }
      }

      const totalSamples = Math.max(1, Math.round((AUDIO.sampleRate * durationMs) / 1000))
      let phase = 0
      const twoPiF = (2 * Math.PI * frequencyHz) / AUDIO.sampleRate

      while (produced < totalSamples) {
        const n = Math.min(samplesPerFrame, totalSamples - produced)
        const frame = new Float32Array(n)
        for (let i = 0; i < n; i++) {
          // Soft envelope so levels are non-zero and VAD sees energy.
          const t = (produced + i) / totalSamples
          const env = Math.sin(Math.PI * Math.min(1, Math.max(0, t * 1.05)))
          frame[i] = amplitude * env * Math.sin(phase)
          phase += twoPiF
        }
        orchestrator.pushFrame(frame)
        produced += n
        frames += 1
      }

      return { frames, sampleCount: produced }
    })
    ipc.handle('debug.snapshot', () => ({
      app: {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        isDev: context.isDev,
        native: describeNative(),
      },
      dictation: machine.getState(),
      engines: engines.status(),
      capture: lastCapture,
    }))
    ipc.handle('debug.insertText', ({ text }) => {
      const result = context.injector.insert(text)
      return {
        ok: result.ok,
        method: result.method,
        ...(result.error ? { error: result.error } : {}),
      }
    })
  }

  return ipc
}
