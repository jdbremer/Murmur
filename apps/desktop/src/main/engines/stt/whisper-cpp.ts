import { join } from 'node:path'

import {
  EngineStatusSchema,
  type EngineStatus,
  type EngineUnavailableReason,
  type Transcript,
} from '@murmur/shared'

import { AUDIO, TIMEOUTS } from '../../config'
import { createLogger, redact, type Logger } from '../../logging'
import { loopbackFetch } from '../../net/fetch'
import {
  resolveSidecarBinary,
  SidecarProcess,
  type SidecarInfo,
  type SidecarSpec,
} from '../sidecar'
import {
  StatusHolder,
  type ModelRef,
  type SttEngine,
  type SttOptions,
  type UtteranceOptions,
} from '../types'
import { encodeWav } from './wav'

/**
 * The Whisper family, served by a bundled `whisper.cpp` HTTP server
 * (PLAN §3.1, §6.1).
 *
 * Why a sidecar rather than bindings: whisper.cpp's Metal + Core ML encoder is
 * where the Apple-Silicon performance lives, and a separate process means a
 * model that OOMs or segfaults takes itself down instead of the app. The HTTP
 * API is also our stable seam across whisper.cpp's churn (PLAN §16).
 *
 * ## The request
 *
 * `whisper-server` exposes `POST /inference` as `multipart/form-data` with a
 * `file` part plus form fields. We send 16-bit WAV because that is the format
 * every build reads, ask for `response_format=json`, and pass the Dictionary as
 * `prompt` — whisper.cpp maps that onto `initial_prompt`, which is the biasing
 * hook PLAN §6.4 specifies.
 *
 * ## Failure behaviour
 *
 * A missing binary is the common case on a fresh checkout and on this Linux dev
 * container: `load()` reports `unavailable(binary-missing)` and resolves. It
 * never throws for that, because the orchestrator's job is to turn a
 * not-ready engine into a Bar error, not to catch exceptions.
 */

export const WHISPER_SERVER_BINARY = 'whisper-server'

interface WhisperResponse {
  text?: string
  segments?: { text?: string; avg_logprob?: number }[]
}

export interface WhisperEngineOptions {
  /** `process.resourcesPath` — where packaged binaries live. */
  resourcesPath: string
  /** `app.getAppPath()` — used to find the dev `.sidecars/bin`. */
  appPath: string
  /** Threads for the server; defaults to a conservative 4. */
  threads?: number
  log?: Logger
}

export class WhisperCppEngine implements SttEngine {
  readonly id = 'whisper-cpp' as const

  readonly #status = new StatusHolder(
    EngineStatusSchema.parse({ state: 'idle', engine: 'whisper-cpp' }),
  )
  readonly #options: WhisperEngineOptions
  readonly #log: Logger
  #sidecar: SidecarProcess | null = null
  #model: ModelRef | null = null

  constructor(options: WhisperEngineOptions) {
    this.#options = options
    this.#log = options.log ?? createLogger('stt:whisper')
  }

  status(): EngineStatus {
    return this.#status.get()
  }

  onStatusChange(listener: (status: EngineStatus) => void): () => void {
    return this.#status.subscribe(listener)
  }

  async load(model: ModelRef, options: SttOptions): Promise<void> {
    // Language and dictionary biasing are per-request for whisper-server (they
    // ride on the `/inference` form), so nothing here is cached from `options`.
    void options

    if (this.#model?.modelId === model.modelId && this.#sidecar?.info().state === 'running') {
      // Same model, server already up: nothing to reload.
      return
    }

    await this.unload()
    this.#model = model

    const modelFile = pickModelFile(model)
    if (!modelFile) {
      this.#unavailable('model-missing', `No .bin model file found in ${model.directory}`)
      return
    }

    const { path: binaryPath, searched } = resolveSidecarBinary(
      WHISPER_SERVER_BINARY,
      this.#options.resourcesPath,
      this.#options.appPath,
    )
    if (!binaryPath) {
      const buildHint =
        process.platform === 'win32'
          ? 'Fetch prebuilt binaries with scripts/sidecars/fetch-whisper-win.ps1 (or build with CMake).'
          : 'Build it with scripts/sidecars/build-whisper.sh.'
      this.#unavailable(
        'binary-missing',
        `${WHISPER_SERVER_BINARY} is not installed. Looked in: ${searched.join(', ')}. ${buildHint}`,
      )
      return
    }

    this.#status.set({
      state: 'loading',
      engine: 'whisper-cpp',
      modelId: model.modelId,
      detail: `Loading ${model.modelId}…`,
    })

    const spec: SidecarSpec = {
      name: WHISPER_SERVER_BINARY,
      binaryPath,
      healthPath: '/',
      // whisper.cpp v1.9.x: no --api-key (exits at launch); isolation is loopback.
      // --convert defaults off. Windows prebuilds: prefer CPU.
      buildArgs: ({ port }) => {
        const args = [
          '--host',
          '127.0.0.1',
          '--port',
          String(port),
          '--model',
          join(model.directory, modelFile),
          '--threads',
          String(this.#options.threads ?? 4),
        ]
        if (process.platform === 'win32') args.push('--no-gpu')
        return args
      },
    }

    this.#sidecar = new SidecarProcess(
      spec,
      { onStateChange: (info) => this.#onSidecar(info) },
      this.#log,
    )

    try {
      await this.#sidecar.start()
      this.#status.set({
        state: 'ready',
        engine: 'whisper-cpp',
        modelId: model.modelId,
        detail: `${model.modelId} resident`,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#unavailable('unknown', message)
    }
  }

  async transcribe(pcm: Float32Array, options: UtteranceOptions): Promise<Transcript> {
    const sidecar = this.#sidecar
    const baseUrl = sidecar?.baseUrl
    const token = sidecar?.token
    if (!sidecar || !baseUrl || !token || sidecar.info().state !== 'running') {
      throw new Error(`whisper-server is not ready (${this.#status.get().detail || 'not started'})`)
    }

    const started = Date.now()
    const form = new FormData()
    form.append(
      'file',
      new Blob([encodeWav(pcm, AUDIO.sampleRate)], { type: 'audio/wav' }),
      'utterance.wav',
    )
    form.append('response_format', 'json')
    form.append('temperature', '0')
    if (options.language && options.language !== 'auto') form.append('language', options.language)
    const prompt = buildInitialPrompt(options.vocabulary)
    if (prompt) form.append('prompt', prompt)

    // loopbackFetch refuses a non-loopback base URL outright: if something
    // replaced it, the audio must fail loudly rather than leave the machine
    // (PLAN §10.3).
    const response = await loopbackFetch(`${baseUrl}/inference`, {
      method: 'POST',
      body: form,
      token,
      signal: options.signal ?? AbortSignal.timeout(TIMEOUTS.sidecarRequestMs),
    })

    if (!response.ok) {
      throw new Error(`whisper-server returned ${response.status} ${response.statusText}`)
    }

    const payload = (await response.json()) as WhisperResponse
    const text = (payload.text ?? '').trim()
    const durationMs = Date.now() - started
    this.#log.debug(`transcribed in ${durationMs} ms →`, redact(text))

    return { text, avgLogProb: averageLogProb(payload), durationMs }
  }

  async unload(): Promise<void> {
    const sidecar = this.#sidecar
    this.#sidecar = null
    this.#model = null
    if (sidecar) await sidecar.stop()
    this.#status.set({ state: 'idle', engine: 'whisper-cpp', modelId: null })
  }

  async dispose(): Promise<void> {
    await this.unload()
    this.#status.clearListeners()
  }

  #onSidecar(info: SidecarInfo): void {
    const modelId = this.#model?.modelId ?? null
    switch (info.state) {
      case 'running':
        this.#status.set({
          state: 'ready',
          engine: 'whisper-cpp',
          modelId,
          detail: `${modelId} resident`,
        })
        return
      case 'starting':
        this.#status.set({ state: 'loading', engine: 'whisper-cpp', modelId, detail: 'Starting…' })
        return
      case 'failed':
        this.#status.set({
          state: 'unavailable',
          engine: 'whisper-cpp',
          modelId,
          reason: 'crash-loop',
          detail: info.error ?? 'whisper-server stopped responding',
        })
        return
      case 'stopped':
        this.#status.set({ state: 'idle', engine: 'whisper-cpp', modelId: null })
        return
    }
  }

  #unavailable(reason: EngineUnavailableReason, detail: string): void {
    this.#log.warn(detail)
    this.#status.set({
      state: 'unavailable',
      engine: 'whisper-cpp',
      modelId: this.#model?.modelId ?? null,
      reason,
      detail,
    })
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** The ggml weights file inside a downloaded model directory. */
export function pickModelFile(model: ModelRef): string | null {
  return model.files.find((file) => file.endsWith('.bin')) ?? null
}

/**
 * Turn Dictionary terms into Whisper's `initial_prompt` (PLAN §6.4).
 *
 * Whisper conditions on the prompt as if it were the transcript's preceding
 * context, so a bare comma-separated list of proper nouns is exactly right —
 * an instruction ("please spell X correctly") would be transcribed back at us.
 * Capped so a large dictionary cannot eat the model's context window.
 */
export function buildInitialPrompt(vocabulary: readonly string[], maxChars = 800): string {
  const terms: string[] = []
  let length = 0
  for (const term of vocabulary) {
    const trimmed = term.trim()
    if (!trimmed) continue
    const cost = trimmed.length + 2
    if (length + cost > maxChars) break
    terms.push(trimmed)
    length += cost
  }
  return terms.join(', ')
}

/** Mean of the per-segment `avg_logprob` values whisper.cpp reports. */
export function averageLogProb(payload: WhisperResponse): number | null {
  const values = (payload.segments ?? [])
    .map((segment) => segment.avg_logprob)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
