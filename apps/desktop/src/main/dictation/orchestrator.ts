import { EventEmitter } from 'node:events'

import type {
  AppCategory,
  DictationErrorCode,
  DictationRecord,
  DictionaryEntry,
  PolishingLevel,
  StyleProfile,
  Transcript,
} from '@murmur/shared'

import { AUDIO, TIMEOUTS } from '../config'
import { createLogger, redact, type Logger } from '../logging'
import { SilenceTracker, trimSilence } from '../audio/vad'
import { PreRollBuffer, UtteranceBuffer } from '../audio/buffer'
import {
  buildPolishPrompt,
  checkPolishOutput,
  maxOutputTokens,
  shouldSkipPolish,
} from '../engines/polish/prompt'
import type { PolishEngine, SttEngine } from '../engines/types'
import { categoryForBundleId } from './app-category'
import type { InjectionResult, TextInjector } from './injector'
import type { DictationStateMachine } from './state-machine'

/**
 * The dictation loop (PLAN §3.2), and the thing PLAN §15.1 means by "the state
 * machine returns to a safe idle on every failure path — no dead ends".
 *
 * ```
 *  idle ──hotkey down──▶ listening ──hotkey up──▶ processing(transcribing)
 *    ▲                       │                          │
 *    │                       │ Esc / cancel             │ polish enabled
 *    │                       ▼                          ▼
 *    └──────────────────── error ◀──────────── processing(polishing)
 *    ▲                                                  │
 *    └──── inserted ◀──── inserting ◀───────────────────┘
 * ```
 *
 * Design rules this file exists to enforce:
 *
 *  - **Every stage has a timeout** ({@link TIMEOUTS}) and every timeout ends in
 *    a typed error state, never a hang.
 *  - **Every `catch` reaches `#fail`**, which emits an error event *and* returns
 *    to idle. There is deliberately no path that leaves the machine in
 *    `processing`.
 *  - **Cancellation is immediate and idempotent.** `cancel()` aborts the
 *    in-flight engine request, drops the audio, and resets — from any state,
 *    including when nothing is running.
 *  - **A polish failure is not a dictation failure.** If polishing throws, or
 *    the hallucination guard fires, the raw transcript is inserted and the
 *    history row records that (PLAN §7.4).
 *
 * Everything the loop depends on is injected, so the whole transition table is
 * unit-testable with fake engines and fake timers — no Electron, no audio, no
 * models.
 */

export interface OrchestratorDeps {
  machine: DictationStateMachine
  /** Resolves the currently-selected STT engine, or `null` when none is ready. */
  stt(): SttEngine | null
  /** Resolves the polish engine, or `null` when polishing is off/unavailable. */
  polish(): PolishEngine | null
  injector: Pick<TextInjector, 'precheck' | 'insert'>
  /** Starts/stops the hidden capture renderer. */
  audio: AudioController
  /** Current settings snapshot, read fresh at the start of each utterance. */
  settings(): OrchestratorSettings
  /** Enabled dictionary entries, for biasing and the polish prompt. */
  dictionary(): readonly DictionaryEntry[]
  /**
   * Post-STT replacement rules (PLAN §6.4). Runs on the raw transcript before
   * polishing, so the polish prompt sees the corrected spelling.
   */
  applyDictionary(text: string): string
  /** Tone profile for an app category. */
  styleFor(category: AppCategory): StyleProfile
  /** Frontmost app at hotkey-down. `null` on non-macOS or when unknown. */
  frontmostApp(): { bundleId: string; name: string } | null
  /** Persists a finished dictation. Failures here must not break the loop. */
  persist(record: Omit<DictationRecord, 'id'>): void
  /** High-rate mic level for the Bar's waveform. */
  onLevel?(level: number): void
  /**
   * Clear a stuck OS hotkey latch (Ctrl+Space Space key) after a failed begin.
   * Optional — tests omit it.
   */
  releaseHotkeyLatch?(): void
  log?: Logger
  /** Injected for tests. */
  now?(): number
}

export interface OrchestratorSettings {
  language: string
  polishingLevel: PolishingLevel
  sttModelId: string | null
  polishModelId: string | null
  micDeviceId: string | null
}

export interface AudioController {
  /** Open the mic and begin streaming frames. */
  start(deviceId: string | null): void
  /** Stop streaming; the stream stays warm. */
  stop(): void
  /** Keep the stream open but drop frames (PLAN §5 pre-roll). */
  warm(deviceId: string | null): void
  /** Close the stream entirely. */
  release(): void
}

export interface OrchestratorEvents {
  /** Emitted when a dictation completes successfully. */
  completed: [DictationRecord]
}

type Phase = 'idle' | 'listening' | 'transcribing' | 'polishing' | 'inserting'

export class DictationOrchestrator extends EventEmitter<OrchestratorEvents> {
  readonly #deps: OrchestratorDeps
  readonly #log: Logger
  readonly #now: () => number

  readonly #buffer = new UtteranceBuffer()
  readonly #preRoll = new PreRollBuffer()
  #silence = new SilenceTracker(AUDIO.sampleRate)

  #phase: Phase = 'idle'
  #handsFree = false
  #abort: AbortController | null = null
  #stageTimer: NodeJS.Timeout | null = null
  #context: UtteranceContext | null = null
  /** Guards against a second `finish()` from a racing hotkey-up + auto-finalise. */
  #finishing = false
  /**
   * Bumped by `cancel()` and by `#fail()`. `#finish()` captures it at the start
   * and re-checks after every `await`, which is how a late engine rejection
   * from a *superseded* run is told apart from one that is still live.
   *
   * The distinction matters: a timeout aborts the shared controller before it
   * rejects, so "the signal is aborted" alone cannot mean "the user cancelled".
   * Treating those the same is precisely how a loop ends up stuck in
   * `processing` with no error — the dead end PLAN §15.1 forbids.
   */
  #runId = 0

  constructor(deps: OrchestratorDeps) {
    super()
    this.#deps = deps
    this.#log = deps.log ?? createLogger('dictation')
    this.#now = deps.now ?? (() => Date.now())
  }

  get phase(): Phase {
    return this.#phase
  }

  get handsFree(): boolean {
    return this.#handsFree
  }

  // -- entry points --------------------------------------------------------

  /** Hotkey pressed (or hands-free started). */
  begin(options: { handsFree?: boolean } = {}): void {
    if (this.#phase !== 'idle') {
      // A second down while busy is a stuck key or a race. Ignore it rather
      // than tearing down an utterance the user is in the middle of.
      this.#log.debug(`ignoring begin() while ${this.#phase}`)
      return
    }

    const settings = this.#deps.settings()

    // Capture the target *now* (PLAN §3.2 / §4): by the time text is ready the
    // frontmost app may have changed, and the tone must match where the user
    // was speaking into.
    const frontmost = this.#deps.frontmostApp()
    const category = categoryForBundleId(frontmost?.bundleId ?? null)

    // Refuse before recording rather than after transcribing.
    const precheck = this.#deps.injector.precheck()
    if (!precheck.ok && precheck.reason === 'secure-input') {
      this.#fail('secure-input', precheck.message)
      return
    }
    if (!precheck.ok && precheck.reason === 'elevated-target') {
      // Surface as insert-failed with the UIPI next-action message (G9).
      this.#fail('insert-failed', precheck.message)
      return
    }

    const stt = this.#deps.stt()
    if (!stt) {
      this.#fail('stt-failed', 'No speech-to-text model is ready. Pick one in the Hub.')
      return
    }
    const status = stt.status()
    if (status.state !== 'ready') {
      this.#fail('stt-failed', status.detail || 'The speech-to-text engine is not ready.')
      return
    }

    this.#handsFree = options.handsFree ?? false
    this.#finishing = false
    this.#context = {
      startedAt: this.#now(),
      frontmostBundleId: frontmost?.bundleId ?? null,
      category,
      settings,
      sttModelId: settings.sttModelId ?? status.modelId ?? 'unknown',
    }

    this.#buffer.clear()
    this.#silence = new SilenceTracker(AUDIO.sampleRate)
    // Prepend the warm pre-roll so the first syllables are not clipped.
    const preRoll = this.#preRoll.snapshot()
    if (preRoll.length > 0) this.#buffer.push(preRoll)
    this.#preRoll.clear()

    this.#phase = 'listening'
    this.#deps.audio.start(settings.micDeviceId)
    this.#deps.machine.startListening(this.#handsFree)
    this.#armStage(TIMEOUTS.captureStartMs + AUDIO.maxUtteranceMs, 'listening')
  }

  /** Hotkey released. In hands-free mode this is a no-op (VAD finalises). */
  end(): void {
    if (this.#phase !== 'listening') return
    if (this.#handsFree) return
    void this.#finish()
  }

  /** Latch hands-free mode (double-tap). */
  startHandsFree(): void {
    if (this.#phase === 'listening') {
      this.#handsFree = true
      this.#deps.machine.startListening(true)
      return
    }
    if (this.#phase === 'idle') this.begin({ handsFree: true })
  }

  /** Leave hands-free mode, finalising whatever has been said so far. */
  stopHandsFree(): void {
    if (!this.#handsFree) return
    this.#handsFree = false
    if (this.#phase === 'listening') void this.#finish()
  }

  /**
   * Cancel from any state (Esc, tray pause, quit). Idempotent.
   *
   * `emitError` is false for a deliberate user cancel — the Bar should just
   * close, not flash "cancelled" at someone who pressed Escape on purpose.
   */
  cancel(options: { emitError?: boolean; message?: string } = {}): void {
    const wasBusy = this.#phase !== 'idle'
    this.#runId += 1
    this.#abort?.abort()
    this.#abort = null
    this.#clearStage()
    this.#buffer.clear()
    this.#preRoll.clear()
    this.#context = null
    this.#handsFree = false
    this.#finishing = false
    this.#phase = 'idle'
    this.#deps.audio.stop()
    try {
      this.#deps.releaseHotkeyLatch?.()
    } catch {
      /* ignore */
    }

    if (!wasBusy) {
      this.#deps.machine.reset()
      return
    }

    if (options.emitError) {
      this.#deps.machine.fail('cancelled', options.message ?? 'Cancelled')
    } else {
      this.#deps.machine.reset()
    }
  }

  /** One PCM frame from the capture renderer. */
  pushFrame(frame: Float32Array): void {
    const level = this.#deps.onLevel ? levelOf(frame) : 0
    this.#deps.onLevel?.(level)

    if (this.#phase !== 'listening') {
      // Between utterances the mic stays warm; keep the rolling pre-roll fresh.
      this.#preRoll.push(frame)
      return
    }

    const accepted = this.#buffer.push(frame)
    this.#silence.push(frame)

    if (!accepted && this.#buffer.capped) {
      this.#log.info('utterance hit the length cap; finalising')
      void this.#finish()
      return
    }

    if (this.#handsFree && this.#silence.shouldFinalise(AUDIO.handsFreeSilenceMs)) {
      this.#log.debug('hands-free auto-finalise on trailing silence')
      void this.#finish()
    }
  }

  /** The capture renderer could not open the mic. */
  reportAudioError(message: string): void {
    if (this.#phase === 'idle') return
    this.#fail('mic-unavailable', message)
  }

  /** Release timers and in-flight work. Called on quit. */
  dispose(): void {
    this.cancel()
    this.removeAllListeners()
  }

  // -- the pipeline --------------------------------------------------------

  async #finish(): Promise<void> {
    if (this.#finishing || this.#phase !== 'listening') return
    this.#finishing = true

    const context = this.#context
    if (!context) {
      this.cancel()
      return
    }

    this.#runId += 1
    const runId = this.#runId

    this.#clearStage()
    this.#deps.audio.stop()

    const pcm = this.#buffer.drain()
    const durationMs = Math.round((pcm.length * 1000) / AUDIO.sampleRate)

    // Guard 1: nothing was recorded at all.
    if (durationMs < AUDIO.minUtteranceMs) {
      this.#log.debug(`utterance too short (${durationMs} ms)`)
      this.#fail('no-speech', 'Didn’t catch that')
      return
    }

    // Guard 2: VAD found no speech in what was recorded.
    const trimmed = trimSilence(pcm, AUDIO.sampleRate)
    if (trimmed.silent || trimmed.pcm.length === 0) {
      this.#log.debug('VAD found no speech')
      this.#fail('no-speech', 'Didn’t catch that')
      return
    }
    const speechMs = Math.round((trimmed.pcm.length * 1000) / AUDIO.sampleRate)
    if (speechMs < AUDIO.minUtteranceMs) {
      this.#fail('no-speech', 'Didn’t catch that')
      return
    }

    this.#abort = new AbortController()
    const { signal } = this.#abort

    // -- STT ---------------------------------------------------------------
    this.#phase = 'transcribing'
    this.#deps.machine.startProcessing('transcribing')

    let transcript: Transcript
    try {
      transcript = await this.#withTimeout(
        TIMEOUTS.sttMs,
        'transcribing',
        (async () => {
          const stt = this.#deps.stt()
          if (!stt) throw new Error('The speech-to-text engine went away mid-utterance.')
          return stt.transcribe(trimmed.pcm, {
            language: context.settings.language,
            vocabulary: this.#deps.dictionary().map((entry) => entry.term),
            signal,
          })
        })(),
      )
    } catch (error) {
      // Superseded by a cancel: that path already reset the machine.
      if (this.#runId !== runId) return
      this.#fail(
        error instanceof StageTimeoutError ? 'timeout' : 'stt-failed',
        describe(error, 'Transcription failed'),
      )
      return
    }
    if (this.#runId !== runId) return

    // Dictionary replacements run here, before polishing (PLAN §6.4), so the
    // history row and the polish prompt both see the corrected spelling.
    const rawText = this.#deps.applyDictionary(transcript.text.trim()).trim()
    if (rawText.length === 0) {
      this.#fail('no-speech', 'Didn’t catch that')
      return
    }
    this.#log.debug(`transcript ${redact(rawText)} in ${transcript.durationMs} ms`)

    // -- polish (skippable) ------------------------------------------------
    let polishedText: string | null = null
    let polishMs = 0
    let polishModelId: string | null = null

    const level = context.settings.polishingLevel
    const polishEngine = this.#deps.polish()

    if (polishEngine && !shouldSkipPolish(rawText, level) && level !== 'off') {
      const status = polishEngine.status()
      if (status.state === 'ready') {
        this.#phase = 'polishing'
        this.#deps.machine.startProcessing('polishing')
        polishModelId = context.settings.polishModelId ?? status.modelId

        try {
          const prompt = buildPolishPrompt({
            level,
            profile: this.#deps.styleFor(context.category),
            dictionary: this.#deps.dictionary(),
            language: context.settings.language,
          })
          const result = await this.#withTimeout(
            TIMEOUTS.polishMs,
            'polishing',
            polishEngine.polish({
              systemPrompt: prompt.systemPrompt,
              examples: prompt.examples,
              userText: rawText,
              maxTokens: maxOutputTokens(rawText),
              signal,
            }),
          )
          polishMs = result.durationMs

          // The hallucination guard (PLAN §7.4): a wild length change means the
          // model did something other than edit. Keep the raw transcript.
          const verdict = checkPolishOutput(rawText, result.text)
          if (verdict.ok) {
            polishedText = result.text.trim()
          } else {
            this.#log.warn(`polish output rejected (${verdict.reason}: ${verdict.detail})`)
            polishedText = null
          }
        } catch (error) {
          if (this.#runId !== runId) return
          // A polish failure must not lose the transcript (PLAN §7.4).
          this.#log.warn('polish failed; inserting the raw transcript:', error)
          polishedText = null
        }
      }
    }

    const finalText = polishedText ?? rawText

    // -- insert ------------------------------------------------------------
    this.#phase = 'inserting'
    this.#deps.machine.startInserting()

    let injection: InjectionResult
    try {
      injection = await this.#withTimeout(
        TIMEOUTS.insertMs,
        'inserting',
        Promise.resolve(this.#deps.injector.insert(finalText)),
      )
    } catch (error) {
      if (this.#runId !== runId) return
      this.#fail(
        error instanceof StageTimeoutError ? 'timeout' : 'insert-failed',
        describe(error, 'Could not insert the text'),
      )
      return
    }

    if (this.#runId !== runId) return
    if (!injection.ok) {
      const code: DictationErrorCode =
        injection.reason === 'secure-input' ? 'secure-input' : 'insert-failed'
      this.#fail(code, injection.error ?? 'Could not insert the text')
      return
    }

    // -- persist -----------------------------------------------------------
    const totalMs = this.#now() - context.startedAt
    const record: Omit<DictationRecord, 'id'> = {
      ts: context.startedAt,
      rawText,
      polishedText,
      appBundleId: context.frontmostBundleId,
      appCategory: context.category,
      durationMs,
      sttModelId: context.sttModelId,
      polishModelId,
      timings: { sttMs: transcript.durationMs, polishMs, totalMs },
    }

    try {
      this.#deps.persist(record)
    } catch (error) {
      // A history write must never cost the user their insertion, which has
      // already happened by this point.
      this.#log.error('could not persist the history row:', error)
    }

    this.#abort = null
    this.#context = null
    this.#phase = 'idle'
    this.#finishing = false
    this.#deps.machine.finishInserted(
      finalText.length,
      injection.method === 'accessibility' ? 'accessibility' : 'paste',
    )
    this.emit('completed', { ...record, id: '' })
  }

  // -- helpers -------------------------------------------------------------

  /**
   * Race a stage against its timeout. On timeout the shared abort controller
   * fires, so the engine's in-flight HTTP request is cancelled rather than left
   * to finish into a void.
   */
  async #withTimeout<T>(ms: number, stage: string, work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.#abort?.abort()
        reject(new StageTimeoutError(stage, ms))
      }, ms)
      timer.unref?.()
    })

    try {
      return await Promise.race([work, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Watchdog for the listening phase, which has no promise to race. */
  #armStage(ms: number, stage: string): void {
    this.#clearStage()
    this.#stageTimer = setTimeout(() => {
      this.#log.warn(`${stage} exceeded ${ms} ms; finalising`)
      if (this.#phase === 'listening') void this.#finish()
      else this.#fail('timeout', 'That took too long — try again')
    }, ms)
    this.#stageTimer.unref?.()
  }

  #clearStage(): void {
    if (this.#stageTimer) clearTimeout(this.#stageTimer)
    this.#stageTimer = null
  }

  /**
   * The single exit for every failure path.
   *
   * Emits a typed error event and returns to idle, unconditionally. If you are
   * adding a `catch` to this file and it does not end here, the state machine
   * has a dead end.
   */
  #fail(code: DictationErrorCode, message: string): void {
    this.#log.warn(`failed: ${code} — ${message}`)
    this.#runId += 1
    this.#abort?.abort()
    this.#abort = null
    this.#clearStage()
    this.#buffer.clear()
    this.#context = null
    this.#handsFree = false
    this.#finishing = false
    this.#phase = 'idle'
    this.#deps.audio.stop()
    // If the user is still holding Space from Ctrl+Space, do not keep swallowing
    // Space key-ups (that sticks the key in other apps).
    try {
      this.#deps.releaseHotkeyLatch?.()
    } catch {
      /* ignore */
    }
    this.#deps.machine.fail(code, message)
  }
}

interface UtteranceContext {
  startedAt: number
  frontmostBundleId: string | null
  category: AppCategory
  settings: OrchestratorSettings
  sttModelId: string
}

export class StageTimeoutError extends Error {
  override readonly name = 'StageTimeoutError'
  readonly stage: string
  constructor(stage: string, ms: number) {
    super(`${stage} timed out after ${ms} ms`)
    this.stage = stage
  }
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof StageTimeoutError) return 'That took too long — try again'
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/** Cheap RMS→0..1 level, duplicated from the VAD so the hot path stays allocation-free. */
function levelOf(frame: Float32Array): number {
  let sum = 0
  for (let index = 0; index < frame.length; index += 1) {
    const sample = frame[index] ?? 0
    sum += sample * sample
  }
  const rms = Math.sqrt(sum / Math.max(1, frame.length))
  const db = 20 * Math.log10(Math.max(rms, 1e-10))
  return Math.min(1, Math.max(0, (db + 60) / 60))
}
