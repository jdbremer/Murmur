import { describe, expect, it } from 'vitest'

import type { InsightsDay } from '@murmur/shared'

import {
  addDays,
  buildHeatmap,
  startOfWeek,
  type HeatmapCell,
} from '../src/renderer/hub/sections/insights/heatmap'

/**
 * The streak grid's layout (PLAN §2.2.2).
 *
 * Every bug this component can have is an off-by-one in date arithmetic, and
 * none of them are visible in a screenshot — a grid shifted by one day looks
 * exactly like a grid that is right. So the fixtures below are hand-written
 * calendars, not derived from the implementation.
 *
 * August 2026 for reference:
 *
 *     Su Mo Tu We Th Fr Sa
 *                        1
 *      2  3  4  5  6  7  8
 *      9 10 11 12 13 14 15
 */

const day = (iso: string, words: number, dictations = 1): InsightsDay => ({
  day: iso,
  words,
  dictations,
})

/** Every cell in the grid, flattened, so a fixture can be looked up by date. */
const cellsByDay = (columns: HeatmapCell[][]): Map<string, HeatmapCell> =>
  new Map(columns.flat().map((cell) => [cell.day, cell]))

describe('addDays / startOfWeek', () => {
  it('steps whole days across a month boundary', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01')
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31')
  })

  it('steps across a DST boundary without skipping or repeating a day', () => {
    // US DST ends 2026-11-01. A local-time +24h step lands back on the 1st.
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
    // And EU DST starts 2026-03-29.
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30')
  })

  it('finds the Sunday on or before a day', () => {
    expect(startOfWeek('2026-08-12')).toBe('2026-08-09') // a Wednesday
    expect(startOfWeek('2026-08-09')).toBe('2026-08-09') // already Sunday
    expect(startOfWeek('2026-08-15')).toBe('2026-08-09') // Saturday
  })
})

describe('buildHeatmap', () => {
  const base = {
    today: '2026-08-12',
    weeks: 3,
    streakEndDay: null,
    streakLength: 0,
  }

  it('ends on the Saturday of today’s week, so the week is drawn in full', () => {
    const { columns } = buildHeatmap({ ...base, days: [] })

    expect(columns).toHaveLength(3)
    expect(columns.at(-1)!.at(-1)!.day).toBe('2026-08-15')
    // Three weeks back from that Saturday.
    expect(columns[0]![0]!.day).toBe('2026-07-26')
  })

  it('marks days after today as holes rather than empty days', () => {
    const cells = cellsByDay(buildHeatmap({ ...base, days: [] }).columns)

    expect(cells.get('2026-08-12')!.future).toBe(false)
    expect(cells.get('2026-08-13')!.future).toBe(true)
    expect(cells.get('2026-08-15')!.future).toBe(true)
  })

  it('carries the words and dictations for each day it has', () => {
    const cells = cellsByDay(
      buildHeatmap({ ...base, days: [day('2026-08-10', 420, 7)] }).columns,
    ).get('2026-08-10')!

    expect(cells.words).toBe(420)
    expect(cells.dictations).toBe(7)
    expect(cells.level).toBeGreaterThan(0)
  })

  it('shades by the user’s own quartiles, not a fixed word count', () => {
    // A light user: 20 words is their busiest day and must still read as busy.
    const light = cellsByDay(
      buildHeatmap({
        ...base,
        days: [day('2026-08-03', 2), day('2026-08-05', 8), day('2026-08-10', 20)],
      }).columns,
    )
    expect(light.get('2026-08-10')!.level).toBe(4)
    expect(light.get('2026-08-03')!.level).toBeLessThan(4)
  })

  describe('the streak glow', () => {
    it('ends on the last day dictated, never on today’s empty square', () => {
      // The streak runs to the 11th; today is the 12th and has nothing in it.
      const cells = cellsByDay(
        buildHeatmap({
          ...base,
          days: [day('2026-08-10', 100), day('2026-08-11', 100)],
          streakEndDay: '2026-08-11',
          streakLength: 2,
        }).columns,
      )

      expect(cells.get('2026-08-10')!.inStreak).toBe(true)
      expect(cells.get('2026-08-11')!.inStreak).toBe(true)
      // The bug this test exists for: today is empty and must not glow.
      expect(cells.get('2026-08-12')!.inStreak).toBe(false)
      expect(cells.get('2026-08-09')!.inStreak).toBe(false)
    })

    it('does not glow for a one-day streak — that is a day, not a streak', () => {
      const cells = cellsByDay(
        buildHeatmap({
          ...base,
          days: [day('2026-08-12', 100)],
          streakEndDay: '2026-08-12',
          streakLength: 1,
        }).columns,
      )

      expect(cells.get('2026-08-12')!.inStreak).toBe(false)
    })

    it('does not glow when the streak is over', () => {
      const cells = cellsByDay(
        buildHeatmap({
          ...base,
          days: [day('2026-08-01', 100), day('2026-08-02', 100)],
          streakEndDay: null,
          streakLength: 0,
        }).columns,
      )

      expect([...cells.values()].some((cell) => cell.inStreak)).toBe(false)
    })

    it('walks back across a month boundary', () => {
      const cells = cellsByDay(
        buildHeatmap({
          ...base,
          days: [day('2026-07-31', 100), day('2026-08-01', 100), day('2026-08-02', 100)],
          streakEndDay: '2026-08-02',
          streakLength: 3,
        }).columns,
      )

      expect(cells.get('2026-07-31')!.inStreak).toBe(true)
      expect(cells.get('2026-07-30')!.inStreak).toBe(false)
    })
  })

  it('labels a column when it opens a month the grid has not shown', () => {
    const { monthLabels } = buildHeatmap({ ...base, days: [] })

    // Columns start 26 Jul, 2 Aug, 9 Aug — two distinct months.
    expect(monthLabels.map((label) => label.column)).toEqual([0, 1])
  })
})
