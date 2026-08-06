import { BAR } from './visual'

/**
 * Turning a 30 Hz amplitude stream into a 60 fps waveform (PLAN §2.1).
 *
 * Two pieces, both pure and both clock-injected so they can be tested without a
 * display or a microphone:
 *
 *  - {@link LevelEnvelope} smooths between the levels that actually arrive.
 *    Attack is fast and decay is slow, which is how every VU meter since the
 *    1930s has behaved and the reason a waveform reads as "voice" rather than
 *    as "noise": a syllable should hit instantly and fall away.
 *  - {@link WaveformHistory} is the scrolling window of bars the canvas draws.
 */

/** Time constant for a rising level — a syllable must land immediately. */
export const ATTACK_MS = 45
/** Time constant for a falling level — the tail is what makes it look alive. */
export const DECAY_MS = 260
/** One new bar every 33 ms: the 28-bar window is ~0.9 s of speech. */
export const BAR_INTERVAL_MS = 1000 / 30

/**
 * Exponential smoothing with separate attack and decay rates.
 *
 * `advance(dtMs)` is frame-rate independent: the same input produces the same
 * curve whether it is stepped at 60 fps, at 30 fps, or in one jump — which is
 * what makes it testable and what keeps the waveform honest on a busy machine.
 */
export class LevelEnvelope {
  #value: number
  #target: number

  constructor(initial = 0) {
    this.#value = clamp01(initial)
    this.#target = this.#value
  }

  get value(): number {
    return this.#value
  }

  get target(): number {
    return this.#target
  }

  /** A new measurement from `audio.level`. */
  push(level: number): void {
    this.#target = clamp01(level)
  }

  /** Advance by `dtMs` milliseconds and return the new value. */
  advance(dtMs: number): number {
    if (!(dtMs > 0)) return this.#value
    const rising = this.#target > this.#value
    const timeConstant = rising ? ATTACK_MS : DECAY_MS
    // 1 - e^(-dt/τ): the fraction of the remaining distance covered.
    const alpha = 1 - Math.exp(-dtMs / timeConstant)
    this.#value += (this.#target - this.#value) * alpha
    // Stop asymptoting forever; below a 60th of a pixel nobody can tell.
    if (Math.abs(this.#target - this.#value) < 0.0005) this.#value = this.#target
    return this.#value
  }

  reset(value = 0): void {
    this.#value = clamp01(value)
    this.#target = this.#value
  }
}

/**
 * The bars themselves: a fixed-length ring that scrolls left as time passes.
 *
 * The newest sample enters at the right, so the waveform reads the way people
 * expect a recording to — most recent at the leading edge.
 */
export class WaveformHistory {
  readonly #values: Float64Array
  readonly #intervalMs: number
  #elapsed = 0

  constructor(size: number = BAR.waveformBars, intervalMs: number = BAR_INTERVAL_MS) {
    this.#values = new Float64Array(Math.max(1, Math.floor(size)))
    this.#intervalMs = Math.max(1, intervalMs)
  }

  get size(): number {
    return this.#values.length
  }

  /** Oldest first, newest last. A copy — callers may not mutate the ring. */
  values(): number[] {
    return Array.from(this.#values)
  }

  /**
   * Advance the scroll by `dtMs`, appending `level` for each interval crossed.
   * A long stall (the renderer was descheduled) fills the gap rather than
   * teleporting the waveform.
   */
  advance(dtMs: number, level: number): number {
    if (!(dtMs > 0)) return 0
    this.#elapsed += dtMs
    let pushed = 0
    while (this.#elapsed >= this.#intervalMs && pushed < this.#values.length) {
      this.#elapsed -= this.#intervalMs
      this.push(level)
      pushed += 1
    }
    // Deep stalls: never spin filling a ring we are about to overwrite anyway.
    if (this.#elapsed > this.#intervalMs) this.#elapsed = 0
    return pushed
  }

  push(level: number): void {
    this.#values.copyWithin(0, 1)
    this.#values[this.#values.length - 1] = clamp01(level)
  }

  reset(): void {
    this.#values.fill(0)
    this.#elapsed = 0
  }
}

/**
 * Bar heights in pixels for one waveform frame.
 *
 * Two shaping rules, both from watching real dictation bars: heights are
 * eased (`level^0.75`) so quiet speech still shows, and the outermost bars are
 * tapered so the waveform fades into the capsule instead of being clipped by
 * it.
 */
export function barHeights(
  levels: readonly number[],
  options: { min?: number; max?: number } = {},
): number[] {
  const min = options.min ?? BAR.waveformMinHeight
  const max = options.max ?? BAR.waveformMaxHeight
  const last = Math.max(1, levels.length - 1)
  return levels.map((level, index) => {
    const eased = Math.pow(clamp01(level), 0.75)
    const distance = Math.abs(index / last - 0.5) * 2
    const taper = 1 - 0.25 * Math.pow(distance, 3)
    return min + (max - min) * eased * taper
  })
}

/**
 * The shimmer sweep's highlight centre, 0..1 across the pill (PLAN §2.1).
 *
 * The sweep is eased, not linear: it accelerates out of the left edge, glides
 * through the middle and decelerates off the right, which reads as a gesture
 * rather than a scanner.
 */
export function shimmerPosition(elapsedMs: number, periodMs: number = BAR.shimmerPeriodMs): number {
  const period = Math.max(1, periodMs)
  const t = (((elapsedMs % period) + period) % period) / period
  const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  // -0.25..1.25 so the highlight enters and leaves off-pill rather than
  // appearing at the edges.
  return eased * 1.5 - 0.25
}

/** Where the ✓ starts, peaks and settles (PLAN §2.1 "quick ✓ pulse"). */
export const CHECK_START_SCALE = 0.6
export const CHECK_PEAK_SCALE = 1.14
/** Fraction of the pulse spent growing; the rest is the settle. */
const CHECK_RISE = 0.4

/** Scale of the ✓ pulse at `elapsedMs`: overshoot, then settle on 1. */
export function checkPulseScale(elapsedMs: number, durationMs = 320): number {
  if (elapsedMs <= 0) return CHECK_START_SCALE
  if (elapsedMs >= durationMs) return 1
  const t = elapsedMs / durationMs
  if (t < CHECK_RISE) {
    return CHECK_START_SCALE + (CHECK_PEAK_SCALE - CHECK_START_SCALE) * easeOutCubic(t / CHECK_RISE)
  }
  return (
    CHECK_PEAK_SCALE + (1 - CHECK_PEAK_SCALE) * easeOutCubic((t - CHECK_RISE) / (1 - CHECK_RISE))
  )
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - clamp01(t), 3)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}
