import type { MeetingSegment } from '@murmur/shared'

import { MEETING } from '../config'

/**
 * Stops the far end being transcribed twice (PLAN §18.2).
 *
 * ## The problem
 *
 * On speakers, the other participants' voices come out of the laptop and go
 * straight back into the microphone. So the same sentence arrives on both
 * tracks: once on `them` (clean, from the system tap) and once on `me` (the
 * echo). Left alone the transcript says everything twice and attributes half
 * of it to the wrong person.
 *
 * Browser echo cancellation does not save us. Chromium's AEC references
 * *Chromium's own* render stream, and the meeting audio is played by another
 * process entirely, so it has nothing to cancel against.
 *
 * ## The rule that matters
 *
 * **Acoustic evidence may delay a segment. Only a text match may delete one.**
 *
 * This is the expensive lesson, and it is worth stating plainly because the
 * obvious design gets it wrong: gating the microphone on "does this correlate
 * with what the speakers are playing" *feels* right and destroys real speech.
 * Genuine local talk measured against a loud far end scores well above any
 * threshold you would pick — precisely when two people talk over each other,
 * which is exactly when you least want to drop a word.
 *
 * So a suspicious mic segment is held for {@link MEETING.micHoldbackMs}. If a
 * system segment arrives in that window carrying substantially the same words,
 * the mic copy was an echo and is dropped. If nothing arrives, it was the user
 * speaking over the call and it is released, unchanged.
 */

export interface HeldSegment {
  segment: MeetingSegment
  /** Epoch ms at which it should be released if nothing cancels it. */
  releaseAt: number
}

/**
 * Fraction of one side's words that must appear in the other before two
 * transcripts count as the same utterance. Deliberately loose: STT will not
 * render an echo identically to the original, so demanding equality would
 * never fire.
 */
const OVERLAP_RATIO = 0.6

/** Words too common to be evidence of anything. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'do',
  'for',
  'from',
  'have',
  'i',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'we',
  'were',
  'with',
  'you',
  'your',
  'so',
  'just',
  'like',
  'yeah',
  'ok',
  'okay',
  'um',
  'uh',
])

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Do these two transcripts say the same thing?
 *
 * Coverage in *either* direction counts: an echo is frequently a truncated or
 * padded version of the original, so requiring symmetry would miss it.
 */
export function transcriptsOverlap(a: string, b: string): boolean {
  const left = tokenize(a)
  const right = tokenize(b)
  if (left.length === 0 || right.length === 0) return false

  if (coverage(left, right) >= OVERLAP_RATIO) return true

  // Second pass with filler removed: "yeah so I think we should ship it" and
  // "I think we should ship it" are the same sentence with different noise.
  const leftContent = left.filter((w) => !STOPWORDS.has(w))
  const rightContent = right.filter((w) => !STOPWORDS.has(w))
  if (leftContent.length < 2 || rightContent.length < 2) return false
  return coverage(leftContent, rightContent) >= OVERLAP_RATIO
}

/** Best directional token coverage, counting duplicates only once each. */
function coverage(a: readonly string[], b: readonly string[]): number {
  const bag = new Map<string, number>()
  for (const word of b) bag.set(word, (bag.get(word) ?? 0) + 1)

  let shared = 0
  const used = new Map(bag)
  for (const word of a) {
    const left = used.get(word) ?? 0
    if (left > 0) {
      shared += 1
      used.set(word, left - 1)
    }
  }
  return shared / Math.min(a.length, b.length)
}

/**
 * Buffers mic segments that might be speaker bleed until a system transcript
 * either cancels them or fails to.
 *
 * Time is injected rather than read from a clock so the policy is testable.
 */
export class MicHoldback {
  #held: HeldSegment[] = []
  /** Recent system transcripts, for cancelling a mic segment already queued. */
  #systemText: { text: string; at: number }[] = []

  /**
   * Offer a mic segment.
   *
   * @param suspect whether the audio gate thought this looked like bleed
   * @returns the segment if it can be emitted now, or `null` if it is held
   */
  offer(segment: MeetingSegment, suspect: boolean, now: number): MeetingSegment | null {
    if (!suspect) return segment

    // A system transcript may already have landed that explains this segment.
    if (this.#systemText.some((entry) => transcriptsOverlap(entry.text, segment.text))) {
      return null
    }

    this.#held.push({ segment, releaseAt: now + MEETING.micHoldbackMs })
    return null
  }

  /**
   * Record a system transcript, dropping any held mic segment it explains.
   *
   * This is the only path that deletes speech.
   */
  noteSystem(text: string, now: number): void {
    if (!text.trim()) return
    this.#systemText.push({ text, at: now })
    this.#systemText = this.#systemText.filter((e) => now - e.at <= MEETING.micHoldbackMs * 2)
    this.#held = this.#held.filter((held) => !transcriptsOverlap(text, held.segment.text))
  }

  /** Segments whose holdback has expired with nothing to explain them. */
  due(now: number): MeetingSegment[] {
    const ready = this.#held.filter((held) => held.releaseAt <= now)
    if (ready.length === 0) return []
    this.#held = this.#held.filter((held) => held.releaseAt > now)
    return ready.map((held) => held.segment)
  }

  /** Release everything still held. Called when the recording stops. */
  drain(): MeetingSegment[] {
    const all = this.#held.map((held) => held.segment)
    this.#held = []
    return all
  }
}

/**
 * Cheap acoustic pre-filter: is this mic audio quiet enough, while the far end
 * is talking, that it is probably just bleed?
 *
 * Both conditions must hold. Requiring low peak *as well as* low RMS is what
 * protects a speech onset — the moment the user actually starts talking is
 * loud in peak before it is loud in average, so a mean-only test would clip
 * the first syllable of every sentence.
 *
 * Its answer is only ever "delay this", never "delete this".
 */
export function looksLikeBleed(rms: number, peak: number, systemSpeaking: boolean): boolean {
  if (!systemSpeaking) return false
  return rms < 0.018 && peak < 0.07
}
