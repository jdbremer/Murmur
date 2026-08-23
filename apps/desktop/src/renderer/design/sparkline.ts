/**
 * Sparkline geometry (PLAN §2.2.6).
 *
 * Path maths, kept out of the component so it can be tested without a DOM and
 * so the two hard cases are handled once rather than per call site:
 *
 *  - **A flat series.** Normalising by `(value - min) / (max - min)` divides by
 *    zero the moment every value is equal — which for this app is the common
 *    case, not the exotic one (a week of no dictations is seven zeroes). The
 *    line goes through the vertical middle, where a flat line belongs.
 *  - **One point, or none.** A single reading is a dot, not a line, and an
 *    empty series has no geometry at all rather than a path of `NaN`s that
 *    silently renders nothing.
 */

export interface SparklinePoint {
  x: number
  y: number
}

export interface SparklineGeometry {
  /** `d` for the stroked line. */
  line: string
  /** `d` for the fill beneath it, closed along the baseline. */
  area: string
  points: SparklinePoint[]
  /** The most recent reading — the one worth drawing a dot on. */
  last: SparklinePoint
  min: number
  max: number
}

export interface SparklineOptions {
  width?: number
  height?: number
  /**
   * Keeps the stroke and the endpoint dot inside the viewBox. Without it a
   * peak at the top of the range is sliced in half by the edge.
   */
  padding?: number
  /**
   * `monotone` (the default) is a Fritsch-Carlson spline: smooth, and
   * mathematically incapable of leaving the range of its own data. `linear`
   * is a plain polyline.
   *
   * Not a tension knob, which is what this was first. A Catmull-Rom spline at
   * any useful tension overshoots a spike between two flat runs, and on this
   * app's most common series — a week of zeroes with one busy afternoon — the
   * overshoot puts the line *below zero*. A "words dictated" chart that dips
   * negative is not a stylistic choice, it is a false statement about the
   * data, and no amount of tuning removes it for every input.
   */
  curve?: 'monotone' | 'linear'
}

const round = (value: number): number => Math.round(value * 100) / 100

/** Geometry for `values`, or null when there is nothing to draw. */
export function sparkline(
  values: readonly number[],
  options: SparklineOptions = {},
): SparklineGeometry | null {
  const { width = 96, height = 28, padding = 2, curve = 'monotone' } = options
  if (values.length === 0) return null

  const min = Math.min(...values)
  const max = Math.max(...values)
  const top = padding
  const bottom = height - padding
  const span = max - min

  const points: SparklinePoint[] = values.map((value, index) => {
    const x =
      values.length === 1
        ? width / 2
        : padding + (index / (values.length - 1)) * (width - padding * 2)
    // A flat series sits on the centre line: there is no "high" or "low" to
    // place it at, and pinning it to either edge invents a trend.
    const fraction = span === 0 ? 0.5 : (value - min) / span
    return { x: round(x), y: round(bottom - fraction * (bottom - top)) }
  })

  const last = points[points.length - 1] as SparklinePoint
  const first = points[0] as SparklinePoint

  if (points.length === 1) {
    // A zero-length line still strokes a round cap, which is exactly the dot a
    // single reading should be.
    const line = `M ${first.x} ${first.y} L ${first.x} ${first.y}`
    return { line, area: '', points, last, min, max }
  }

  const line = curve === 'linear' ? polyline(points) : monotonePath(points)
  const area = `${line} L ${last.x} ${round(height)} L ${first.x} ${round(height)} Z`
  return { line, area, points, last, min, max }
}

/**
 * A monotone cubic (Fritsch-Carlson) spline through every point.
 *
 * A spline rather than a polyline because a sparkline is read as a gesture:
 * the eye takes the shape, not the individual readings, and hard corners at
 * this size turn into visual noise.
 *
 * *Monotone* rather than Catmull-Rom because the smoothing must not invent
 * values. Each segment's tangents are limited so the curve stays between the
 * two readings it connects, which means the drawn line never rises above the
 * series maximum or falls below its minimum — the property that keeps a chart
 * of a non-negative quantity from dipping below zero between two zeroes.
 */
function monotonePath(points: readonly SparklinePoint[]): string {
  const n = points.length
  // Secant slope of each segment.
  const secants: number[] = []
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i] as SparklinePoint
    const b = points[i + 1] as SparklinePoint
    const run = b.x - a.x
    secants.push(run === 0 ? 0 : (b.y - a.y) / run)
  }

  // Tangent at each point: the average of its neighbours' secants, with the
  // ends taking the one secant they have.
  const tangents: number[] = new Array(n).fill(0)
  tangents[0] = secants[0] ?? 0
  tangents[n - 1] = secants[n - 2] ?? 0
  for (let i = 1; i < n - 1; i += 1) {
    const before = secants[i - 1] as number
    const after = secants[i] as number
    // A sign change is a local extremum: a flat tangent there is what stops
    // the curve from sailing past the point it is supposed to turn at.
    tangents[i] = before * after <= 0 ? 0 : (before + after) / 2
  }

  // Fritsch-Carlson: pull the tangents back inside the circle of radius 3 so
  // no segment can overshoot its own endpoints.
  for (let i = 0; i < n - 1; i += 1) {
    const secant = secants[i] as number
    if (secant === 0) {
      tangents[i] = 0
      tangents[i + 1] = 0
      continue
    }
    const alpha = (tangents[i] as number) / secant
    const beta = (tangents[i + 1] as number) / secant
    const magnitude = alpha * alpha + beta * beta
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude)
      tangents[i] = scale * alpha * secant
      tangents[i + 1] = scale * beta * secant
    }
  }

  const parts = [`M ${points[0]?.x ?? 0} ${points[0]?.y ?? 0}`]
  for (let i = 0; i < n - 1; i += 1) {
    const a = points[i] as SparklinePoint
    const b = points[i + 1] as SparklinePoint
    const third = (b.x - a.x) / 3
    const c1x = round(a.x + third)
    const c1y = round(a.y + (tangents[i] as number) * third)
    const c2x = round(b.x - third)
    const c2y = round(b.y - (tangents[i + 1] as number) * third)
    parts.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${b.x} ${b.y}`)
  }
  return parts.join(' ')
}

/** Straight segments, for callers that want the readings and not the gesture. */
function polyline(points: readonly SparklinePoint[]): string {
  const [first, ...rest] = points
  return [`M ${first?.x ?? 0} ${first?.y ?? 0}`, ...rest.map((p) => `L ${p.x} ${p.y}`)].join(' ')
}
