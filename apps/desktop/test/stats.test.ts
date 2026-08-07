import { describe, expect, it } from 'vitest'

import { averageWpm, computeStreak, countedText, countWords, dayKey } from '../src/main/store/stats'

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

describe('countedText', () => {
  it('prefers the polished text', () => {
    // Raw is 8 words, polished is 6. Counting both would give 14.
    expect(
      countWords(countedText('We should ship it on Wednesday.', 'um so we should uh ship it wed')),
    ).toBe(6)
  })

  it('falls back to the raw text when polishing produced nothing', () => {
    expect(countedText(null, 'one two three four')).toBe('one two three four')
  })

  it('treats a whitespace-only polished text as absent', () => {
    expect(countedText('   ', 'one two three')).toBe('one two three')
  })
})

describe('averageWpm — hand-computed fixtures', () => {
  it('is 0 before anything has been timed', () => {
    expect(averageWpm(0, 0)).toBe(0)
  })

  it('divides words by speaking time', () => {
    // 6 words in 6 s = 60 wpm exactly.
    expect(averageWpm(6, 6_000)).toBe(60)
    // 4 words in 12 s = 20 wpm.
    expect(averageWpm(4, 12_000)).toBe(20)
  })

  it('is a rate over the totals, not a mean of per-dictation rates', () => {
    // Dictation A: 2 words in 120 s → 1 wpm on its own.
    // Dictation B: 100 words in 60 s → 100 wpm on its own.
    // A mean of those rates is 50.5. The honest figure is 102 words / 3 min = 34.
    expect(averageWpm(102, 180_000)).toBe(34)
  })

  it('rounds to one decimal', () => {
    // 10 words in 7 s = 85.714… wpm → 85.7.
    expect(averageWpm(10, 7_000)).toBe(85.7)
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
})
