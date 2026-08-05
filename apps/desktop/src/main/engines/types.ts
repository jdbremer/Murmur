import type { EngineStatus, ModelEngine, Transcript } from '@murmur/shared'

/**
 * The engine seams (PLAN §6.1, §7.1).
 *
 * Both interfaces obey the same three rules, which is what lets the
 * orchestrator treat "whisper-server is missing" and "the ONNX runtime did not
 * install" identically:
 *
 *  1. `load` / `unload` are idempotent and never throw for a *foreseeable*
 *     problem — they record it in `status()` instead.
 *  2. `transcribe` / `polish` reject only for genuine runtime failures, and the
 *     caller always has a timeout around them.
 *  3. `status()` is synchronous and cheap; `onStatusChange` pushes the same
 *     value whenever it moves, so the Hub never polls.
 */

/** Where a model's files live on disk, plus what the engine needs to know. */
export interface ModelRef {
  /** Catalog (or imported) id — the key everything else is keyed on. */
  modelId: string
  engine: ModelEngine
  /** Absolute directory holding the model's files. */
  directory: string
  /**
   * File names inside `directory`, in catalog order. Engines pick what they
   * need by extension/name rather than by index.
   */
  files: readonly string[]
}

export interface SttOptions {
  /** BCP-47-ish tag, or `auto` where the model detects language itself. */
  language: string
  /**
   * Dictionary terms, fed to Whisper as `initial_prompt` (PLAN §6.4). The ONNX
   * path ignores them today — biasing there is backlogged (PLAN §18.12).
   */
  vocabulary: readonly string[]
}

export interface UtteranceOptions {
  language: string
  vocabulary: readonly string[]
  /** Aborts an in-flight request when the user cancels. */
  signal?: AbortSignal
}

export type StatusListener = (status: EngineStatus) => void

export interface SttEngine {
  readonly id: ModelEngine
  /** Make `model` resident. Safe to call with the model already loaded. */
  load(model: ModelRef, options: SttOptions): Promise<void>
  transcribe(pcm: Float32Array, options: UtteranceOptions): Promise<Transcript>
  unload(): Promise<void>
  status(): EngineStatus
  onStatusChange(listener: StatusListener): () => void
  /** Release every OS resource. Called once, on app quit. */
  dispose(): Promise<void>
}

export interface PolishRequest {
  systemPrompt: string
  /** The few-shot pairs the prompt builder produced, oldest first. */
  examples: readonly { user: string; assistant: string }[]
  userText: string
  maxTokens: number
  signal?: AbortSignal
}

export interface PolishResult {
  text: string
  durationMs: number
}

export interface PolishEngine {
  readonly id: ModelEngine | 'external'
  load(model: ModelRef | null, options: { modelId: string }): Promise<void>
  polish(request: PolishRequest): Promise<PolishResult>
  unload(): Promise<void>
  status(): EngineStatus
  onStatusChange(listener: StatusListener): () => void
  dispose(): Promise<void>
}

/**
 * Small helper every engine uses so `status()` and `onStatusChange` cannot
 * drift apart: mutate through `set`, read through `get`.
 */
export class StatusHolder {
  #status: EngineStatus
  readonly #listeners = new Set<StatusListener>()

  constructor(initial: EngineStatus) {
    this.#status = initial
  }

  get(): EngineStatus {
    return { ...this.#status, warnings: [...this.#status.warnings] }
  }

  set(next: Partial<EngineStatus> & Pick<EngineStatus, 'state'>): EngineStatus {
    this.#status = {
      engine: next.engine ?? this.#status.engine,
      state: next.state,
      modelId: next.modelId === undefined ? this.#status.modelId : next.modelId,
      // A state change clears the previous reason unless a new one is given.
      reason: next.reason === undefined ? null : next.reason,
      detail: next.detail ?? '',
      warnings: next.warnings ?? [],
    }
    const snapshot = this.get()
    for (const listener of this.#listeners) listener(snapshot)
    return snapshot
  }

  subscribe(listener: StatusListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  clearListeners(): void {
    this.#listeners.clear()
  }
}
