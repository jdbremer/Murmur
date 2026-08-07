import type { DictationEvent, DictationState } from '@murmur/shared'

/**
 * The start/stop dictation cue (PLAN §2.1) — pure, so it can be tested.
 *
 * Two notes a perfect fifth apart: rising to open an utterance, falling to
 * close it. The interval is the whole trick. A fifth is the most consonant
 * interval after the octave, so neither cue reads as an alert; and because the
 * pair is the same two notes in opposite order, "started" and "stopped" are
 * instantly distinguishable without either one having to be loud.
 *
 * **Where the numbers come from.** They are a recreation of the reference
 * product's cue, measured rather than guessed: Hilbert-transform analysis of
 * its start/stop sounds gave the pitches (441 Hz and 294 Hz — an exact 3:2),
 * the grace-note-then-downbeat phrasing, the ~4 ms attack, the ~6 ms decay and
 * the ~5% reverb tail reproduced below. Nothing is sampled from it: PLAN §2
 * forbids extracting anything from that app's bundle, so this is synthesised
 * from scratch by {@link ./cue-player}, the audio counterpart of the "recreated
 * by eye" rule the Bar's geometry already follows.
 *
 * The waveform is a plain sine. The reference cue's second harmonic sits 60 dB
 * down, which is to say it is a sine too — anything richer starts to sound like
 * a notification.
 */

// ---------------------------------------------------------------------------
// The cue's shape
// ---------------------------------------------------------------------------

export const CUE = {
  /**
   * A4 and the D4 a fifth below it, at the reference cue's tuning (A4 = 441 Hz,
   * not 440). Kept as an exact 3:2 so the two notes share a harmonic series and
   * the pair rings rather than beats.
   */
  highHz: 441,
  lowHz: 294,
  /**
   * Peak gain of the downbeat, ≈ −16.5 dBFS. Deliberately quiet: this fires on
   * every utterance, dozens of times an hour, and a cue you can hear over your
   * own voice is a cue you will switch off within a day.
   */
  peakGain: 0.15,
  /**
   * The grace note is a hint, not half of a duet — it lands under the downbeat
   * rather than beside it. Measured at 6% of peak for the rising cue and 10%
   * for the falling one, which is what keeps the downbeat's pitch the one you
   * actually hear.
   */
  gracePeakRatio: { start: 0.06, stop: 0.1 },
  /** Grace-note-to-downbeat spacing. The falling cue is the more relaxed of the two. */
  downbeatDelayMs: { start: 23, stop: 39 },
  /** Long enough not to click, short enough to still read as a struck note. */
  attackMs: 4,
  /**
   * Body decay time constant — about −20 dB 15 ms after the peak.
   *
   * These three came out of a least-squares fit of this exact model to the
   * reference cue's measured envelope (0.9 dB rms over its first 85 ms), which
   * is why they are not round numbers. Rounding `bodyTauMs` up to 6 is audible:
   * it turns the note from struck to blown.
   */
  bodyTauMs: 4.7,
  /** A small, slow tail — the trace of a room, and the whole of the "satisfying". */
  tailWeight: 0.06,
  /**
   * How long that tail rings. Per cue, because the reference pair is not
   * symmetric here: the closing cue is left to ring almost twice as long as the
   * opening one, which is what stops "stopped" from sounding clipped when it
   * arrives at the end of a sentence rather than the start.
   */
  tailTauMs: { start: 38, stop: 67 },
  /** How long each note is rendered for; the tail is inaudible well before this. */
  noteDurationMs: 190,
  /** Final fade, so the curve lands on exactly zero and cannot click. */
  releaseMs: 12,
  /**
   * Envelope sample rate. The Web Audio curve is interpolated linearly between
   * points, so this only has to resolve the 4 ms attack — 0.5 ms steps give it
   * eight, and the exponential decay far more than it needs.
   */
  curveHz: 2000,
} as const

export type DictationCue = 'start' | 'stop'

/** The two notes of a cue, in the order they are struck. */
export interface CueNote {
  readonly frequencyHz: number
  /** Onset relative to the start of the cue. */
  readonly atMs: number
  /** Peak gain, absolute. */
  readonly gain: number
  /** Tail length, carried on the note so both share one room. */
  readonly tailTauMs: number
}

/**
 * Rising fifth to open, falling fifth to close — the same two notes, reversed.
 *
 * Typed as a pair rather than a list: "grace note, then downbeat" is the whole
 * design, and a third note would be a different cue.
 */
export function cueNotes(cue: DictationCue): readonly [grace: CueNote, downbeat: CueNote] {
  const grace = cue === 'start' ? CUE.lowHz : CUE.highHz
  const downbeat = cue === 'start' ? CUE.highHz : CUE.lowHz
  const tailTauMs = CUE.tailTauMs[cue]
  return [
    { frequencyHz: grace, atMs: 0, gain: CUE.peakGain * CUE.gracePeakRatio[cue], tailTauMs },
    { frequencyHz: downbeat, atMs: CUE.downbeatDelayMs[cue], gain: CUE.peakGain, tailTauMs },
  ]
}

/** Wall-clock length of the whole cue, used to schedule teardown. */
export function cueDurationMs(cue: DictationCue): number {
  return CUE.downbeatDelayMs[cue] + CUE.noteDurationMs
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Normalised amplitude of one note `t` ms after its onset: a linear attack into
 * the sum of two exponentials — a fast body and a slow, quiet tail.
 *
 * The two-exponential shape is the point. A single exponential short enough to
 * sound crisp also sounds abrupt; adding 5% of a much slower decay underneath
 * reads as a small room, and that is the difference between a beep and a note.
 */
export function envelopeAt(t: number, tailTauMs: number): number {
  if (t <= 0 || t >= CUE.noteDurationMs) return 0
  const struck =
    t < CUE.attackMs
      ? t / CUE.attackMs
      : (1 - CUE.tailWeight) * Math.exp(-(t - CUE.attackMs) / CUE.bodyTauMs) +
        CUE.tailWeight * Math.exp(-(t - CUE.attackMs) / tailTauMs)

  // Ease the last few ms to zero: the tail is already inaudible, but a curve
  // that ends on a non-zero sample is a click.
  const untilEnd = CUE.noteDurationMs - t
  const fade = untilEnd < CUE.releaseMs ? untilEnd / CUE.releaseMs : 1
  return struck * fade
}

/**
 * The note's envelope as a Web Audio value curve, scaled to `gain`.
 *
 * Handed to `setValueCurveAtTime`, which stretches it over the note's duration
 * — so the caller supplies the length, and this supplies the shape.
 */
export function renderEnvelope(note: CueNote): Float32Array {
  const points = Math.max(2, Math.round((CUE.noteDurationMs / 1000) * CUE.curveHz))
  const curve = new Float32Array(points)
  for (let i = 0; i < points; i += 1) {
    const t = (i / (points - 1)) * CUE.noteDurationMs
    curve[i] = note.gain * envelopeAt(t, note.tailTauMs)
  }
  return curve
}

// ---------------------------------------------------------------------------
// When to play
// ---------------------------------------------------------------------------

/**
 * Where each event leaves the machine at rest. Mirrors the table in
 * `main/dictation/state-machine.ts`: the renderer sees every event, including
 * the momentary `inserted` and `error` ones, and has to collapse them the same
 * way main does to know whether the machine actually moved.
 */
const RESTING_STATE: Record<DictationEvent['state'], DictationState> = {
  idle: 'idle',
  listening: 'listening',
  processing: 'processing',
  inserting: 'inserting',
  inserted: 'idle',
  error: 'idle',
}

export function restingStateOf(event: DictationEvent): DictationState {
  return RESTING_STATE[event.state]
}

/**
 * Which cue — if any — this transition should make audible.
 *
 * Edges, not states: `listening` repeats itself as the hands-free latch and mic
 * level change, and re-firing the cue on every one of those would be maddening.
 *
 * Leaving `listening` sounds the stop cue wherever it goes — `processing` on a
 * normal release, but also `idle` on Esc and `error` on "didn't catch that".
 * The cue answers "am I still recording?", and the honest answer to that is the
 * same in all three cases. Failures that never reach `listening` at all (a
 * secure input field, no STT model) stay silent, which is correct: nothing
 * started, so nothing stopped.
 */
export function decideCue(previous: DictationState, event: DictationEvent): DictationCue | null {
  const next = restingStateOf(event)
  if (previous === next) return null
  if (next === 'listening') return 'start'
  if (previous === 'listening') return 'stop'
  return null
}
