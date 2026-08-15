import { describe, expect, it } from 'vitest'

import {
  fasterThanPercentOfTypists,
  monthOverMonthChange,
  usageIntensity,
  type InsightsDay,
} from '../src/domain/insights'

/**
 * The Insights section's presentation rules (PLAN §2.2.2).
 *
 * These are the numbers most at risk of being plausibly wrong rather than
 * visibly broken, so every expectation below is derived by hand rather than
 * read off the implementation.
 */

describe('fasterThanPercentOfTypists', () => {
  it('places a rate against the typing distribution', () => {
    expect(fasterThanPercentOfTypists(40)).toBe(50)
    expect(fasterThanPercentOfTypists(60)).toBe(82)
    expect(fasterThanPercentOfTypists(110)).toBe(99)
  })

  it('takes the highest threshold the rate clears, not the nearest', () => {
    // 74 clears 60 but not 75, so it stays at the 60 bucket rather than
    // rounding up into a claim the table does not support.
    expect(fasterThanPercentOfTypists(74)).toBe(82)
    expect(fasterThanPercentOfTypists(75)).toBe(92)
  })

  it('never claims certainty a seven-point table cannot support', () => {
    // Far above the last threshold is still 99, not 100: there is no local
    // evidence that nobody types faster.
    expect(fasterThanPercentOfTypists(400)).toBe(99)
    // Below the first threshold is 1, not 0.
    expect(fasterThanPercentOfTypists(5)).toBe(1)
  })

  it('is 0 with nothing measured, so the tile can hide rather than claim', () => {
    expect(fasterThanPercentOfTypists(0)).toBe(0)
  })
})

describe('usageIntensity', () => {
  it('splits at the thresholds, inclusive at the bottom of each band', () => {
    expect(usageIntensity(999)).toBe('light')
    expect(usageIntensity(1_000)).toBe('moderate')
    expect(usageIntensity(9_999)).toBe('moderate')
    expect(usageIntensity(10_000)).toBe('power')
  })
})

describe('monthOverMonthChange', () => {
  const day = (iso: string, words: number): InsightsDay => ({ day: iso, words, dictations: 1 })
  const today = '2026-08-15'

  it('compares this month so far against all of last month', () => {
    // July: 100 + 100 = 200. August so far: 300. (300 − 200) / 200 = +50%.
    expect(
      monthOverMonthChange(
        [day('2026-07-04', 100), day('2026-07-20', 100), day('2026-08-01', 300)],
        today,
      ),
    ).toBe(50)
  })

  it('reports a fall as a negative', () => {
    expect(monthOverMonthChange([day('2026-07-04', 400), day('2026-08-01', 300)], today)).toBe(-25)
  })

  it('is null with no previous month — the badge hides rather than claims +100%', () => {
    expect(monthOverMonthChange([day('2026-08-01', 300)], today)).toBeNull()
    expect(monthOverMonthChange([], today)).toBeNull()
  })

  it('ignores months either side of the comparison', () => {
    // June must not leak into the July figure.
    expect(
      monthOverMonthChange(
        [day('2026-06-01', 9_999), day('2026-07-04', 200), day('2026-08-01', 300)],
        today,
      ),
    ).toBe(50)
  })

  it('handles the January boundary, where "last month" is another year', () => {
    expect(
      monthOverMonthChange([day('2025-12-20', 200), day('2026-01-03', 300)], '2026-01-15'),
    ).toBe(50)
  })
})
