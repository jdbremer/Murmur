import type { Formality } from '@murmur/shared'

/**
 * Drop the closing full stop on a chat message (PLAN §7.4, Styles).
 *
 * Nobody punctuates the end of a text message, and a dictation tool that does
 * makes every message read as clipped or annoyed — the "ok." problem. The
 * reference product removes the trailing period in messaging apps, keyed on
 * the writing style, and this is that rule.
 *
 * Done in code rather than in the prompt because it is a mechanical,
 * fully-specified edit with a right answer, and the polish model is neither
 * reliable at it nor always run (short utterances skip polishing entirely).
 *
 * The guards below are all "when NOT to", because the failure mode is
 * asymmetric: leaving a period costs nothing, and removing the wrong one
 * corrupts an ellipsis, an abbreviation, or a decimal.
 */

/** Tones informal enough that a closing full stop reads as stiff. */
const INFORMAL: readonly Formality[] = Object.freeze(['veryCasual', 'casual', 'excited'])

export interface TrailingPeriodContext {
  /** Whether the target app is a chat app — see isMessagingApp. */
  messaging: boolean
  formality: Formality
}

export function stripTrailingPeriod(text: string, context: TrailingPeriodContext): string {
  if (!context.messaging) return text
  if (!INFORMAL.includes(context.formality)) return text

  const trimmed = text.trimEnd()
  if (!trimmed.endsWith('.')) return text

  // Multi-line output is a list or a dictated "new paragraph" — structured
  // writing, where the last line's full stop is not the message's sign-off.
  if (/[\n\r]/.test(trimmed)) return text

  const withoutPeriod = trimmed.slice(0, -1)

  // "..." and "etc." keep theirs: an ellipsis is a deliberate mark and an
  // abbreviation's period belongs to the word, not to the sentence.
  if (withoutPeriod.endsWith('.')) return text
  if (ABBREVIATIONS.has(lastWord(withoutPeriod))) return text
  // A single letter before the stop is an initial ("…signed, J.") or a decimal
  // fragment; neither is a sentence ending.
  if (/(?:^|\s)[A-Za-z0-9]$/.test(withoutPeriod)) return text

  return withoutPeriod
}

/**
 * Short forms whose full stop is part of the word. Only the ones that
 * plausibly end a chat message — a longer list would be guessing.
 */
const ABBREVIATIONS = new Set(['etc', 'eg', 'ie', 'vs', 'approx', 'inc', 'ltd', 'jr', 'sr'])

/**
 * The trailing token, with any internal periods removed.
 *
 * The dots have to come along and then be dropped: "i.e." arrives here as
 * "i.e" once the final stop is off, and matching letters alone would see "e"
 * and conclude it was an ordinary word.
 */
function lastWord(text: string): string {
  const match = /([A-Za-z.]+)$/.exec(text)
  return (match?.[1] ?? '').replace(/\./g, '').toLowerCase()
}
