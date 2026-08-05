import { join } from 'node:path'

import { EngineStatusSchema, type EngineStatus, type EngineUnavailableReason } from '@murmur/shared'

import { POLISH } from '../../config'
import { createLogger, type Logger } from '../../logging'
import {
  resolveSidecarBinary,
  SidecarProcess,
  type SidecarInfo,
  type SidecarSpec,
} from '../sidecar'
import {
  StatusHolder,
  type ModelRef,
  type PolishEngine,
  type PolishRequest,
  type PolishResult,
} from '../types'
import { ChatClient, endpointWarnings } from './client'
import { unwrapModelOutput } from './prompt'

/**
 * The bundled `llama.cpp` server, used for local polishing (PLAN §7.1).
 *
 * Same sidecar pattern as whisper.cpp — loopback bind, ephemeral port,
 * per-launch bearer token, SIGTERM→SIGKILL teardown, watchdog restarts — with
 * one extra behaviour of its own: an **idle unload timer**. A 4B model at Q4
 * holds ~2.6 GB resident, and a dictation app is idle most of the day, so the
 * server is stopped after {@link POLISH.idleUnloadMs} without a request and
 * respawned on the next one. The re-load costs a second or two, which is the
 * right trade against permanently parking gigabytes (PLAN §14's RAM guardrail).
 */

export const LLAMA_SERVER_BINARY = 'llama-server'

export interface LlamaEngineOptions {
  resourcesPath: string
  appPath: string
  /** Context window passed to llama-server. Polishing needs very little. */
  contextSize?: number
  threads?: number
  /** Overrides the idle-unload delay; `0` disables it. */
  idleUnloadMs?: number
  log?: Logger
}

export class LlamaCppPolishEngine implements PolishEngine {
  readonly id = 'llama-cpp' as const

  readonly #status = new StatusHolder(
    EngineStatusSchema.parse({ state: 'idle', engine: 'llama-cpp' }),
  )
  readonly #options: LlamaEngineOptions
  readonly #log: Logger
  #sidecar: SidecarProcess | null = null
  #model: ModelRef | null = null
  #modelId: string | null = null
  #idleTimer: NodeJS.Timeout | null = null
  /** Set while the idle timer unloaded us, so `polish()` knows to respawn. */
  #suspended = false

  constructor(options: LlamaEngineOptions) {
    this.#options = options
    this.#log = options.log ?? createLogger('polish:llama')
  }

  status(): EngineStatus {
    return this.#status.get()
  }

  onStatusChange(listener: (status: EngineStatus) => void): () => void {
    return this.#status.subscribe(listener)
  }

  async load(model: ModelRef | null, options: { modelId: string }): Promise<void> {
    if (!model) {
      this.#unavailable('model-missing', `Polish model "${options.modelId}" is not on disk.`)
      return
    }
    if (this.#modelId === model.modelId && this.#sidecar?.info().state === 'running') return

    await this.#stopSidecar()
    this.#model = model
    this.#modelId = model.modelId
    this.#suspended = false
    await this.#spawn()
  }

  async polish(request: PolishRequest): Promise<PolishResult> {
    if (this.#suspended) {
      this.#log.info('waking after idle unload')
      await this.#spawn()
    }

    const sidecar = this.#sidecar
    const baseUrl = sidecar?.baseUrl
    const token = sidecar?.token
    if (!sidecar || !baseUrl || !token || sidecar.info().state !== 'running') {
      throw new Error(`llama-server is not ready (${this.#status.get().detail || 'not started'})`)
    }

    const started = Date.now()
    const client = new ChatClient({ baseUrl, apiKey: token, model: this.#modelId ?? 'local' })
    const text = unwrapModelOutput(await client.complete(request))
    this.#armIdleTimer()
    return { text, durationMs: Date.now() - started }
  }

  async unload(): Promise<void> {
    this.#clearIdleTimer()
    this.#suspended = false
    this.#model = null
    this.#modelId = null
    await this.#stopSidecar()
    this.#status.set({ state: 'idle', engine: 'llama-cpp', modelId: null })
  }

  async dispose(): Promise<void> {
    await this.unload()
    this.#status.clearListeners()
  }

  // -- internals -----------------------------------------------------------

  async #spawn(): Promise<void> {
    const model = this.#model
    if (!model) {
      this.#unavailable('no-model-selected', 'No polish model selected.')
      return
    }

    const modelFile = model.files.find((file) => file.endsWith('.gguf'))
    if (!modelFile) {
      this.#unavailable('model-missing', `No .gguf file found in ${model.directory}`)
      return
    }

    const { path: binaryPath, searched } = resolveSidecarBinary(
      LLAMA_SERVER_BINARY,
      this.#options.resourcesPath,
      this.#options.appPath,
    )
    if (!binaryPath) {
      this.#unavailable(
        'binary-missing',
        `${LLAMA_SERVER_BINARY} is not installed. Looked in: ${searched.join(', ')}. ` +
          `Build it with scripts/sidecars/build-llama.sh.`,
      )
      return
    }

    this.#status.set({
      state: 'loading',
      engine: 'llama-cpp',
      modelId: model.modelId,
      detail: `Loading ${model.modelId}…`,
    })

    const spec: SidecarSpec = {
      name: LLAMA_SERVER_BINARY,
      binaryPath,
      healthPath: '/health',
      buildArgs: ({ port, token }) => [
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--model',
        join(model.directory, modelFile),
        '--api-key',
        token,
        '--ctx-size',
        String(this.#options.contextSize ?? 4096),
        '--threads',
        String(this.#options.threads ?? 4),
        // Everything runs on Metal where available; harmless elsewhere.
        '--n-gpu-layers',
        '999',
        // One utterance at a time; parallel slots would only fragment KV cache.
        '--parallel',
        '1',
        // Keep the system prompt's KV cache warm between utterances (PLAN §7.3).
        '--keep',
        '-1',
        '--no-webui',
      ],
    }

    this.#sidecar = new SidecarProcess(
      spec,
      { onStateChange: (info) => this.#onSidecar(info) },
      this.#log,
    )

    try {
      await this.#sidecar.start()
      this.#suspended = false
      const baseUrl = this.#sidecar.baseUrl ?? ''
      this.#status.set({
        state: 'ready',
        engine: 'llama-cpp',
        modelId: model.modelId,
        detail: `${model.modelId} resident`,
        // Always loopback for the bundled server, but check anyway: it costs
        // nothing and it keeps one code path for both backends.
        warnings: endpointWarnings(baseUrl),
      })
      this.#armIdleTimer()
    } catch (error) {
      this.#unavailable('unknown', error instanceof Error ? error.message : String(error))
    }
  }

  #armIdleTimer(): void {
    this.#clearIdleTimer()
    const delay = this.#options.idleUnloadMs ?? POLISH.idleUnloadMs
    if (delay <= 0) return
    this.#idleTimer = setTimeout(() => {
      void this.#suspend()
    }, delay)
    this.#idleTimer.unref?.()
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = null
  }

  /** Release the model's RAM but remember which one to bring back. */
  async #suspend(): Promise<void> {
    if (!this.#sidecar) return
    this.#log.info(`idle for ${POLISH.idleUnloadMs} ms — unloading to free memory`)
    this.#suspended = true
    await this.#stopSidecar()
    this.#status.set({
      state: 'idle',
      engine: 'llama-cpp',
      modelId: this.#modelId,
      detail: 'Unloaded after idle; will reload on the next dictation.',
    })
  }

  async #stopSidecar(): Promise<void> {
    const sidecar = this.#sidecar
    this.#sidecar = null
    if (sidecar) await sidecar.stop()
  }

  #onSidecar(info: SidecarInfo): void {
    if (info.state === 'failed') {
      this.#status.set({
        state: 'unavailable',
        engine: 'llama-cpp',
        modelId: this.#modelId,
        reason: 'crash-loop',
        detail: info.error ?? 'llama-server stopped responding',
      })
    }
  }

  #unavailable(reason: EngineUnavailableReason, detail: string): void {
    this.#log.warn(detail)
    this.#status.set({
      state: 'unavailable',
      engine: 'llama-cpp',
      modelId: this.#modelId,
      reason,
      detail,
    })
  }
}
