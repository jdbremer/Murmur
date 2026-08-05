import { join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'

import {
  EngineStatusSchema,
  type EngineStatus,
  type EngineUnavailableReason,
  type Transcript,
} from '@murmur/shared'

import { SIDECAR, TIMEOUTS } from '../../config'
import { createLogger, redact, type Logger } from '../../logging'
import { detectFamily, type OnnxRequest, type OnnxResponse } from './onnx/protocol'
import {
  StatusHolder,
  type ModelRef,
  type SttEngine,
  type SttOptions,
  type UtteranceOptions,
} from '../types'

/**
 * The ONNX Runtime STT engine, main-process side (PLAN §3.1, §6.1).
 *
 * All this class does is own a `utilityProcess` running `onnx-host.js` and
 * forward request/response pairs to it. The reasons for the split are in
 * `onnx/host.ts`; the reason it looks like *this* is that a crashed utility
 * process must be indistinguishable, from the orchestrator's point of view,
 * from a sidecar that died: a status change, an in-flight request rejected, and
 * a bounded number of restarts before `crash-loop` (PLAN §15.1).
 *
 * The engine reports `unavailable(runtime-missing)` — cleanly, no throw — when
 * `onnxruntime-node` is absent, which is the normal state on a Linux dev
 * container and on any CI leg where the postinstall was blocked.
 */

export interface OnnxEngineOptions {
  /** Directory holding the built main-process bundles (`__dirname` of index). */
  hostDirectory: string
  log?: Logger
}

interface Pending {
  resolve: (response: OnnxResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Built by electron-vite alongside the main bundle; see electron.vite.config.ts. */
export const ONNX_HOST_FILE = 'onnx-host.js'

export class OnnxRuntimeEngine implements SttEngine {
  readonly id = 'onnx-runtime' as const

  readonly #status = new StatusHolder(
    EngineStatusSchema.parse({ state: 'idle', engine: 'onnx-runtime' }),
  )
  readonly #log: Logger
  readonly #hostPath: string
  readonly #pending = new Map<number, Pending>()

  #child: UtilityProcess | null = null
  #model: ModelRef | null = null
  #nextId = 1
  #restarts = 0
  #runtimeAvailable: boolean | null = null
  #stopping = false

  constructor(options: OnnxEngineOptions) {
    this.#log = options.log ?? createLogger('stt:onnx')
    this.#hostPath = join(options.hostDirectory, ONNX_HOST_FILE)
  }

  status(): EngineStatus {
    return this.#status.get()
  }

  onStatusChange(listener: (status: EngineStatus) => void): () => void {
    return this.#status.subscribe(listener)
  }

  async load(model: ModelRef, _options: SttOptions): Promise<void> {
    // Dictionary biasing on this path is post-STT for now (PLAN §6.4), so the
    // options carry nothing the host needs — they are applied by the caller.
    void _options

    const family = detectFamily(model.files)
    if (!family) {
      this.#unavailable(
        'model-missing',
        `Could not tell which model family "${model.modelId}" is from its files ` +
          `[${model.files.join(', ')}].`,
      )
      return
    }

    this.#model = model
    this.#status.set({
      state: 'loading',
      engine: 'onnx-runtime',
      modelId: model.modelId,
      detail: `Loading ${model.modelId}…`,
    })

    try {
      await this.#ensureChild()
    } catch (error) {
      this.#unavailable('unknown', error instanceof Error ? error.message : String(error))
      return
    }

    if (this.#runtimeAvailable === false) {
      // `#ensureChild` already recorded the detail from the host's `ready`.
      return
    }

    const response = await this.#request({
      type: 'load',
      id: this.#nextId++,
      modelId: model.modelId,
      family,
      directory: model.directory,
      files: [...model.files],
    })

    if (response.type === 'error') {
      this.#unavailable(mapReason(response.reason), response.message)
      return
    }

    this.#status.set({
      state: 'ready',
      engine: 'onnx-runtime',
      modelId: model.modelId,
      detail: `${model.modelId} resident`,
    })
  }

  async transcribe(pcm: Float32Array, options: UtteranceOptions): Promise<Transcript> {
    if (this.#status.get().state !== 'ready') {
      throw new Error(`ONNX engine is not ready (${this.#status.get().detail || 'no model'})`)
    }

    // Copy into a standalone ArrayBuffer: `pcm` may be a view over a larger
    // buffer, and structured clone would otherwise ship the whole thing.
    const copy = new Float32Array(pcm)
    const response = await this.#request(
      {
        type: 'transcribe',
        id: this.#nextId++,
        pcm: copy.buffer as ArrayBuffer,
        sampleCount: copy.length,
      },
      options.signal,
    )

    if (response.type === 'error') throw new Error(response.message)
    if (response.type !== 'transcribed') throw new Error('Unexpected reply from the STT process')

    this.#log.debug(`transcribed in ${response.durationMs} ms →`, redact(response.text))
    return {
      text: response.text,
      avgLogProb: response.avgLogProb,
      durationMs: response.durationMs,
    }
  }

  async unload(): Promise<void> {
    this.#model = null
    if (this.#child) {
      try {
        await this.#request({ type: 'unload', id: this.#nextId++ })
      } catch {
        // The child is going away regardless.
      }
    }
    this.#status.set({ state: 'idle', engine: 'onnx-runtime', modelId: null })
  }

  async dispose(): Promise<void> {
    this.#stopping = true
    await this.unload()
    this.#killChild('disposed')
    this.#status.clearListeners()
  }

  // -- utility process -----------------------------------------------------

  async #ensureChild(): Promise<void> {
    if (this.#child) return

    this.#stopping = false
    const child = utilityProcess.fork(this.#hostPath, [], {
      serviceName: 'murmur-stt',
      // No stdout inheritance: the host logs through its replies, and a chatty
      // ORT build would otherwise spam the app's console.
      stdio: 'ignore',
    })
    this.#child = child

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('STT utility process did not report ready in time'))
      }, TIMEOUTS.sidecarHealthMs)

      const onMessage = (message: OnnxResponse): void => {
        if (message.type !== 'ready') return
        clearTimeout(timer)
        this.#runtimeAvailable = message.runtimeAvailable
        if (!message.runtimeAvailable) {
          this.#unavailable('runtime-missing', message.detail)
        } else {
          this.#log.info(message.detail)
        }
        resolve()
      }

      child.on('message', onMessage)
    })

    child.on('message', (message: OnnxResponse) => this.#onMessage(message))
    child.on('exit', (code) => this.#onExit(code))

    await ready
  }

  #onMessage(message: OnnxResponse): void {
    if (message.type === 'ready') return
    const pending = this.#pending.get(message.id)
    if (!pending) return
    this.#pending.delete(message.id)
    clearTimeout(pending.timer)
    pending.resolve(message)
  }

  #onExit(code: number): void {
    this.#child = null
    const error = new Error(`STT utility process exited (code ${code})`)
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()

    if (this.#stopping) return

    this.#restarts += 1
    if (this.#restarts > SIDECAR.maxRestarts) {
      this.#unavailable(
        'crash-loop',
        `The STT process crashed ${this.#restarts} times in a row. Re-select the model to retry.`,
      )
      return
    }

    this.#log.warn(`crashed; restart ${this.#restarts}/${SIDECAR.maxRestarts}`)
    const model = this.#model
    if (!model) return
    setTimeout(
      () => {
        void this.load(model, { language: 'auto', vocabulary: [] }).catch(
          (restartError: unknown) => {
            this.#log.error('restart failed:', restartError)
          },
        )
      },
      SIDECAR.restartBackoffMs * 2 ** (this.#restarts - 1),
    ).unref?.()
  }

  #request(request: OnnxRequest, signal?: AbortSignal): Promise<OnnxResponse> {
    const child = this.#child
    if (!child) return Promise.reject(new Error('STT utility process is not running'))

    return new Promise<OnnxResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.id)
        reject(new Error(`STT request "${request.type}" timed out`))
      }, TIMEOUTS.sidecarRequestMs)

      this.#pending.set(request.id, { resolve, reject, timer })

      signal?.addEventListener(
        'abort',
        () => {
          const pending = this.#pending.get(request.id)
          if (!pending) return
          this.#pending.delete(request.id)
          clearTimeout(pending.timer)
          reject(new Error('cancelled'))
        },
        { once: true },
      )

      child.postMessage(request)
    })
  }

  #killChild(reason: string): void {
    const child = this.#child
    this.#child = null
    if (!child) return
    this.#log.info(`stopping STT process (${reason})`)
    child.kill()
  }

  #unavailable(reason: EngineUnavailableReason, detail: string): void {
    this.#log.warn(detail)
    this.#status.set({
      state: 'unavailable',
      engine: 'onnx-runtime',
      modelId: this.#model?.modelId ?? null,
      reason,
      detail,
    })
  }
}

function mapReason(
  reason: 'runtime-missing' | 'model-missing' | 'unknown',
): EngineUnavailableReason {
  return reason
}
