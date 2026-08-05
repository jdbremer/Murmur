import { EventEmitter } from 'node:events'

import {
  createEnginesStatus,
  type EnginesStatus,
  type EngineStatus,
  type Settings,
} from '@murmur/shared'

import { createLogger, type Logger } from '../logging'
import type { ModelManager } from '../models/manager'
import { allSidecarPresence } from './install-sidecar'
import { LlamaCppPolishEngine } from './polish/llama-cpp'
import { ExternalPolishEngine } from './polish/external'
import { OnnxRuntimeEngine } from './stt/onnx-runtime'
import { WhisperCppEngine } from './stt/whisper-cpp'
import type { PolishEngine, SttEngine } from './types'

/**
 * Picks and swaps engines as settings change (PLAN §6.1, §7.1, §13 M2).
 *
 * "Model switching without an app restart" is an acceptance criterion, and the
 * awkward part is that switching models can also switch *engines* — Whisper
 * large-v3-turbo runs in the whisper.cpp sidecar and Moonshine runs in the ONNX
 * utility process. This class owns that: given the settings and the model
 * manager, it makes sure exactly the right engine is loaded with exactly the
 * right model, tears down the one that is no longer needed, and publishes a
 * combined status.
 *
 * `apply()` is the whole API and it is idempotent — call it on boot, on every
 * settings change, and after a download finishes. It resolves once the engines
 * have settled, and it never throws: everything that can go wrong is already
 * expressible as an `EngineStatus`.
 */

export interface EngineCoordinatorEvents {
  status: [EnginesStatus]
}

export interface EngineCoordinatorOptions {
  models: ModelManager
  resourcesPath: string
  appPath: string
  /** Directory holding the built main bundles, for the ONNX utility process. */
  hostDirectory: string
  dictionary(): readonly string[]
  log?: Logger
}

export class EngineCoordinator extends EventEmitter<EngineCoordinatorEvents> {
  readonly #options: EngineCoordinatorOptions
  readonly #log: Logger

  #stt: SttEngine | null = null
  #polish: PolishEngine | null = null
  #sttStatus: EngineStatus = createEnginesStatus().stt
  #polishStatus: EngineStatus = createEnginesStatus().polish
  #unsubscribeStt: (() => void) | null = null
  #unsubscribePolish: (() => void) | null = null
  /** Serialises `apply()` calls so two settings changes cannot interleave. */
  #applying: Promise<void> = Promise.resolve()

  constructor(options: EngineCoordinatorOptions) {
    super()
    this.#options = options
    this.#log = options.log ?? createLogger('engines')
  }

  status(): EnginesStatus {
    const sidecars = allSidecarPresence(this.#options.resourcesPath, this.#options.appPath)
    return {
      stt: this.#sttStatus,
      polish: this.#polishStatus,
      sidecars: {
        whisper: { installed: sidecars.whisper.installed, path: sidecars.whisper.path },
        llama: { installed: sidecars.llama.installed, path: sidecars.llama.path },
      },
    }
  }

  /** The STT engine, if one is loaded. The orchestrator asks per utterance. */
  stt(): SttEngine | null {
    return this.#stt
  }

  /** The polish engine, or `null` when polishing is off. */
  polish(): PolishEngine | null {
    return this.#polish
  }

  /** Reconcile the loaded engines with `settings`. Never throws. */
  apply(settings: Settings): Promise<void> {
    this.#applying = this.#applying
      .then(() => this.#applyNow(settings))
      .catch((error: unknown) => {
        this.#log.error('engine reconciliation failed:', error)
      })
    return this.#applying
  }

  async #applyNow(settings: Settings): Promise<void> {
    await this.#applyStt(settings)
    await this.#applyPolish(settings)
  }

  // -- STT -----------------------------------------------------------------

  async #applyStt(settings: Settings): Promise<void> {
    const modelId = settings.sttModelId
    if (!modelId) {
      await this.#disposeStt()
      this.#setStt({
        engine: null,
        state: 'unavailable',
        modelId: null,
        reason: 'no-model-selected',
        detail: 'Choose a speech-to-text model in the Hub.',
        warnings: [],
      })
      return
    }

    const ref = this.#options.models.resolve(modelId)
    if (!ref) {
      await this.#disposeStt()
      this.#setStt({
        engine: null,
        state: 'unavailable',
        modelId,
        reason: 'model-missing',
        detail: `"${modelId}" is selected but not downloaded yet.`,
        warnings: [],
      })
      return
    }

    // A different engine means the old one has to go entirely; the same engine
    // can swap models in place, which is the fast path.
    if (this.#stt && this.#stt.id !== ref.engine) await this.#disposeStt()

    if (!this.#stt) {
      this.#stt =
        ref.engine === 'onnx-runtime'
          ? new OnnxRuntimeEngine({ hostDirectory: this.#options.hostDirectory })
          : new WhisperCppEngine({
              resourcesPath: this.#options.resourcesPath,
              appPath: this.#options.appPath,
            })
      this.#unsubscribeStt = this.#stt.onStatusChange((status) => this.#setStt(status))
    }

    await this.#stt.load(ref, {
      language: settings.language,
      vocabulary: this.#options.dictionary(),
    })
    this.#setStt(this.#stt.status())
  }

  // -- polish --------------------------------------------------------------

  async #applyPolish(settings: Settings): Promise<void> {
    // An external endpoint wins over a local model when configured (PLAN §7.1).
    if (settings.externalEndpoint && settings.polishingLevel !== 'off') {
      if (this.#polish?.id !== 'external') {
        await this.#disposePolish()
        this.#polish = new ExternalPolishEngine({ endpoint: settings.externalEndpoint })
        this.#unsubscribePolish = this.#polish.onStatusChange((status) => this.#setPolish(status))
      }
      await this.#polish.load(null, { modelId: settings.externalEndpoint.model })
      this.#setPolish(this.#polish.status())
      return
    }

    if (settings.polishingLevel === 'off' || !settings.polishModelId) {
      await this.#disposePolish()
      this.#setPolish({
        engine: null,
        state: 'idle',
        modelId: null,
        reason: null,
        detail:
          settings.polishingLevel === 'off'
            ? 'Polishing is off — the raw transcript is inserted.'
            : 'Choose a polishing model in the Hub.',
        warnings: [],
      })
      return
    }

    const ref = this.#options.models.resolve(settings.polishModelId)
    if (!ref) {
      await this.#disposePolish()
      this.#setPolish({
        engine: 'llama-cpp',
        state: 'unavailable',
        modelId: settings.polishModelId,
        reason: 'model-missing',
        detail: `"${settings.polishModelId}" is selected but not downloaded yet.`,
        warnings: [],
      })
      return
    }

    if (this.#polish && this.#polish.id !== 'llama-cpp') await this.#disposePolish()

    if (!this.#polish) {
      this.#polish = new LlamaCppPolishEngine({
        resourcesPath: this.#options.resourcesPath,
        appPath: this.#options.appPath,
      })
      this.#unsubscribePolish = this.#polish.onStatusChange((status) => this.#setPolish(status))
    }

    await this.#polish.load(ref, { modelId: settings.polishModelId })
    this.#setPolish(this.#polish.status())
  }

  // -- teardown ------------------------------------------------------------

  async dispose(): Promise<void> {
    await this.#disposeStt()
    await this.#disposePolish()
    this.removeAllListeners()
  }

  async #disposeStt(): Promise<void> {
    this.#unsubscribeStt?.()
    this.#unsubscribeStt = null
    const engine = this.#stt
    this.#stt = null
    if (engine) await engine.dispose()
  }

  async #disposePolish(): Promise<void> {
    this.#unsubscribePolish?.()
    this.#unsubscribePolish = null
    const engine = this.#polish
    this.#polish = null
    if (engine) await engine.dispose()
  }

  #setStt(status: EngineStatus): void {
    this.#sttStatus = status
    this.emit('status', this.status())
  }

  #setPolish(status: EngineStatus): void {
    this.#polishStatus = status
    this.emit('status', this.status())
  }
}
