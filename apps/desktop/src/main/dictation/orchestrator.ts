import { EventEmitter } from 'node:events'

import {
  expandSnippets,
  type AppCategory,
  type DictationErrorCode,
  type DictationRecord,
  type DictionaryEntry,
  type PolishingLevel,
  type Snippet,
  type StyleProfile,
  type Transcript,
} from '@murmur/shared'

import { AUDIO, TIMEOUTS } from '../config'
import { createLogger, redact, type Logger } from '../logging'
import { SilenceTracker, trimSilence } from '../audio/vad'
import { PreRollBuffer, UtteranceBuffer } from '../audio/buffer'
import {
  buildCommandPrompt,
  buildPolishPrompt,
  checkCommandOutput,
  checkPolishOutput,
  maxCommandOutputTokens,
  maxOutputTokens,
  shouldSkipPolish,
} from '../engines/polish/prompt'
import type { PolishEngine, SttEngine } from '../engines/types'
import { categoryForBundleId, isMessagingApp } from './app-category'
import { applySentenceCase } from './sentence-case'
import { stripTrailingPeriod } from './trailing-period'
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
  /**
   * Enabled voice shortcuts. Expanded *after* polishing (domain/snippet.ts), so
   * unlike the dictionary this is a list rather than a transform — the
   * orchestrator owns where it runs.
   */
  snippets(): readonly Snippet[]
  /** Tone profile for an app category. */
  styleFor(category: AppCategory): StyleProfile
  /** Frontmost app at hotkey-down. `null` on non-macOS or when unknown. */
  frontmostApp(): { bundleId: string; name: string } | null
  /**
   * The focused element's selected text at hotkey-down, or `null` when there
   * is none (or command mode is disabled). A non-empty selection flips the
   * utterance into command mode (PLAN §18.1): the speech becomes an edit
   * instruction and the result replaces the selection.
   */
  selection?(): string | null
  /**
   * The few characters before the insertion point at hotkey-down, or `null`
   * when unreadable. Feeds sentence-case.ts, which decides whether the text is
   * continuing an existing sentence and should not arrive capitalised.
   */
  textBeforeCursor?(): string | null
  /** Persists a finished dictation. Failures here must not break the loop. */
  persist(record: Omit<DictationRecord, 'id'>): void
  /** High-rate mic level for the Bar's waveform. */
  onLevel?(level: number): void
  /**
   * Clear a stuck OS hotkey latch (e.g. Space after a failed begin on Windows).
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

    // Read the selection *now*, not at insert time: it is the thing the user
    // was pointing at when they pressed the key, and reading it later would
    // race their own click-away. Two gates before the AX read even happens:
    // hands-free never enters command mode (a latched session over a selection
    // would edit it on every silence-finalise), and command mode requires a
    // *ready* polish engine — with polishing off or no model, dictating over a
    // selection must stay plain dictation, which pastes over it exactly the
    // way typing would. Erroring there would turn a everyday habit into lost
    // speech.
    const handsFree = options.handsFree ?? false
    const polishReady = (() => {
      const engine = this.#deps.polish()
      return engine !== null && engine.status().state === 'ready'
    })()
    const selection = handsFree || !polishReady ? null : (this.#deps.selection?.() ?? null)

    this.#handsFree = handsFree
    this.#finishing = false
    this.#context = {
      startedAt: this.#now(),
      frontmostBundleId: frontmost?.bundleId ?? null,
      category,
      settings,
      sttModelId: settings.sttModelId ?? status.modelId ?? 'unknown',
      mode: selection ? 'command' : 'dictate',
      selection,
      // Read at hotkey-down for the same reason as the frontmost app: by the
      // time text is ready the cursor may have moved, and the capitalisation
      // should match where the user was speaking into.
      textBefore: this.#deps.textBeforeCursor?.() ?? null,
    }

    this.#buffer.clear()
    this.#silence = new SilenceTracker(AUDIO.sampleRate)
    // Prepend the warm pre-roll so the first syllables are not clipped.
    const preRoll = this.#preRoll.snapshot()
    if (preRoll.length > 0) this.#buffer.push(preRoll)
    this.#preRoll.clear()

    this.#phase = 'listening'
    this.#deps.audio.start(settings.micDeviceId)
    this.#deps.machine.startListening(this.#handsFree, selection !== null)
    this.#armStage(TIMEOUTS.captureStartMs + AUDIO.maxUtteranceMs, 'listening')
  }

  /** Hotkey released. In hands-free mode this is a no-op (VAD finalises). */
  /**
   * Finish the current utterance.
   *
   * `fromTap` marks a press short enough to be the first half of a double-tap.
   * It changes nothing about how the audio is handled — the utterance is still
   * transcribed, because a 300 ms press carries 300 ms of pre-roll with it and
   * can genuinely contain a word. It only suppresses the *"Didn't catch that"*
   * that an empty one would otherwise produce, because the second tap has not
   * had time to arrive yet and the user is mid-gesture, not mid-mistake.
   */
  end(options: { fromTap?: boolean } = {}): void {
    if (this.#phase !== 'listening') return
    if (this.#handsFree) return
    void this.#finish({ quietNoSpeech: options.fromTap === true })
  }

  /** Latch hands-free mode (double-tap). */
  startHandsFree(): void {
    if (this.#phase === 'listening') {
      this.#handsFree = true
      // Hands-free never edits a selection: a latched session would fire the
      // edit on its first silence and then keep dictating over the result. If
      // this hold began in command mode, demote it to plain dictation.
      if (this.#context && this.#context.mode === 'command') {
        this.#context = { ...this.#context, mode: 'dictate', selection: null }
      }
      this.#deps.machine.startListening(true, false)
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

  /**
   * One PCM frame from the capture renderer.
   *
   * Frames carry no metering duty: the Bar's waveform is fed by the capture
   * renderer's ~30 Hz `audio.meter` channel, because one RMS value per 100 ms
   * frame is a 10 Hz stutter, not a waveform (PLAN §2.1).
   */
  pushFrame(frame: Float32Array): void {
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

  async #finish(options: { quietNoSpeech?: boolean } = {}): Promise<void> {
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
      this.#noSpeech(options.quietNoSpeech === true)
      return
    }

    // Guard 2: VAD found no speech in what was recorded.
    const trimmed = trimSilence(pcm, AUDIO.sampleRate)
    if (trimmed.silent || trimmed.pcm.length === 0) {
      this.#log.debug('VAD found no speech')
      this.#noSpeech(options.quietNoSpeech === true)
      return
    }
    const speechMs = Math.round((trimmed.pcm.length * 1000) / AUDIO.sampleRate)
    if (speechMs < AUDIO.minUtteranceMs) {
      this.#noSpeech(options.quietNoSpeech === true)
      return
    }

    this.#abort = new AbortController()
    const { signal } = this.#abort

    // -- STT ---------------------------------------------------------------
    this.#phase = 'transcribing'
    this.#deps.machine.startProcessing('transcribing', context.mode === 'command')

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

    // -- command mode: the speech is an instruction, not content -------------
    if (context.mode === 'command' && context.selection) {
      await this.#finishCommand(context, runId, rawText, transcript.durationMs, durationMs)
      return
    }

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

    // Applied to whichever text is about to be inserted, not just the polished
    // one: "ok." is two words, so it skips polishing entirely (POLISH
    // .skipWordCount) — and a bare "ok." is the single most common message
    // this rule exists for.
    // Snippets expand after polishing so the model never sees the expansion —
    // a URL or an address has a right answer and must arrive verbatim. Before
    // the trailing-period rule, so a snippet ending in a full stop is judged on
    // what actually lands in the message.
    const expanded = expandSnippets(polishedText ?? rawText, this.#deps.snippets())

    // Last, so it judges the text that actually lands — after a snippet may
    // have replaced the opening words entirely.
    const cased = applySentenceCase(expanded, context.textBefore)

    const finalText = stripTrailingPeriod(cased, {
      messaging: isMessagingApp(context.frontmostBundleId),
      formality: this.#deps.styleFor(context.category).formality,
    })

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
    this.#handsFree = false
    this.#finishing = false
    this.#deps.machine.finishInserted(
      finalText.length,
      injection.method === 'accessibility' ? 'accessibility' : 'paste',
    )
    this.emit('completed', { ...record, id: '' })
  }

  /**
   * Command mode's back half (PLAN §18.1). The transcript is an instruction;
   * the polishing model rewrites the *selection* per that instruction, and the
   * result replaces it through the normal injection path — a paste with a live
   * selection replaces it in every ordinary app, and the AX fallback writes
   * `kAXSelectedText` which does the same by definition.
   *
   * Failure discipline differs from dictation on purpose: there is no raw
   * fallback here. Inserting the spoken *instruction* over the user's selected
   * text would be destructive, so every failure path refuses and leaves the
   * selection alone.
   */
  async #finishCommand(
    context: UtteranceContext,
    runId: number,
    instruction: string,
    sttMs: number,
    durationMs: number,
  ): Promise<void> {
    const selection = context.selection
    if (!selection) {
      this.#fail('unknown', 'The selection went away.')
      return
    }

    const polishEngine = this.#deps.polish()
    const status = polishEngine?.status()
    if (!polishEngine || status?.state !== 'ready') {
      this.#fail(
        'polish-failed',
        'Editing a selection needs a polishing model — pick one in the Hub.',
      )
      return
    }

    this.#phase = 'polishing'
    this.#deps.machine.startProcessing('polishing', true)
    const polishModelId = context.settings.polishModelId ?? status.modelId

    let edited: string
    let polishMs: number
    try {
      const prompt = buildCommandPrompt({
        instruction,
        selection,
        language: context.settings.language,
      })
      const abort = this.#abort ?? new AbortController()
      this.#abort = abort
      const result = await this.#withTimeout(
        TIMEOUTS.polishMs,
        'polishing',
        polishEngine.polish({
          systemPrompt: prompt.systemPrompt,
          examples: prompt.examples,
          userText: prompt.userText,
          maxTokens: maxCommandOutputTokens(selection),
          signal: abort.signal,
        }),
      )
      polishMs = result.durationMs
      if (this.#runId !== runId) return

      if (result.truncated) {
        this.#fail(
          'polish-failed',
          'The edit came back incomplete — your selection is untouched. Try a shorter selection.',
        )
        return
      }
      const verdict = checkCommandOutput(result.text)
      if (!verdict.ok) {
        this.#fail('polish-failed', 'The model returned nothing — your selection is untouched.')
        return
      }
      edited = result.text.trim()
    } catch (error) {
      if (this.#runId !== runId) return
      this.#fail(
        error instanceof StageTimeoutError ? 'timeout' : 'polish-failed',
        describe(error, 'Could not edit the selection'),
      )
      return
    }
    if (this.#runId !== runId) return

    this.#phase = 'inserting'
    this.#deps.machine.startInserting()

    let injection: InjectionResult
    try {
      injection = await this.#withTimeout(
        TIMEOUTS.insertMs,
        'inserting',
        Promise.resolve(this.#deps.injector.insert(edited)),
      )
    } catch (error) {
      if (this.#runId !== runId) return
      this.#fail(
        error instanceof StageTimeoutError ? 'timeout' : 'insert-failed',
        describe(error, 'Could not replace the selection'),
      )
      return
    }
    if (this.#runId !== runId) return
    if (!injection.ok) {
      this.#fail(
        injection.reason === 'secure-input' ? 'secure-input' : 'insert-failed',
        injection.error ?? 'Could not replace the selection',
      )
      return
    }

    const record: Omit<DictationRecord, 'id'> = {
      ts: context.startedAt,
      rawText: instruction,
      polishedText: edited,
      appBundleId: context.frontmostBundleId,
      appCategory: context.category,
      durationMs,
      sttModelId: context.sttModelId,
      polishModelId,
      timings: { sttMs, polishMs, totalMs: this.#now() - context.startedAt },
    }
    try {
      this.#deps.persist(record)
    } catch (error) {
      this.#log.error('could not persist the history row:', error)
    }

    this.#abort = null
    this.#context = null
    this.#phase = 'idle'
    this.#handsFree = false
    this.#finishing = false
    this.#deps.machine.finishInserted(
      edited.length,
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
  /**
   * Nothing was said.
   *
   * Normally worth reporting — a hold that produced no text should say so
   * rather than look like the app ignored the key. But the first tap of a
   * double-tap is *always* an empty utterance, and reporting it flashes
   * "Didn't catch that" a fraction of a second before hands-free latches. The
   * user did nothing wrong and there is nothing to fix, so the pill just closes.
   */
  #noSpeech(quiet: boolean): void {
    if (!quiet) {
      this.#fail('no-speech', 'Didn’t catch that')
      return
    }
    this.#log.debug('no speech, but the press could be half a double-tap — closing quietly')
    this.#teardown()
    this.#deps.machine.reset()
  }

  /**
   * Return to rest without announcing anything.
   *
   * Shared by the error path and the quiet no-speech path so the two can never
   * drift: whichever way an utterance ends, the same state is released.
   */
  #teardown(): void {
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
  }

  #fail(code: DictationErrorCode, message: string): void {
    this.#log.warn(`failed: ${code} — ${message}`)
    this.#teardown()
    this.#deps.machine.fail(code, message)
  }
}

interface UtteranceContext {
  startedAt: number
  frontmostBundleId: string | null
  category: AppCategory
  settings: OrchestratorSettings
  sttModelId: string
  /** `command` when text was selected at hotkey-down (PLAN §18.1). */
  mode: 'dictate' | 'command'
  selection: string | null
  /** Text before the cursor at hotkey-down; `null` when it could not be read. */
  textBefore: string | null
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
