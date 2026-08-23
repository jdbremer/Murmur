/**
 * Fuzzy matching for the command palette (PLAN §2.2.8).
 *
 * A palette lives or dies on this. Substring matching alone is too strict —
 * nobody types "vibe coding" in full, they type "vc" — and unscored
 * subsequence matching is too loose: every command containing the letters
 * s-e-t in order matches "set", so "Settings" competes with "Show recent
 * dictations" and the list stops being predictable.
 *
 * The rules, in the order they pay out:
 *
 *  1. A **prefix** of the text beats everything. Typing "his" should put
 *     History first and keep it there.
 *  2. A **substring** anywhere beats any subsequence, scored by how early it
 *     starts.
 *  3. A **subsequence** matches, scored by how much of it landed on word
 *     boundaries — which is what makes initials work: "vc" hits the `v` of
 *     Vibe and the `c` of coding, and outranks a command where the same two
 *     letters happen to sit mid-word.
 *
 * Shorter texts win ties, so an exact command never sits below a longer one
 * that merely contains it.
 */

const PREFIX_BASE = 10_000
const SUBSTRING_BASE = 5_000
const SUBSEQUENCE_BASE = 1_000
/** What each letter landing on a word boundary is worth. */
const BOUNDARY_BONUS = 60
/** What each letter immediately following the previous one is worth. */
const CONTIGUOUS_BONUS = 25

const isBoundary = (text: string, index: number): boolean => {
  if (index === 0) return true
  const previous = text[index - 1] ?? ''
  return previous === ' ' || previous === '-' || previous === '/' || previous === '.'
}

/**
 * How well `text` matches `query`, or null when it does not.
 *
 * Higher is better. An empty query matches everything with score 0, which
 * leaves the caller's own ordering intact — a palette opened and not yet typed
 * into should show its commands in the order they were declared, not in
 * alphabetical order or in whatever order a scorer happened to produce.
 */
export function fuzzyScore(text: string, query: string): number | null {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return 0

  const haystack = text.toLowerCase()
  // Length is the tiebreaker throughout: it never outweighs a tier, because
  // no text is 5,000 characters long in a command palette.
  const brevity = Math.max(0, 200 - haystack.length)

  if (haystack.startsWith(needle)) return PREFIX_BASE + brevity

  const at = haystack.indexOf(needle)
  if (at !== -1) {
    const boundary = isBoundary(haystack, at) ? BOUNDARY_BONUS * 2 : 0
    return SUBSTRING_BASE + boundary - at * 2 + brevity
  }

  let score = SUBSEQUENCE_BASE
  let cursor = 0
  let previousIndex = -2

  for (const character of needle) {
    const found = haystack.indexOf(character, cursor)
    if (found === -1) return null
    if (isBoundary(haystack, found)) score += BOUNDARY_BONUS
    if (found === previousIndex + 1) score += CONTIGUOUS_BONUS
    // Every skipped character costs a little, so a match that ranges over the
    // whole string ranks below a tight one.
    score -= Math.min(20, found - cursor)
    previousIndex = found
    cursor = found + 1
  }

  return score + brevity
}

/**
 * The best score across a command's title and its keywords.
 *
 * A keyword match is worth **half** a title match, which is a whole tier: a
 * keyword hit at the strongest tier lands level with a title hit at the next
 * one down. That is the behaviour you want in both directions — "notes" finds
 * Scratchpad, but never above a command actually called Notes, and typing
 * "the" surfaces the commands whose titles say *theme* rather than the one
 * that merely lists it as a synonym.
 *
 * A flat discount cannot do this. Subtracting a few hundred points leaves a
 * keyword *prefix* (top tier) still comfortably above a title *substring*, so
 * a synonym on one command beats the real word on another.
 */
const KEYWORD_WEIGHT = 0.5

export function scoreCommand(
  candidate: { title: string; keywords?: readonly string[] | undefined },
  query: string,
): number | null {
  const title = fuzzyScore(candidate.title, query)
  let best = title

  for (const keyword of candidate.keywords ?? []) {
    const score = fuzzyScore(keyword, query)
    if (score === null) continue
    const discounted = score * KEYWORD_WEIGHT
    if (best === null || discounted > best) best = discounted
  }

  return best
}

/**
 * Rank a list, dropping what does not match.
 *
 * A stable sort on the original order, so an empty query — where everything
 * scores 0 — leaves the declared grouping exactly as it was.
 */
export function rankBy<T extends { title: string; keywords?: readonly string[] | undefined }>(
  items: readonly T[],
  query: string,
): T[] {
  return items
    .map((item, index) => ({ item, index, score: scoreCommand(item, query) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item)
}
