/**
 * The definitions behind the Home header's numbers (PLAN §2.2.1, §13 M4).
 *
 * Pure functions, separate from the repository, because these are the rules
 * most likely to be argued about later and the ones a test can pin to
 * hand-computed fixtures. The repository applies them incrementally — see
 * `DictationsRepository.insert` — rather than aggregating over the history
 * table, because the stats are lifetime figures and the history is subject to a
 * retention policy that deletes rows out from under them.
 *
 * Every rule here is a decision, not an accident:
 *
 *  - **totalWords** counts the text the user actually got — polished where
 *    polishing produced something, raw otherwise. Counting both would
 *    double-count every dictation.
 *  - **avgWpm** is words ÷ speaking time, not an average of per-row rates. A
 *    three-word "yes, sounds good" would otherwise skew the number as heavily
 *    as a two-minute ramble. A dictation with no recorded duration is excluded
 *    from *both* sides of that fraction — counting its words while ignoring its
 *    time would inflate the rate — though it still counts towards `totalWords`.
 *  - **streakDays** counts consecutive *local* calendar days ending today or
 *    yesterday. Ending yesterday still counts: a streak should not break at
 *    midnight before the user has had a chance to dictate.
 */

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

/**
 * The text a dictation contributes to the word count: polished where polishing
 * produced something, raw otherwise.
 */
export function countedText(polishedText: string | null, rawText: string): string {
  return polishedText && polishedText.trim() ? polishedText : rawText
}

/**
 * Words per minute from the running totals.
 *
 * One decimal is all the Hub renders; rounding here keeps the IPC payload and
 * the golden fixtures free of float noise.
 */
export function averageWpm(timedWords: number, spokenMs: number): number {
  if (spokenMs <= 0) return 0
  return Math.round((timedWords / (spokenMs / 60_000)) * 10) / 10
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
