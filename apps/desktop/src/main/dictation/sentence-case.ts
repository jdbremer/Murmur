/**
 * Match the capitalisation of whatever the cursor is sitting in.
 *
 * The polish model always returns a properly-formed sentence, which is right
 * when you dictate into an empty field and wrong the moment you dictate into
 * the middle of one. Typing "and then we shipped it" after an existing
 * "I rewrote the parser " gives you "I rewrote the parser And then we shipped
 * it" — a capital that no one asked for and that reads as a typo.
 *
 * The reference product calls this context awareness and describes it as
 * lowercasing the start of a dictation so it flows with the surrounding text.
 * This is that rule, kept as a pure function so the decision is testable
 * without an accessibility API, a focused window, or a running app.
 *
 * ## Why it is conservative
 *
 * The input is at most a handful of characters read from the focused element,
 * and the two mistakes are not equal. Failing to lowercase leaves a capital
 * mid-sentence: mildly wrong, obvious, easy for the user to fix. Lowercasing
 * when it should not have leaves a sentence starting in lower case, which
 * looks like the app is broken. So every ambiguous case keeps the capital.
 */

/**
 * Does the text immediately before the cursor look like an unfinished sentence?
 *
 * @param before Text preceding the insertion point — a few characters is
 *   enough. `null` means the platform could not read it, which is not the same
 *   as an empty field: unknown must never trigger a change.
 */
export function continuesSentence(before: string | null): boolean {
  if (before === null) return false

  // An empty field, or the very start of one: a capital is correct.
  if (before.trim().length === 0) return false

  // A line break resets the thought even when the previous line had no full
  // stop — a new bullet, a new paragraph, a fresh cell.
  if (/[\n\r]\s*$/.test(before)) return false

  const trimmed = before.trimEnd()
  const last = trimmed.slice(-1)

  // Terminal punctuation ends the sentence. `…` and `:` included: both are
  // followed by something that reads as a new clause often enough that keeping
  // the capital is the safer half of the bet.
  if (/[.!?:;…]$/.test(last)) return false

  // A closing bracket or quote usually finishes a sentence too, but only when
  // what it closed was itself terminated — "(see below.)" ends, "(see below)"
  // may well continue.
  if (/[)\]}"'”’]$/.test(last)) {
    return !/[.!?…][)\]}"'”’]$/.test(trimmed)
  }

  // Anything else — a letter, a digit, a comma, a dash — is mid-sentence.
  return true
}

/**
 * Lowercase the first character when continuing a sentence.
 *
 * Only the first character, and only when it is a lone capital heading a word
 * that is otherwise lower case. "NASA launched it" and "I think so" both keep
 * their capitals: an acronym and a pronoun are capitalised wherever they land,
 * and mangling them would be a worse error than the one being fixed.
 */
export function applySentenceCase(text: string, before: string | null): string {
  if (!continuesSentence(before)) return text

  const first = text.slice(0, 1)
  if (first !== first.toUpperCase() || first === first.toLowerCase()) return text

  // The rest of the first word decides whether this is ordinary sentence case
  // ("And then…") or something that carries its own capital ("NASA", "I").
  const firstWord = /^[^\s]+/.exec(text)?.[0] ?? ''
  if (firstWord.length > 1 && firstWord.slice(1) !== firstWord.slice(1).toLowerCase()) {
    return text
  }
  if (firstWord === 'I' || firstWord.startsWith("I'")) return text

  return first.toLowerCase() + text.slice(1)
}
