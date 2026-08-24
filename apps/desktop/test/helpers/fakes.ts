import { vi } from 'vitest'

import {
  EngineStatusSchema,
  StyleProfileSchema,
  type DictionaryEntry,
  type Snippet,
  type EngineStatus,
  type StyleProfile,
  type Transcript,
} from '@murmur/shared'

import type {
  PolishEngine,
  PolishRequest,
  PolishResult,
  SttEngine,
} from '../../src/main/engines/types'
import type {
  AudioController,
  OrchestratorDeps,
  OrchestratorSettings,
} from '../../src/main/dictation/orchestrator'
import type { InjectionResult } from '../../src/main/dictation/injector'
import { DictationStateMachine } from '../../src/main/dictation/state-machine'
import { createNullLogger } from '../../src/main/logging'

/**
 * Doubles for everything the orchestrator depends on.
 *
 * Each one is a *controllable* fake rather than a mock: a test says "transcribe
 * hangs" or "polish throws" and then drives the clock, which is the only way to
 * exercise the timeout and cancellation paths PLAN §15.1 cares about.
 */

export class FakeSttEngine implements SttEngine {
  readonly id = 'whisper-cpp' as const

  status_: EngineStatus = EngineStatusSchema.parse({
    state: 'ready',
    engine: 'whisper-cpp',
    modelId: 'fake-stt',
  })
  /** Resolved transcript, unless `transcribeImpl` is set. */
  transcript: Transcript = { text: 'hello world this is a test', avgLogProb: -0.2, durationMs: 12 }
  transcribeImpl: ((pcm: Float32Array, signal?: AbortSignal) => Promise<Transcript>) | null = null
  readonly transcribeCalls: Float32Array[] = []

  async load(): Promise<void> {}

  async transcribe(pcm: Float32Array, options: { signal?: AbortSignal }): Promise<Transcript> {
    this.transcribeCalls.push(pcm)
    if (this.transcribeImpl) return this.transcribeImpl(pcm, options.signal)
    return this.transcript
  }

  async unload(): Promise<void> {}
  status(): EngineStatus {
    return this.status_
  }
  onStatusChange(): () => void {
    return () => undefined
  }
  async dispose(): Promise<void> {}

  /** Never resolves until the request is aborted — the timeout test's engine. */
  hang(): void {
    this.transcribeImpl = (_pcm, signal) =>
      new Promise<Transcript>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
  }
}

export class FakePolishEngine implements PolishEngine {
  readonly id = 'llama-cpp' as const

  status_: EngineStatus = EngineStatusSchema.parse({
    state: 'ready',
    engine: 'llama-cpp',
    modelId: 'fake-polish',
  })
  result: PolishResult = { text: 'Hello world, this is a test.', durationMs: 8 }
  polishImpl: ((request: PolishRequest) => Promise<PolishResult>) | null = null
  readonly requests: PolishRequest[] = []

  async load(): Promise<void> {}

  async polish(request: PolishRequest): Promise<PolishResult> {
    this.requests.push(request)
    if (this.polishImpl) return this.polishImpl(request)
    return this.result
  }

  async unload(): Promise<void> {}
  status(): EngineStatus {
    return this.status_
  }
  onStatusChange(): () => void {
    return () => undefined
  }
  async dispose(): Promise<void> {}
}

export class FakeAudioController implements AudioController {
  readonly calls: string[] = []
  start(): void {
    this.calls.push('start')
  }
  stop(): void {
    this.calls.push('stop')
  }
  warm(): void {
    this.calls.push('warm')
  }
  release(): void {
    this.calls.push('release')
  }
}

export interface OrchestratorHarness {
  machine: DictationStateMachine
  stt: FakeSttEngine
  polish: FakePolishEngine
  audio: FakeAudioController
  deps: OrchestratorDeps
  settings: OrchestratorSettings
  insertResult: { current: InjectionResult }
  precheckResult: {
    current: { ok: true } | { ok: false; reason: 'secure-input'; message: string }
  }
  persisted: Parameters<OrchestratorDeps['persist']>[0][]
  /** The fix counts handed to `persist`, index-aligned with `persisted`. */
  persistedFixes: Parameters<OrchestratorDeps['persist']>[1][]
  events: { state: string; code?: string }[]
  insertedText: string[]
  /** Mutable: push a Snippet and the next utterance expands it. */
  snippets: Snippet[]
  /** Set to make `persist` throw, so the "history write must not break" path runs. */
  persistThrows: { current: boolean }
}

export function createHarness(overrides: Partial<OrchestratorSettings> = {}): OrchestratorHarness {
  const machine = new DictationStateMachine({ log: () => undefined })
  const stt = new FakeSttEngine()
  const polish = new FakePolishEngine()
  const audio = new FakeAudioController()

  const settings: OrchestratorSettings = {
    language: 'en',
    polishingLevel: 'clean',
    sttModelId: 'fake-stt',
    polishModelId: 'fake-polish',
    micDeviceId: null,
    ...overrides,
  }

  const insertResult = { current: { ok: true, method: 'paste' } as InjectionResult }
  const precheckResult: OrchestratorHarness['precheckResult'] = { current: { ok: true } }
  const persisted: Parameters<OrchestratorDeps['persist']>[0][] = []
  const persistedFixes: Parameters<OrchestratorDeps['persist']>[1][] = []
  const insertedText: string[] = []
  const events: { state: string; code?: string }[] = []
  const persistThrows = { current: false }

  machine.on('event', (event) => {
    events.push(
      event.state === 'error' ? { state: 'error', code: event.code } : { state: event.state },
    )
  })

  const dictionary: DictionaryEntry[] = []
  const snippets: Snippet[] = []
  const profile: StyleProfile = StyleProfileSchema.parse({ category: 'work' })

  const deps: OrchestratorDeps = {
    machine,
    stt: () => stt,
    polish: () => polish,
    injector: {
      precheck: () => precheckResult.current,
      insert: vi.fn((text: string) => {
        insertedText.push(text)
        return insertResult.current
      }),
    },
    audio,
    settings: () => settings,
    dictionary: () => dictionary,
    applyDictionary: (text) => ({ text, replacements: 0 }),
    // Mutable so a test can push a snippet and re-run an utterance.
    snippets: () => snippets,
    styleFor: () => profile,
    frontmostApp: () => ({ bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' }),
    // An empty field, which is what "a dictation" means in most of these
    // tests. Left absent it reads as `null` — "the platform cannot see the
    // cursor" — which is a real state worth testing, but a different one, and
    // it drags the spacing fallback into every unrelated assertion.
    textBeforeCursor: () => '',
    persist: (record, fixes) => {
      if (persistThrows.current) throw new Error('disk full')
      persisted.push(record)
      persistedFixes.push(fixes)
    },
    log: createNullLogger(),
  }

  return {
    machine,
    stt,
    polish,
    audio,
    deps,
    settings,
    insertResult,
    precheckResult,
    persisted,
    persistedFixes,
    events,
    insertedText,
    snippets,
    persistThrows,
  }
}
