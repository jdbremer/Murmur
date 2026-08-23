/**
 * Skeleton geometry (PLAN §2.2.6).
 *
 * A skeleton stands in for content that has a shape, so its lines need to have
 * that shape too: a column of identical full-width bars reads as a loading
 * *graphic*, while lines of varying length read as text that has not arrived
 * yet. The variation has to be deterministic, though — `Math.random()` in a
 * render would reshuffle every line on every re-render, and React re-renders a
 * loading pane more often than you would think (a subscription firing, a
 * parent's state settling). Same index, same width, forever.
 */

/**
 * A 32-bit integer hash. Small, fast, and — the only property that matters
 * here — well distributed for consecutive inputs, which is exactly what a row
 * index is. A plain `sin(index)` fractional trick clusters badly at low
 * indices, which is where every skeleton in the app lives.
 */
function hash(value: number): number {
  let x = (value | 0) + 0x9e3779b9
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad)
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97)
  x = x ^ (x >>> 15)
  // >>> 0 first: the multiplies above produce signed 32-bit values, and a
  // negative numerator here would put every other width below `min`.
  return (x >>> 0) / 0x100000000
}

export interface SkeletonWidthOptions {
  /** Percent, inclusive. */
  min?: number
  max?: number
  /** Distinguishes two skeletons on the same screen so they do not rhyme. */
  seed?: number
}

/**
 * `count` line widths as percentages, stable for a given `(index, seed)`.
 *
 * The last line is deliberately shorter than the range allows: real paragraphs
 * end mid-line, and a block of text whose final line reaches the right margin
 * looks like a table.
 */
export function skeletonWidths(count: number, options: SkeletonWidthOptions = {}): number[] {
  const { min = 45, max = 96, seed = 0 } = options
  const total = Math.max(0, Math.floor(count))
  if (total === 0) return []

  const low = Math.min(min, max)
  const high = Math.max(min, max)
  const span = high - low

  const widths: number[] = []
  for (let index = 0; index < total; index += 1) {
    const isLast = index === total - 1 && total > 1
    const fraction = hash(index + seed * 977)
    // A short tail line, but never so short it looks like a different element.
    const width = isLast ? low * 0.55 + span * 0.35 * fraction : low + span * fraction
    widths.push(Math.round(width * 10) / 10)
  }
  return widths
}

/**
 * How long row `index` waits before its sweep starts, in ms.
 *
 * A staggered sweep travels down the list the way reading does. It wraps
 * rather than accumulating: at 40 rows an un-wrapped stagger would leave the
 * last row still dark three seconds after the first one lit up, which looks
 * like a stall in exactly the component whose job is to say "not stalled".
 */
export function skeletonDelay(index: number, stepMs = 90, wrapAfter = 6): number {
  const safe = Math.max(0, Math.floor(index))
  return (safe % Math.max(1, wrapAfter)) * stepMs
}
