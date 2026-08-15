import { z } from 'zod'

import { AppCategorySchema } from './dictation'

/**
 * What the Insights section draws (PLAN §2.2.2).
 *
 * Every number here is computed on this machine from this machine's database.
 * There is no server, no cohort and no telemetry, which constrains what the UI
 * is allowed to claim: a percentile can be quoted against a *published typing
 * distribution* (below) but never against "other Murmur users", because that
 * population does not exist anywhere this app can see.
 *
 * The payload is bounded on purpose. `days` caps at 53 weeks and `apps` at the
 * top 24: this crosses an IPC boundary on every Hub open, and an unbounded
 * history would eventually make that a visible pause.
 */

/** 53 weeks — the widest the heatmap can ever show. */
export const INSIGHTS_MAX_DAYS = 371
/** How many apps the breakdown carries; the rest are summed into "Other apps". */
export const INSIGHTS_MAX_APPS = 24

export const InsightsDaySchema = z.object({
  /** Local-calendar `YYYY-MM-DD`, matching the store's `dayKey`. */
  day: z.string().length(10),
  words: z.number().int().nonnegative(),
  dictations: z.number().int().nonnegative(),
})
export type InsightsDay = z.infer<typeof InsightsDaySchema>

export const InsightsAppSchema = z.object({
  bundleId: z.string().min(1),
  /** The app's display name, or its bundle id when we never learned one. */
  name: z.string().min(1),
  category: AppCategorySchema,
  words: z.number().int().nonnegative(),
  dictations: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative(),
})
export type InsightsApp = z.infer<typeof InsightsAppSchema>

/**
 * The fixes Murmur made that the user did not have to.
 *
 * Three separate counts rather than one headline number, because they are three
 * different claims and only one of them involves a model:
 *
 *  - `dictionaryFixes` — replacement rules that actually fired;
 *  - `snippetExpansions` — triggers that actually expanded;
 *  - `wordsCleaned` — words the polishing model removed, measured as the drop
 *    from raw to polished. That is fillers, false starts and self-corrections,
 *    and it is an *estimate*: a rewrite that shortens a sentence counts here
 *    too. Never presented as "errors corrected".
 */
export const InsightsFixesSchema = z.object({
  dictionaryFixes: z.number().int().nonnegative(),
  snippetExpansions: z.number().int().nonnegative(),
  wordsCleaned: z.number().int().nonnegative(),
})
export type InsightsFixes = z.infer<typeof InsightsFixesSchema>

export const InsightsSchema = z.object({
  totals: z.object({
    words: z.number().int().nonnegative(),
    dictations: z.number().int().nonnegative(),
    spokenMs: z.number().int().nonnegative(),
    avgWpm: z.number().nonnegative(),
  }),
  fixes: InsightsFixesSchema,
  streak: z.object({
    current: z.number().int().nonnegative(),
    longest: z.number().int().nonnegative(),
    /** Last day the current streak covers, or `null` when there is no streak. */
    endDay: z.string().length(10).nullable(),
  }),
  /** Ascending by day, most recent last. Only days dictated on appear. */
  days: z.array(InsightsDaySchema),
  /**
   * The local calendar day main computed all of this against, `YYYY-MM-DD`.
   *
   * Shipped rather than re-derived in the renderer so the heatmap's right-hand
   * edge and the streak agree by construction. Two clocks read a millisecond
   * apart either side of midnight would otherwise disagree about what "today"
   * is, and the grid would draw a streak ending on a square it also draws as
   * empty.
   */
  today: z.string().length(10),
  /** Descending by words. */
  apps: z.array(InsightsAppSchema),
  /** Words from apps beyond {@link INSIGHTS_MAX_APPS}, or 0. */
  otherAppWords: z.number().int().nonnegative().default(0),
  /** False when the user has switched per-app collection off. */
  collecting: z.boolean(),
})
export type Insights = z.infer<typeof InsightsSchema>

// ---------------------------------------------------------------------------
// Presentation rules — pure, shared so the tests can pin them
// ---------------------------------------------------------------------------

/**
 * Words-per-minute against average *typing* speed, not against other users.
 *
 * The comparison is the honest one available offline: published typing-speed
 * studies put the average adult around 40 WPM, a competent office typist near
 * 60–70, and the top few percent above 100 (Dhakal et al., "Observations on
 * Typing from 136 Million Keystrokes", CHI 2018, n≈168k). Speaking beats typing
 * for almost everyone, which is the point the tile is making.
 *
 * Returns the percentage of typists this rate is faster than, clamped to 1–99
 * so the UI never claims a certainty a seven-point table cannot support.
 */
const TYPING_WPM_PERCENTILES: readonly (readonly [wpm: number, percentile: number])[] =
  Object.freeze([
    [20, 5],
    [30, 20],
    [40, 50],
    [50, 70],
    [60, 82],
    [75, 92],
    [90, 97],
    [110, 99],
  ])

export function fasterThanPercentOfTypists(wpm: number): number {
  if (wpm <= 0) return 0
  let percentile = 1
  for (const [threshold, value] of TYPING_WPM_PERCENTILES) {
    if (wpm >= threshold) percentile = value
    else break
  }
  return Math.min(99, Math.max(1, percentile))
}

/** How heavily an app is used, by lifetime words. Flow's own thresholds. */
export type UsageIntensity = 'light' | 'moderate' | 'power'

export function usageIntensity(words: number): UsageIntensity {
  if (words >= 10_000) return 'power'
  if (words >= 1_000) return 'moderate'
  return 'light'
}

export const USAGE_INTENSITY_LABEL: Record<UsageIntensity, string> = {
  light: 'Light use',
  moderate: 'Moderate use',
  power: 'Power use',
}

/**
 * Words in the current calendar month against the previous month's *whole*
 * total, as a percentage change.
 *
 * `null` when there is no previous month to compare with — the badge is hidden
 * rather than showing "+100%" against a month that did not happen. Comparing a
 * part-month against a full one is deliberate and matches what the label says
 * ("vs last month"): it answers "am I on track", and the alternative — a
 * same-day-of-month slice — reads as noise on the 1st.
 *
 * Takes the day key rather than a timestamp so it stays a pure function of the
 * payload — the renderer has no business reading the clock when main already
 * did (see `today` above).
 */
export function monthOverMonthChange(days: readonly InsightsDay[], today: string): number | null {
  const thisMonth = today.slice(0, 7)
  const lastMonth = previousMonth(thisMonth)

  let thisTotal = 0
  let lastTotal = 0
  for (const day of days) {
    const key = day.day.slice(0, 7)
    if (key === thisMonth) thisTotal += day.words
    else if (key === lastMonth) lastTotal += day.words
  }

  if (lastTotal === 0) return null
  return Math.round(((thisTotal - lastTotal) / lastTotal) * 100)
}

/** `2026-01` → `2025-12`. */
function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7))
  if (index === 1) return `${year - 1}-12`
  return `${year}-${`${index - 1}`.padStart(2, '0')}`
}
