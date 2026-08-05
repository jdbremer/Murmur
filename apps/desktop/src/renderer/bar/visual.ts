import { MOMENTARY_HOLD_MS, type BarVisibility, type DictationEvent } from '@murmur/shared'

/**
 * The Bar's state → pixels mapping (PLAN §2.1) — pure, so it can be tested.
 *
 * Every number in this file is from the spec: the 64 × 22 idle capsule, the
 * ~160 px listening expansion, the ~150 ms ease-out morph, the ~2.5 s error
 * dismissal. The renderer reads them; it never invents them. Getting the
 * geometry wrong is the single most visible way this stage can fail, and it is
 * the one thing a machine with no display can still check.
 */

// ---------------------------------------------------------------------------
// Geometry & timing constants (PLAN §2.1)
// ---------------------------------------------------------------------------

export const BAR = {
  /** Idle capsule. */
  idleWidth: 64,
  height: 22,
  /** Height while the hover controls are showing — "expands it slightly". */
  hoverHeight: 30,
  /** Extra width the three hover controls need (cancel · mic · Hub). */
  hoverWidth: 84,
  /** Listening. */
  listeningWidth: 160,
  processingWidth: 132,
  insertingWidth: 112,
  insertedWidth: 96,
  /** Error pills size to their message, within these bounds. */
  errorMinWidth: 180,
  errorMaxWidth: 260,
  /** The window is 360 px wide; nothing may exceed it (see windows/bar.ts). */
  maxWidth: 344,
  /** Every state change morphs over this, ease-out (PLAN §2.1). */
  morphMs: 150,
  /** How long the ✓ pulse holds — shared with main's window retirement. */
  insertedHoldMs: MOMENTARY_HOLD_MS.inserted,
  /** Error auto-dismiss (PLAN §2.1) — likewise shared. */
  errorHoldMs: MOMENTARY_HOLD_MS.error,
  /** Waveform: 24–32 bars, ~2 px wide with a 2 px gap (PLAN §2.1). */
  waveformBars: 28,
  waveformBarWidth: 2,
  waveformBarGap: 2,
  /** Bar heights inside the capsule. */
  waveformMinHeight: 2,
  waveformMaxHeight: 14,
  /** One shimmer sweep across the pill while processing. */
  shimmerPeriodMs: 1100,
} as const

/** Near-black, per PLAN §2.1. */
export const BAR_BACKGROUND = 'rgba(20,20,24,0.92)'
/** Warm red for the error state. */
export const BAR_ERROR_BACKGROUND = 'rgba(74,26,26,0.94)'
export const BAR_BORDER = 'rgba(255,255,255,0.08)'
export const BAR_ERROR_BORDER = 'rgba(255,148,132,0.30)'
export const BAR_SHADOW = '0 8px 24px rgba(0,0,0,0.42)'

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/** What the pill is drawing right now. */
export type BarShape =
  /** Dim static dots — the idle hint that the mic is there. */
  | 'dots'
  /** The live waveform. */
  | 'waveform'
  /** Bars collapsed into a left→right shimmer sweep. */
  | 'shimmer'
  /** The ✓ pulse. */
  | 'check'
  /** A short message. */
  | 'message'

export interface BarVisual {
  shape: BarShape
  width: number
  height: number
  background: string
  border: string
  /** Message text for `shape: 'message'`, otherwise empty. */
  label: string
  /** The latched hands-free indicator dot (PLAN §2.1 "Hands-free"). */
  handsFree: boolean
  /** What VoiceOver and the window title announce. */
  ariaLabel: string
  /** True while the state is one an assistive tech should be told about. */
  announce: boolean
}

/**
 * Map one dictation event to the pill's appearance.
 *
 * `hovered` is the only renderer-local input: hovering widens the capsule to
 * fit the cancel / mic / Hub controls without changing what it is showing.
 */
export function describeBar(event: DictationEvent, hovered = false): BarVisual {
  const base = describeBase(event)
  const width = clampWidth(base.width + (hovered ? BAR.hoverWidth : 0))
  return { ...base, width, height: hovered ? BAR.hoverHeight : BAR.height }
}

function describeBase(event: DictationEvent): BarVisual {
  switch (event.state) {
    case 'idle':
      return {
        shape: 'dots',
        width: BAR.idleWidth,
        height: BAR.height,
        background: BAR_BACKGROUND,
        border: BAR_BORDER,
        label: '',
        handsFree: false,
        ariaLabel: 'Murmur is idle. Hold your dictation key to speak.',
        announce: false,
      }
    case 'listening':
      return {
        shape: 'waveform',
        width: BAR.listeningWidth,
        height: BAR.height,
        background: BAR_BACKGROUND,
        border: BAR_BORDER,
        label: '',
        handsFree: event.handsFree,
        ariaLabel: event.handsFree ? 'Listening, hands-free mode' : 'Listening',
        announce: true,
      }
    case 'processing':
      return {
        shape: 'shimmer',
        width: BAR.processingWidth,
        height: BAR.height,
        background: BAR_BACKGROUND,
        border: BAR_BORDER,
        label: '',
        handsFree: false,
        ariaLabel: event.stage === 'polishing' ? 'Polishing your words' : 'Transcribing',
        announce: true,
      }
    case 'inserting':
      return {
        shape: 'shimmer',
        width: BAR.insertingWidth,
        height: BAR.height,
        background: BAR_BACKGROUND,
        border: BAR_BORDER,
        label: '',
        handsFree: false,
        ariaLabel: 'Inserting text',
        announce: true,
      }
    case 'inserted':
      return {
        shape: 'check',
        width: BAR.insertedWidth,
        height: BAR.height,
        background: BAR_BACKGROUND,
        border: BAR_BORDER,
        label: '',
        handsFree: false,
        ariaLabel: `Inserted ${event.charCount} characters`,
        announce: true,
      }
    case 'error':
      return {
        shape: 'message',
        width: errorWidth(event.message),
        height: BAR.height,
        background: BAR_ERROR_BACKGROUND,
        border: BAR_ERROR_BORDER,
        label: event.message,
        handsFree: false,
        ariaLabel: event.message,
        announce: true,
      }
  }
}

/** Roughly 6.2 px per character at the pill's 11 px type size, plus padding. */
export function errorWidth(message: string): number {
  const measured = Math.round(56 + message.length * 6.2)
  return Math.min(BAR.errorMaxWidth, Math.max(BAR.errorMinWidth, measured))
}

function clampWidth(width: number): number {
  return Math.min(BAR.maxWidth, Math.round(width))
}

// ---------------------------------------------------------------------------
// Momentary states
// ---------------------------------------------------------------------------

/**
 * `inserted` and `error` are momentary: main emits them and immediately settles
 * the machine back to `idle`. The Bar has to hold them anyway — a ✓ that
 * vanishes in 40 ms is not a confirmation, and PLAN §2.1 gives the error pill
 * ~2.5 s. So the renderer keeps showing the momentary event until its hold
 * expires, then shows whatever the machine has moved on to.
 *
 * Pure and clock-injected: `now` is always passed in, never read here.
 */
export class BarPresenter {
  #latest: DictationEvent = { state: 'idle' }
  #momentary: { event: DictationEvent; until: number } | null = null

  receive(event: DictationEvent, now: number): void {
    const hold = holdMsFor(event)
    if (hold > 0) {
      this.#momentary = { event, until: now + hold }
      // The machine settles to idle when it emits a momentary event, but it
      // does NOT emit that idle — `RESTING_STATE` moves silently. Without this
      // line the presenter would fall back to the stale pre-momentary event
      // (`inserting`, usually) when the hold expires, and the pill would say
      // "Inserting…" forever after every successful dictation.
      this.#latest = { state: 'idle' }
      return
    }
    this.#latest = event
    // A new utterance beginning cancels a lingering ✓ or error immediately.
    if (event.state !== 'idle') this.#momentary = null
  }

  /** What the pill should be showing at `now`. */
  present(now: number): DictationEvent {
    const momentary = this.#momentary
    if (momentary && momentary.until > now) return momentary.event
    if (momentary) this.#momentary = null
    return this.#latest
  }

  /** When the next change happens with no further input, or `null`. */
  expiresAt(): number | null {
    return this.#momentary?.until ?? null
  }
}

export function holdMsFor(event: DictationEvent): number {
  if (event.state === 'inserted') return BAR.insertedHoldMs
  if (event.state === 'error') return BAR.errorHoldMs
  return 0
}

/**
 * Whether the pill should be on screen at all (PLAN §2.1 visibility modes).
 *
 * Main also hides and shows the *window*; this is the renderer agreeing with it,
 * so a Bar that is visible for any other reason (a stale window, a dev build
 * with the window forced open) still respects the user's choice.
 */
export function isBarVisible(mode: BarVisibility, event: DictationEvent): boolean {
  switch (mode) {
    case 'always':
      return true
    case 'hidden':
      return false
    case 'showWhileDictating':
      return event.state !== 'idle'
  }
}
