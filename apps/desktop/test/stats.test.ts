import { describe, expect, it } from 'vitest'

import {
  computeStats,
  computeStreak,
  countWords,
  dayKey,
  type StatsRow,
} from '../src/main/store/stats'

/**
 * History stats (PLAN §2.2.1, §13 M4: "stats match hand-computed fixtures").
 *
 * Each number below is worked out by hand in the comment above it, because the
 * failure mode for a stats function is not a crash — it is a plausible-looking
 * number that is quietly wrong, and only an independently-derived expectation
 * catches that.
 */

/** UTC, so the fixtures do not depend on the runner's timezone. */
const UTC = 0
const day = (iso: string): number => Date.parse(`${iso}T12:00:00Z`)

describe('countWords', () => {
  it('counts whitespace-delimited words', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('   ')).toBe(0)
    expect(countWords('one')).toBe(1)
    expect(countWords('We should ship it on Wednesday.')).toBe(6)
    expect(countWords('  spaced   out  words ')).toBe(3)
    expect(countWords('line\nbreaks\tcount')).toBe(3)
  })
})

describe('dayKey', () => {
  it('buckets by calendar day at a fixed offset', () => {
    expect(dayKey(Date.parse('2026-08-01T23:59:00Z'), UTC)).toBe('2026-08-01')
    expect(dayKey(Date.parse('2026-08-02T00:01:00Z'), UTC)).toBe('2026-08-02')
  })
})

describe('computeStats — hand-computed fixtures', () => {
  it('is all zeros for an empty history', () => {
    expect(computeStats([])).toEqual({ totalWords: 0, avgWpm: 0, streakDays: 0 })
  })

  it('counts the polished text, not both texts', () => {
    // Raw is 8 words, polished is 6. Counting both would give 14.
    const rows: StatsRow[] = [
      {
        ts: day('2026-08-01'),
        rawText: 'um so we should uh ship it wednesday',
        polishedText: 'We should ship it on Wednesday.',
        durationMs: 6_000,
      },
    ]
    const stats = computeStats(rows, { now: day('2026-08-01'), timeZoneOffsetMinutes: UTC })

    expect(stats.totalWords).toBe(6)
    // 6 words in 6 s = 60 wpm exactly.
    expect(stats.avgWpm).toBe(60)
    expect(stats.streakDays).toBe(1)
  })

  it('falls back to the raw text when polishing produced nothing', () => {
    const rows: StatsRow[] = [
      {
        ts: day('2026-08-01'),
        rawText: 'one two three four',
        polishedText: null,
        durationMs: 12_000,
      },
    ]
    // 4 words in 12 s = 20 wpm.
    expect(
      computeStats(rows, { now: day('2026-08-01'), timeZoneOffsetMinutes: UTC }),
    ).toMatchObject({ totalWords: 4, avgWpm: 20 })
  })

  it('treats a whitespace-only polished text as absent', () => {
    const rows: StatsRow[] = [
      { ts: day('2026-08-01'), rawText: 'one two three', polishedText: '   ', durationMs: 6_000 },
    ]
    expect(
      computeStats(rows, { now: day('2026-08-01'), timeZoneOffsetMinutes: UTC }).totalWords,
    ).toBe(3)
  })

  it('computes WPM over total speaking time, not as a mean of per-row rates', () => {
    // Row A: 2 words in 60 s → 2 wpm on its own.
    // Row B: 100 words in 60 s → 100 wpm on its own.
    // Mean of rates would be 51. Total-over-total is 102 words / 2 min = 51…
    // — so make them unequal in duration to tell the two apart:
    // Row A: 2 words in 120 s. Row B: 100 words in 60 s.
    // Mean of rates: (1 + 100) / 2 = 50.5. Correct: 102 / 3 min = 34.
    const rows: StatsRow[] = [
      { ts: day('2026-08-01'), rawText: 'one two', polishedText: null, durationMs: 120_000 },
      {
        ts: day('2026-08-01'),
        rawText: Array.from({ length: 100 }, (_v, index) => `w${index}`).join(' '),
        polishedText: null,
        durationMs: 60_000,
      },
    ]
    const stats = computeStats(rows, { now: day('2026-08-01'), timeZoneOffsetMinutes: UTC })

    expect(stats.totalWords).toBe(102)
    expect(stats.avgWpm).toBe(34)
  })

  it('counts a zero-duration row’s words but keeps it out of the rate entirely', () => {
    const rows: StatsRow[] = [
      { ts: day('2026-08-01'), rawText: 'one two three', polishedText: null, durationMs: 6_000 },
      { ts: day('2026-08-01'), rawText: 'four five six', polishedText: null, durationMs: 0 },
    ]
    // All 6 words count towards the headline total. The rate uses only the
    // timed row — 3 words in 6 s = 30 wpm. Counting the untimed row's words
    // against the timed row's seconds would report 60, which is a lie.
    const stats = computeStats(rows, { now: day('2026-08-01'), timeZoneOffsetMinutes: UTC })
    expect(stats.totalWords).toBe(6)
    expect(stats.avgWpm).toBe(30)
  })

  it('rounds WPM to one decimal', () => {
    // 10 words in 7 s = 85.714… wpm → 85.7.
    const rows: StatsRow[] = [
      {
        ts: day('2026-08-01'),
        rawText: 'a b c d e f g h i j',
        polishedText: null,
        durationMs: 7_000,
      },
    ]
    expect(computeStats(rows, { now: day('2026-08-01'), timeZoneOffsetMinutes: UTC }).avgWpm).toBe(
      85.7,
    )
  })
})

describe('computeStreak', () => {
  const days = (...isoDays: string[]): Set<string> => new Set(isoDays)

  it('is 0 with no dictations', () => {
    expect(computeStreak(new Set(), day('2026-08-05'), UTC)).toBe(0)
  })

  it('counts consecutive days ending today', () => {
    expect(
      computeStreak(days('2026-08-03', '2026-08-04', '2026-08-05'), day('2026-08-05'), UTC),
    ).toBe(3)
  })

  it('still counts a streak that ends yesterday — midnight must not break it', () => {
    expect(computeStreak(days('2026-08-03', '2026-08-04'), day('2026-08-05'), UTC)).toBe(2)
  })

  it('is 0 when the last dictation is older than yesterday', () => {
    expect(computeStreak(days('2026-08-01', '2026-08-02'), day('2026-08-05'), UTC)).toBe(0)
  })

  it('stops at the first gap rather than counting every active day', () => {
    // 1, 2, then a gap, then 4 and 5. The streak is 2, not 4.
    expect(
      computeStreak(
        days('2026-08-01', '2026-08-02', '2026-08-04', '2026-08-05'),
        day('2026-08-05'),
        UTC,
      ),
    ).toBe(2)
  })

  it('counts a single day', () => {
    expect(computeStreak(days('2026-08-05'), day('2026-08-05'), UTC)).toBe(1)
  })

  it('walks across a month boundary', () => {
    expect(
      computeStreak(days('2026-07-30', '2026-07-31', '2026-08-01'), day('2026-08-01'), UTC),
    ).toBe(3)
  })

  it('walks across a leap day', () => {
    expect(
      computeStreak(days('2028-02-28', '2028-02-29', '2028-03-01'), day('2028-03-01'), UTC),
    ).toBe(3)
  })

  it('is reachable through computeStats', () => {
    const rows: StatsRow[] = ['2026-08-03', '2026-08-04', '2026-08-05'].map((iso) => ({
      ts: day(iso),
      rawText: 'one two three',
      polishedText: null,
      durationMs: 3_000,
    }))
    expect(
      computeStats(rows, { now: day('2026-08-05'), timeZoneOffsetMinutes: UTC }).streakDays,
    ).toBe(3)
  })
})
