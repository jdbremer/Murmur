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

// ---------------------------------------------------------------------------
// The hallucinated tail
// ---------------------------------------------------------------------------

/**
 * Whisper's best-known failure: inventing a short, agreeable sentence at the
 * end of an utterance.
 *
 * Feed Whisper audio that ends in near-silence and it will often fill that
 * silence with something from its training data — "Okay." "Yeah." "Thank you."
 * "Bye." It is not mishearing anything; there is nothing there to mishear. It
 * is a language model completing a plausible ending.
 *
 * It shows up most after a question, because a question is exactly where a
 * speaker's pitch rises and they trail off waiting for an answer — a longer,
 * quieter tail to hallucinate into — and because the subtitle and meeting
 * transcripts Whisper was trained on answer questions with "Yeah." constantly.
 *
 * Measured against 342 real dictations: 18 ended in one of these, and every
 * single one came from the speech model rather than the polish pass.
 *
 * The VAD already trims trailing silence before the audio is sent
 * (`trimSilence`), and it is not enough — the hallucination survives a clean
 * cut, which is why this guard exists downstream of it rather than instead
 * of it.
 */

/**
 * Only the words Whisper actually invents, taken from observed output rather
 * than imagined. Deliberately short: every entry here is a word a user might
 * one day genuinely end on, so the list earning its place matters more than it
 * being exhaustive, and the conditions in {@link stripHallucinatedTail} are
 * what stop a real one being eaten.
 */
const HALLUCINATED_TAILS = new Set([
  'okay',
  'ok',
  'yeah',
  'yes',
  'yep',
  'mm',
  'mhm',
  'thank you',
  'thanks',
  'bye',
  'goodbye',
  'you',
  'oh',
])

/**
 * How much less confident the tail has to be than the speech before it.
 *
 * whisper.cpp reports `avg_logprob` per segment: clean speech sits around
 * -0.1 to -0.4, and a segment conjured out of silence scores markedly worse
 * because the model had no acoustic evidence for it. Requiring a real gap is
 * what separates "the model invented this" from "the speaker actually said
 * yeah", which is a distinction no word list can make on its own.
 */
const CONFIDENCE_MARGIN = 0.25

export interface TranscriptSegment {
  text?: string | undefined
  avgLogProb?: number | null | undefined
}

export interface StrippedTranscript {
  /** The segments to keep, in order. */
  segments: TranscriptSegment[]
  /** What was removed, for the log. Null when nothing was. */
  dropped: string | null
}

const bareWords = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[.,!?…]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2
    : (sorted[middle] as number)
}

/**
 * Drop a final segment that Whisper invented.
 *
 * Every one of these has to hold, and the conjunction is the whole design —
 * any one of them alone would eventually eat a word somebody meant:
 *
 *  1. **There is something else.** A transcript that is *only* "Okay." is
 *     someone saying okay. Never return nothing.
 *  2. **It is its own segment.** A segment boundary is a pause, so a tail
 *     Whisper dreamt up during silence arrives detached. A real "yeah" said in
 *     the same breath as the sentence before it lands inside that segment and
 *     is never considered here.
 *  3. **It is one of the words Whisper actually invents**, and it is short.
 *  4. **It is less confident than the speech around it** — when whisper.cpp
 *     gives us the numbers to check. If it does not, conditions 1–3 stand on
 *     their own; they are already narrow.
 */
export function stripHallucinatedTail(segments: readonly TranscriptSegment[]): StrippedTranscript {
  const kept = segments.filter((segment) => (segment.text ?? '').trim().length > 0)
  if (kept.length < 2) return { segments: [...kept], dropped: null }

  const last = kept[kept.length - 1] as TranscriptSegment
  const tail = bareWords(last.text ?? '')
  if (!HALLUCINATED_TAILS.has(tail)) return { segments: [...kept], dropped: null }

  const earlier = kept.slice(0, -1)
  const scores = earlier
    .map((segment) => segment.avgLogProb)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  const baseline = median(scores)

  if (
    baseline !== null &&
    typeof last.avgLogProb === 'number' &&
    Number.isFinite(last.avgLogProb)
  ) {
    // Confidently spoken: the speaker meant it. Leave it alone.
    if (last.avgLogProb >= baseline - CONFIDENCE_MARGIN) {
      return { segments: [...kept], dropped: null }
    }
  }

  return { segments: earlier, dropped: (last.text ?? '').trim() }
}
