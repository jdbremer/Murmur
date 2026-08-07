/**
 * Cleanup applied to every STT engine's raw output, before anything else sees it.
 *
 * ## Why this exists: whisper.cpp's segment newlines
 *
 * whisper.cpp splits audio into segments and joins them with `\n` in the `text`
 * field it returns. A segment boundary is a *pause*, so dictating with any
 * natural rhythm produces a transcript full of hard line breaks that the
 * speaker never asked for — and `.trim()` does not touch them, because they are
 * in the middle.
 *
 * They cannot be told apart from a line break the speaker actually wanted:
 * whisper.cpp issue #2381 is exactly that complaint, and the answer upstream is
 * that the information is not in the response. So there is nothing to preserve
 * and every one of them is dropped.
 *
 * This is deliberately *not* left to the polish model. Three reasons:
 *
 *  1. Utterances of three words or fewer skip polishing entirely (POLISH
 *     .skipWordCount), so the model never sees them;
 *  2. when the hallucination guard rejects an output the caller falls back to
 *     this raw text, newlines and all;
 *  3. removing a transport artifact is not a language task. Asking a 1B model
 *     to reliably undo something a regex undoes exactly is how you get a
 *     feature that works 95% of the time.
 *
 * Line breaks the speaker *does* want are reintroduced deliberately further
 * down the pipeline — by saying "new line" or "new paragraph", and by list
 * formatting — which is the model Wispr Flow uses: pauses become punctuation,
 * never line breaks.
 */

/**
 * Collapse every run of whitespace to a single space and trim.
 *
 * Covers the segment newlines above and the leading space whisper.cpp puts on
 * each segment, which would otherwise survive as a double space mid-sentence.
 */
export function normaliseTranscript(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
