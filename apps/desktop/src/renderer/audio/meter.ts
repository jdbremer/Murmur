/**
 * The mic meter's arithmetic (PLAN §2.1) — pure functions only.
 *
 * The worklet posts raw RMS and peak sums at ~30 Hz; this module maps them to
 * the 0..1 the Bar draws. It is split out of `capture.ts` for the same reason
 * `mic-errors.ts` is: pure logic stays out of DOM-dependent modules so the
 * DOM-free test config can cover it.
 */

/** Quietest amplitude the meter shows at all, in dBFS. */
export const METER_FLOOR_DB = -62
/** Amplitude that pins the meter to full scale, in dBFS. */
export const METER_CEILING_DB = -8

/**
 * Map a raw amplitude to the 0..1 the Bar draws.
 *
 * Linear RMS is useless for this: conversational speech sits around 0.02–0.2,
 * so a linear bar spends its life in the bottom fifth of its range and looks
 * dead. Decibels match how the ear hears loudness, and the window above is the
 * usable span of a laptop microphone at arm's length.
 */
export function normaliseLevel(amplitude: number): number {
  if (!(amplitude > 0)) return 0
  const db = 20 * Math.log10(Math.min(1, amplitude))
  const scaled = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)
  return clamp01(scaled)
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}
