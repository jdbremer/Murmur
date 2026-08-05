import type { HistoryStats } from '@murmur/shared'

/**
 * The Home header's numbers (PLAN §2.2.1, §13 M4).
 *
 * Pure functions over plain rows, separate from the repository, because these
 * are the definitions most likely to be argued about later and the ones a test
 * can pin to hand-computed fixtures. Every rule below is a decision, not an
 * accident:
 *
 *  - **totalWords** counts the text the user actually got — polished where
 *    polishing produced something, raw otherwise. Counting both would
 *    double-count every dictation.
 *  - **avgWpm** is words ÷ speaking time, not an average of per-row rates. A
 *    three-word "yes, sounds good" would otherwise skew the number as heavily
 *    as a two-minute ramble. A row with no recorded duration is excluded from
 *    *both* sides of that fraction — counting its words while ignoring its time
 *    would inflate the rate — though it still counts towards `totalWords`.
 *  - **streakDays** counts consecutive *local* calendar days ending today or
 *    yesterday. Ending yesterday still counts: a streak should not break at
 *    midnight before the user has had a chance to dictate.
 */

export interface StatsRow {
  /** Epoch milliseconds. */
  ts: number
  rawText: string
  polishedText: string | null
  /** Length of the utterance's audio, in milliseconds. */
  durationMs: number
}

/** Whitespace-delimited words. Punctuation stays attached, as a human would count. */
export function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

/** Local-time day key, `YYYY-MM-DD`. */
export function dayKey(ts: number, timeZoneOffsetMinutes?: number): string {
  const date = new Date(ts)
  if (timeZoneOffsetMinutes !== undefined) {
    // Tests pin a fixed offset so the result does not depend on the runner's TZ.
    const shifted = new Date(ts - timeZoneOffsetMinutes * 60_000)
    return shifted.toISOString().slice(0, 10)
  }
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export interface StatsOptions {
  /** Epoch ms treated as "now"; injected so streaks are testable. */
  now?: number
  /** Minutes to subtract before bucketing into days. Tests only. */
  timeZoneOffsetMinutes?: number
}

export function computeStats(rows: readonly StatsRow[], options: StatsOptions = {}): HistoryStats {
  const now = options.now ?? Date.now()

  let totalWords = 0
  // Numerator and denominator of the rate, kept together so a row can only
  // contribute to both or to neither.
  let timedWords = 0
  let spokenMs = 0
  const days = new Set<string>()

  for (const row of rows) {
    const text = row.polishedText && row.polishedText.trim() ? row.polishedText : row.rawText
    const words = countWords(text)
    totalWords += words
    if (row.durationMs > 0 && words > 0) {
      timedWords += words
      spokenMs += row.durationMs
    }
    days.add(dayKey(row.ts, options.timeZoneOffsetMinutes))
  }

  const avgWpm = spokenMs > 0 ? timedWords / (spokenMs / 60_000) : 0

  return {
    totalWords,
    // One decimal is all the Hub renders; rounding here keeps the IPC payload
    // and the golden fixtures free of float noise.
    avgWpm: Math.round(avgWpm * 10) / 10,
    streakDays: computeStreak(days, now, options.timeZoneOffsetMinutes),
  }
}

/**
 * Length of the run of consecutive days ending today (or yesterday).
 *
 * Returns 0 when the most recent dictation is older than yesterday — the streak
 * is over, not paused.
 */
export function computeStreak(
  days: ReadonlySet<string>,
  now: number,
  timeZoneOffsetMinutes?: number,
): number {
  if (days.size === 0) return 0

  const today = dayKey(now, timeZoneOffsetMinutes)
  const yesterday = dayKey(now - 86_400_000, timeZoneOffsetMinutes)

  let cursor: string
  if (days.has(today)) cursor = today
  else if (days.has(yesterday)) cursor = yesterday
  else return 0

  let streak = 0
  let cursorMs = Date.parse(`${cursor}T00:00:00Z`)
  while (days.has(dayKeyFromUtcMidnight(cursorMs))) {
    streak += 1
    cursorMs -= 86_400_000
  }
  return streak
}

/**
 * Day key for a timestamp already normalised to UTC midnight.
 *
 * Kept separate from {@link dayKey} on purpose: walking the streak backwards
 * must not re-apply the timezone shift, or a day would be skipped near a DST
 * boundary.
 */
function dayKeyFromUtcMidnight(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
