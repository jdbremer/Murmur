import { EventEmitter } from 'node:events'

import { DictationEventSchema, type DictationEvent, type DictationState } from '@murmur/shared'

/**
 * The dictation loop's state machine (PLAN §3.1, §3.2) — **structure only**.
 *
 * Stage 1 ships the shape: the states, the legal transitions, the event stream
 * the Bar renders from, and a `getState()` for windows that subscribe late.
 * Nothing here starts a capture, runs a model or types anything; Stage 2 drives
 * it from the native hotkey tap and the engine pipeline.
 *
 * Two vocabularies meet here, deliberately:
 *
 *  - {@link DictationState} — the four *resting* states: `idle`, `listening`,
 *    `processing`, `inserting`.
 *  - {@link DictationEvent} — what subscribers see. Adds `inserted` and `error`,
 *    which are momentary: the machine emits them and settles back to `idle`.
 */

/**
 * From a resting state, which event states may follow.
 *
 * `listening` and `processing` allow self-transitions because both carry
 * sub-state that legitimately changes in place: a hands-free latch mid-utterance
 * for the former, and the transcribing → polishing hand-off for the latter.
 * `idle` and `inserting` do not — a repeat there is a bug worth surfacing.
 */
const ALLOWED_TRANSITIONS: Record<DictationState, ReadonlySet<DictationEvent['state']>> = {
  idle: new Set(['listening', 'error']),
  listening: new Set(['listening', 'processing', 'idle', 'error']),
  processing: new Set(['processing', 'inserting', 'idle', 'error']),
  inserting: new Set(['inserted', 'idle', 'error']),
}

/** Which resting state an event leaves the machine in. */
const RESTING_STATE: Record<DictationEvent['state'], DictationState> = {
  idle: 'idle',
  listening: 'listening',
  processing: 'processing',
  inserting: 'inserting',
  inserted: 'idle',
  error: 'idle',
}

export interface InvalidTransition {
  from: DictationState
  to: DictationEvent['state']
  event: DictationEvent
}

export interface DictationStateMachineEvents {
  /** Every accepted transition, in order. This is what the Bar subscribes to. */
  event: [DictationEvent]
  /** `[next, previous]` resting states, for callers that only track the state. */
  state: [DictationState, DictationState]
  /** A rejected transition. Logged; useful for spotting races in Stage 2. */
  invalidTransition: [InvalidTransition]
}

export class DictationStateMachine extends EventEmitter<DictationStateMachineEvents> {
  #state: DictationState = 'idle'
  #lastEvent: DictationEvent = { state: 'idle' }
  readonly #log: (message: string) => void

  constructor(options: { log?: (message: string) => void } = {}) {
    super()
    this.#log = options.log ?? ((message) => console.log(message))
  }

  /** The current resting state. */
  get state(): DictationState {
    return this.#state
  }

  /**
   * The most recent event — including the momentary `inserted` / `error` ones.
   * Served to windows that subscribe mid-utterance (`dictation.getState`).
   */
  getState(): DictationEvent {
    return structuredClone(this.#lastEvent)
  }

  /** Would `next` be accepted right now? */
  canTransition(next: DictationEvent['state']): boolean {
    return ALLOWED_TRANSITIONS[this.#state].has(next)
  }

  /**
   * Attempt a transition. Returns `false` (and emits `invalidTransition`)
   * rather than throwing, because these races come from real hardware — a
   * hotkey-up that arrives after a cancel, say.
   */
  dispatch(event: DictationEvent): boolean {
    const parsed = DictationEventSchema.parse(event)
    const from = this.#state

    if (!this.canTransition(parsed.state)) {
      this.#log(`[dictation] ignored ${from} → ${parsed.state} (not a legal transition)`)
      this.emit('invalidTransition', { from, to: parsed.state, event: parsed })
      return false
    }

    const to = RESTING_STATE[parsed.state]
    this.#state = to
    this.#lastEvent = parsed
    this.#log(
      `[dictation] ${from} → ${parsed.state}${to === parsed.state ? '' : ` (resting: ${to})`}`,
    )

    this.emit('event', structuredClone(parsed))
    if (to !== from) this.emit('state', to, from)
    return true
  }

  // -- Convenience wrappers, so call sites read like the loop in PLAN §3.2 ---

  startListening(handsFree = false): boolean {
    return this.dispatch({ state: 'listening', handsFree, level: 0 })
  }

  startProcessing(stage: 'transcribing' | 'polishing' = 'transcribing'): boolean {
    return this.dispatch({ state: 'processing', stage })
  }

  startInserting(): boolean {
    return this.dispatch({ state: 'inserting' })
  }

  finishInserted(charCount: number, method: 'paste' | 'accessibility' = 'paste'): boolean {
    return this.dispatch({ state: 'inserted', charCount, method })
  }

  fail(code: Extract<DictationEvent, { state: 'error' }>['code'], message: string): boolean {
    return this.dispatch({ state: 'error', code, message })
  }

  /**
   * Force the machine back to `idle`, whatever it was doing. Used by the cancel
   * paths (Esc while listening, a stage timeout) where the current state must
   * not be able to veto the reset.
   */
  reset(): boolean {
    const from = this.#state
    if (from === 'idle' && this.#lastEvent.state === 'idle') return false

    this.#state = 'idle'
    this.#lastEvent = { state: 'idle' }
    this.#log(`[dictation] ${from} → idle (reset)`)
    this.emit('event', { state: 'idle' })
    if (from !== 'idle') this.emit('state', 'idle', from)
    return true
  }
}
