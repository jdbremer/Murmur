import type { InsightsDay } from '@murmur/shared'

import { addDays } from './heatmap'

/**
 * The last `count` days as a dense series of word counts, oldest first.
 *
 * The payload's `days` array only contains days that were dictated on, which
 * is the right shape to *send* — a year of mostly-empty days is a lot of zeroes
 * to serialise for a heatmap that can look them up. It is the wrong shape to
 * *plot*: a sparkline drawn straight from it would space three dictations a
 * fortnight apart evenly across the chart and read as steady daily use.
 *
 * Zero-filling here is what makes the gaps visible as gaps.
 */
export function dailyWords(days: readonly InsightsDay[], today: string, count = 14): number[] {
  const byDay = new Map(days.map((day) => [day.day, day.words]))
  const series: number[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    series.push(byDay.get(addDays(today, -offset)) ?? 0)
  }
  return series
}
