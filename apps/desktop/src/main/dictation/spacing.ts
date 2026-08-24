/**
 * Keep dictations from running into each other.
 *
 * Dictating in bursts — stop, go, stop, go — used to produce
 * "Ship it Wednesday.How are we doing on the docs?", because each insertion
 * lands exactly where the cursor is and the cursor is hard against the last
 * character of the one before it. Nothing in the pipeline had an opinion about
 * the join.
 *
 * ## Two rules, because there are two situations
 *
 * When the platform can tell us what is before the cursor, the right edit is a
 * **leading** space, decided from that context. It is precise: it fires after
 * "Wednesday." and stays quiet at the start of an empty field, after a line
 * break, and after an opening bracket. It also fixes the case a trailing space
 * cannot — text the user *typed* themselves and then dictated onto the end of.
 *
 * When the platform cannot — `getTextBeforeCursor` returns `null` for any app
 * that does not expose the parameterised accessibility attribute, which
 * includes a good deal of Electron — there is no context to reason from. The
 * fallback is a **trailing** space: the one edit that makes the *next*
 * insertion land cleanly without needing to see anything at all.
 *
 * The two compose safely. A trailing space left by one dictation is whitespace
 * to the next one's leading-space check, so nothing ever doubles up.
 *
 * ## Why a space is cheap and a missing one is not
 *
 * The asymmetry runs the other way from `sentence-case.ts`, which keeps a
 * capital whenever it is unsure. A stray trailing space is invisible in every
 * chat app (they trim on send) and in every search field. Two sentences welded
 * together are not invisible: they have to be found and fixed by hand.
 */

/**
 * Characters that bind to whatever follows them.
 *
 * A space after any of these is wrong rather than merely unnecessary:
 * "well-" + "known", "https://" + "example.com", "@" + "priya", "(" + "see
 * below". Opening quotes are here for the same reason closing ones are not.
 */
const JOINS_TO_NEXT = /[([{<@#/\\\-_~+*=“‘]$/

/**
 * A straight quote is whichever end of the quotation it happens to be.
 *
 * `"` opens in `he said "` and closes in `"shipped it"`, and the character is
 * identical either way — the smart quotes above need no such help. The
 * character *before* it decides: an opening quote follows a space or nothing,
 * a closing one follows the word it closed. Possessives land on the right side
 * of this by accident and by luck — `the dogs'` closes, and wants its space.
 */
const STRAIGHT_QUOTE = /["']$/

function opensQuotation(before: string): boolean {
  if (!STRAIGHT_QUOTE.test(before)) return false
  const preceding = before.slice(-2, -1)
  return preceding === '' || /\s/.test(preceding)
}

/**
 * Should the insertion carry a leading space?
 *
 * @param before Text immediately preceding the insertion point — a handful of
 *   characters is plenty. `null` means the platform could not read it, which
 *   is not the same as an empty field, and is handled by the caller rather
 *   than guessed at here.
 */
export function needsLeadingSpace(before: string | null): boolean {
  if (before === null) return false

  // An empty field, or the very start of one.
  if (before.length === 0 || before.trim().length === 0) return false

  // Already separated — by a space, a tab, or a line break.
  if (/\s$/.test(before)) return false

  if (opensQuotation(before)) return false
  return !JOINS_TO_NEXT.test(before)
}

/**
 * Space the text so it joins cleanly to whatever it is landing next to.
 *
 * Applied at the point of insertion only: the history row keeps the sentence
 * the user actually said, unpadded.
 */
export function padForCursor(text: string, before: string | null): string {
  // Nothing to space. An empty insertion is already a no-op upstream, but a
  // lone " " pasted into a document would be a visible one.
  if (text.length === 0) return text

  if (before === null) {
    // No context to reason from. Set up the *next* dictation instead.
    return /\s$/.test(text) ? text : `${text} `
  }

  if (needsLeadingSpace(before) && !/^\s/.test(text)) return ` ${text}`
  return text
}
