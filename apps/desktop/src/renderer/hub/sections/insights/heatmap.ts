import type { InsightsDay } from '@murmur/shared'

/**
 * The streak heatmap's layout, as pure data (PLAN §2.2.2).
 *
 * Separated from the component for the usual reason a grid of dates gets
 * separated from its markup: every bug this can have is an off-by-one in date
 * arithmetic, and those are only catchable by a test with hand-written
 * fixtures. Nothing here touches the DOM or the clock — `today` and `endDay`
 * are both passed in.
 *
 * All arithmetic runs on UTC-midnight instants and `YYYY-MM-DD` strings, the
 * same technique `stats.ts` uses: stepping a local `Date` by 24 hours skips or
 * repeats a day across a DST boundary, and a streak grid that loses an hour in
 * March would silently drop a column.
 */

/** Sunday-first, like every contribution grid people already know how to read. */
export const HEATMAP_ROWS = 7
/** How far one press of the back arrow moves the window. */
export const HEATMAP_STEP_WEEKS = 4

export interface HeatmapCell {
  /** `YYYY-MM-DD`. */
  day: string
  words: number
  dictations: number
  /** 0 (nothing) … 4 (the busiest band), for shading. */
  level: 0 | 1 | 2 | 3 | 4
  /** Part of the current streak, and therefore glowing. */
  inStreak: boolean
  /** Later than `today`: rendered as a hole, not an empty day. */
  future: boolean
}

export interface Heatmap {
  /** Oldest week first; each column is 7 cells, Sunday → Saturday. */
  columns: HeatmapCell[][]
  /** Month labels for the columns that start one, keyed by column index. */
  monthLabels: { column: number; label: string }[]
}

export interface HeatmapInput {
  days: readonly InsightsDay[]
  /** Right-hand edge of the window; the grid ends on this day's week. */
  today: string
  /** How many week columns to draw. */
  weeks: number
  /**
   * The last day the current streak covers, from the store. `null` when there
   * is no live streak.
   *
   * Passed rather than derived from `today` on purpose: the glow has to end on
   * a day the user really dictated. Walking back from today lights today's
   * empty square the moment the clock passes midnight, which shows a streak
   * that has not been earned yet.
   */
  streakEndDay: string | null
  /** Length of that streak. A streak of 1 does not glow — it is just a day. */
  streakLength: number
}

export function buildHeatmap(input: HeatmapInput): Heatmap {
  const byDay = new Map(input.days.map((day) => [day.day, day]))
  const thresholds = levelThresholds(input.days)

  // The grid ends on the Saturday of `today`'s week, so the current week is
  // drawn in full rather than being cut off mid-column.
  const lastCell = addDays(startOfWeek(input.today), HEATMAP_ROWS - 1)
  const firstCell = addDays(lastCell, -(input.weeks * HEATMAP_ROWS - 1))

  const streak = streakDays(input.streakEndDay, input.streakLength)

  const columns: HeatmapCell[][] = []
  const monthLabels: { column: number; label: string }[] = []
  let seenMonth = ''

  for (let week = 0; week < input.weeks; week += 1) {
    const column: HeatmapCell[] = []
    for (let row = 0; row < HEATMAP_ROWS; row += 1) {
      const day = addDays(firstCell, week * HEATMAP_ROWS + row)
      const entry = byDay.get(day)
      const words = entry?.words ?? 0
      column.push({
        day,
        words,
        dictations: entry?.dictations ?? 0,
        level: levelFor(words, thresholds),
        inStreak: streak.has(day),
        future: day > input.today,
      })
    }
    columns.push(column)

    // Label a column when its first day opens a month the grid has not shown.
    const month = column[0]!.day.slice(0, 7)
    if (month !== seenMonth) {
      seenMonth = month
      monthLabels.push({ column: week, label: monthName(column[0]!.day) })
    }
  }

  return { columns, monthLabels }
}

/**
 * Four shading bands from the user's *own* history, not fixed word counts.
 *
 * Quartiles of the days actually dictated on, so the grid reads the same for
 * someone who writes 80 words a day and someone who writes 4,000. A fixed scale
 * would give the first user a uniformly pale year and the second a uniformly
 * dark one — in both cases a chart with no information in it.
 */
function levelThresholds(days: readonly InsightsDay[]): number[] {
  const counts = days
    .map((day) => day.words)
    .filter((words) => words > 0)
    .sort((a, b) => a - b)
  if (counts.length === 0) return [1, 1, 1, 1]

  const at = (fraction: number): number =>
    counts[Math.min(counts.length - 1, Math.floor(counts.length * fraction))]!

  // Deduplicated implicitly by `levelFor`, which takes the highest band the
  // value clears — equal thresholds simply collapse into fewer visible bands.
  return [1, at(0.25), at(0.5), at(0.75)]
}

function levelFor(words: number, thresholds: number[]): HeatmapCell['level'] {
  if (words <= 0) return 0
  let level: HeatmapCell['level'] = 1
  if (words >= thresholds[1]!) level = 2
  if (words >= thresholds[2]!) level = 3
  if (words >= thresholds[3]!) level = 4
  return level
}

/** The set of days the current streak covers, or empty when it should not glow. */
function streakDays(endDay: string | null, length: number): Set<string> {
  // A one-day streak is not a streak worth lighting up — it is today.
  if (!endDay || length < 2) return new Set()
  const days = new Set<string>()
  for (let offset = 0; offset < length; offset += 1) days.add(addDays(endDay, -offset))
  return days
}

/** The Sunday on or before `day`. */
export function startOfWeek(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
  return addDays(day, -weekday)
}

/** `YYYY-MM-DD` plus (or minus) whole days, via UTC so DST cannot bite. */
export function addDays(day: string, count: number): string {
  const ms = Date.parse(`${day}T00:00:00Z`) + count * 86_400_000
  return new Date(ms).toISOString().slice(0, 10)
}

function monthName(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    timeZone: 'UTC',
  })
}
