import { EngineStatusSchema, type EngineStatus, type ExternalEndpoint } from '@murmur/shared'

import { createLogger, type Logger } from '../../logging'
import {
  StatusHolder,
  type EngineChatEnd,
  type EngineChatRequest,
  type PolishEngine,
  type PolishRequest,
  type PolishResult,
} from '../types'
import { ChatClient, classifyEndpoint, endpointWarnings } from './client'
import { unwrapModelOutput } from './prompt'

/**
 * Polishing against a user-supplied OpenAI-compatible endpoint (PLAN §7.1).
 *
 * Same {@link ChatClient} as the bundled `llama-server`, different base URL —
 * that is the whole implementation, and it is why "use my company's LM Studio
 * box" was never a feature that needed building twice.
 *
 * What this class *adds* is honesty about where the text goes. PLAN §7.1 says
 * the app warns when the endpoint is not loopback or RFC-1918; that warning is
 * computed on every `load()` and carried in `EngineStatus.warnings`, so the
 * Hub can show it before the user dictates and not after. Nothing is blocked —
 * a company vLLM box on 10.x is a legitimate deployment — but "local-only" stops
 * being claimed silently.
 *
 * There is no health check: an endpoint that is down surfaces as a failed
 * polish, which already falls back to the raw transcript (PLAN §7.4).
 */
export class ExternalPolishEngine implements PolishEngine {
  readonly id = 'external' as const

  readonly #status = new StatusHolder(EngineStatusSchema.parse({ state: 'idle', engine: null }))
  readonly #log: Logger
  #endpoint: ExternalEndpoint | null = null

  constructor(options: { endpoint: ExternalEndpoint; log?: Logger }) {
    this.#endpoint = options.endpoint
    this.#log = options.log ?? createLogger('polish:external')
  }

  status(): EngineStatus {
    return this.#status.get()
  }

  onStatusChange(listener: (status: EngineStatus) => void): () => void {
    return this.#status.subscribe(listener)
  }

  async load(_model: null, options: { modelId: string }): Promise<void> {
    void _model
    const endpoint = this.#endpoint
    if (!endpoint) {
      this.#status.set({
        state: 'unavailable',
        modelId: options.modelId,
        reason: 'no-model-selected',
        detail: 'No external endpoint configured.',
      })
      return
    }

    const warnings = endpointWarnings(endpoint.baseUrl)
    for (const warning of warnings) this.#log.warn(warning)

    this.#status.set({
      state: 'ready',
      engine: null,
      modelId: endpoint.model,
      detail: `External endpoint (${classifyEndpoint(endpoint.baseUrl)})`,
      warnings,
    })
    return Promise.resolve()
  }

  async polish(request: PolishRequest): Promise<PolishResult> {
    const endpoint = this.#endpoint
    if (!endpoint) throw new Error('No external polish endpoint configured')

    const started = Date.now()
    const client = new ChatClient({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: endpoint.model,
      // A user-supplied endpoint may legitimately be non-loopback (PLAN §7.1);
      // the warning for that ships in this engine's status, not in the client.
      fetchImpl: (url, init) => globalThis.fetch(url, init),
    })
    const completion = await client.complete(request)
    const text = unwrapModelOutput(completion.text)
    return { text, durationMs: Date.now() - started, truncated: completion.truncated }
  }

  /**
   * Stream a chat answer (PLAN §2.2.9).
   *
   * No gate here, unlike the bundled server. That is not an oversight: the
   * `--parallel 1` slot Ask has to be scheduled around is a property of *our*
   * sidecar, and an LM Studio or vLLM endpoint serves concurrent requests
   * perfectly well. Adding a gate anyway would serialise a server that does not
   * need it and make dictation wait behind chat on exactly the deployments
   * where it never had to.
   */
  async *streamChat(request: EngineChatRequest): AsyncGenerator<string, EngineChatEnd> {
    const endpoint = this.#endpoint
    if (!endpoint) throw new Error('No external polish endpoint configured')

    const client = new ChatClient({
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: endpoint.model,
      fetchImpl: (url, init) => globalThis.fetch(url, init),
    })
    return yield* client.stream(request)
  }

  async unload(): Promise<void> {
    this.#status.set({ state: 'idle', engine: null, modelId: null })
    return Promise.resolve()
  }

  async dispose(): Promise<void> {
    this.#endpoint = null
    this.#status.clearListeners()
    return Promise.resolve()
  }
}
