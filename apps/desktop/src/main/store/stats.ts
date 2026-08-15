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
 * How many words polishing took out — the "words cleaned up" figure.
 *
 * Measured as the drop from raw to polished, and deliberately floored at zero:
 * a Rewrite-level pass that *adds* words has not un-cleaned anything, and a
 * negative contribution to a lifetime counter would let one verbose rewrite
 * erase a hundred genuine filler removals.
 *
 * It is an estimate and the UI must say so. At Clean level it is very nearly
 * exactly the fillers and false starts; at Rewrite level a shortened sentence
 * counts here too. What it is *not* is a count of errors corrected — nothing in
 * this pipeline knows what the user meant to say.
 */
export function wordsRemovedByPolish(rawText: string, polishedText: string | null): number {
  if (!polishedText || !polishedText.trim()) return 0
  return Math.max(0, countWords(rawText) - countWords(polishedText))
}

/**
 * The last day the current streak actually covers — today or yesterday.
 *
 * Returns `null` when there is no live streak. The Insights heatmap needs this
 * separately from the streak's *length* because the glow has to stop on a day
 * the user really dictated: drawing it from "today minus `streakDays`" lights
 * today's empty square the moment the clock passes midnight, which reads as a
 * streak the user has not earned yet. (Flow shipped exactly that bug.)
 */
export function streakEndDay(
  days: ReadonlySet<string>,
  now: number,
  timeZoneOffsetMinutes?: number,
): string | null {
  const today = dayKey(now, timeZoneOffsetMinutes)
  if (days.has(today)) return today
  const yesterday = dayKey(now - 86_400_000, timeZoneOffsetMinutes)
  return days.has(yesterday) ? yesterday : null
}

/**
 * The longest run of consecutive days in the whole set, live or not.
 *
 * Unlike {@link computeStreak} this is anchored to nothing — it is a fact about
 * the history rather than about today, so it never falls when the user takes a
 * day off. That is the whole reason it is worth showing beside the current one.
 */
export function longestStreak(days: ReadonlySet<string>): number {
  let longest = 0
  for (const day of days) {
    // Only start counting from a day that begins a run, so each run is walked
    // once rather than once per member.
    const previous = dayKeyFromUtcMidnight(Date.parse(`${day}T00:00:00Z`) - 86_400_000)
    if (days.has(previous)) continue

    let run = 0
    let cursor = Date.parse(`${day}T00:00:00Z`)
    while (days.has(dayKeyFromUtcMidnight(cursor))) {
      run += 1
      cursor += 86_400_000
    }
    if (run > longest) longest = run
  }
  return longest
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
