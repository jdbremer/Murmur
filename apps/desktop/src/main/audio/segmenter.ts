import { SilenceTracker } from './vad'

/**
 * Cuts one continuous PCM stream into transcribable segments.
 *
 * Pure apart from the `SilenceTracker` it owns: frames in, segments out, no
 * clock, no I/O, no engine. That is what makes the cut policy — the part most
 * likely to be wrong — testable against synthetic PCM.
 *
 * Extracted from the meeting segmenter (PLAN §18.2) when file transcription
 * (PLAN §18.4) needed the identical policy: both feed a background engine that
 * a dictation must be able to preempt, so both want silence-aligned cuts with
 * the same hard cap. `TrackSegmenter` in `meeting/segmenter.ts` remains the
 * meeting-flavoured face of this class.
 *
 * Why VAD-cut rather than fixed windows: a fixed window splits whatever word
 * straddles the boundary, and the usual repair is to merge adjacent segments
 * afterwards and hope. Cutting on silence means the boundary lands where
 * nobody is speaking, so there is nothing to repair.
 *
 * Three rules, in priority order:
 *
 *  1. **Hard cut at `maxMs`** regardless of what the VAD thinks. This bounds
 *     how long a dictation can wait behind background work (see the note on
 *     `MEETING.maxSegmentMs`), so it is not negotiable for silence.
 *  2. **Cut on trailing silence** once the segment is long enough to be worth
 *     transcribing.
 *  3. **Mark segments with no speech as unvoiced** rather than dropping them:
 *     the meeting wrapper discards them (a muted meeting costs no engine
 *     time), while file transcription still needs their `endMs` — a progress
 *     bar that freezes for every quiet stretch of a recording reads as a hang.
 */

export interface SegmenterTuning {
  /** Trailing silence that ends a segment. */
  silenceMs: number
  /** Below this a "segment" is a cough, not a sentence. */
  minMs: number
  /** Hard cut. Also keeps every segment inside Whisper's 30 s window. */
  maxMs: number
  /** Carried into the next segment so a cut never clips a word onset. */
  preRollMs: number
}

export interface PcmSegmentCut {
  /** Milliseconds from the start of the stream. */
  startMs: number
  endMs: number
  /** Empty when `voiced` is false — silence is not worth carrying around. */
  pcm: Float32Array
  /** Whether the VAD heard any speech in the span. */
  voiced: boolean
}

export class PcmSegmenter {
  readonly #tuning: SegmenterTuning
  readonly #samplesPerMs: number
  readonly #silence: SilenceTracker
  #frames: Float32Array[] = []
  #samples = 0
  /** Samples consumed before the current segment began. */
  #offset = 0
  /** Tail of the previous segment, carried in so a cut never clips an onset. */
  #preRoll: Float32Array | null = null

  constructor(sampleRate: number, tuning: SegmenterTuning) {
    this.#tuning = tuning
    this.#samplesPerMs = sampleRate / 1000
    this.#silence = new SilenceTracker(sampleRate)
  }

  /** Milliseconds of audio buffered in the open segment. */
  get pendingMs(): number {
    return this.#samples / this.#samplesPerMs
  }

  /**
   * Feed one ~100 ms frame.
   *
   * @returns a segment when this frame closed one, otherwise `null`.
   */
  push(frame: Float32Array): PcmSegmentCut | null {
    this.#frames.push(frame)
    this.#samples += frame.length
    this.#silence.push(frame)

    if (this.pendingMs >= this.#tuning.maxMs) return this.#cut()

    if (
      this.pendingMs >= this.#tuning.minMs &&
      this.#silence.shouldFinalise(this.#tuning.silenceMs)
    ) {
      return this.#cut()
    }

    return null
  }

  /**
   * Close whatever is buffered, speech or not.
   *
   * Called when the stream ends: the last thing said must not be discarded
   * just because it was not followed by silence.
   */
  flush(): PcmSegmentCut | null {
    if (this.#samples === 0) return null
    return this.#cut()
  }

  #cut(): PcmSegmentCut {
    const endMs = Math.round((this.#offset + this.#samples) / this.#samplesPerMs)

    // Rule 3: nothing was said. The span is still reported — the caller
    // decides whether "confirmed silence" is a progress update or a no-op —
    // but its audio is not, and the pre-roll is dropped so the next voiced
    // segment does not open with a tail of stale room tone.
    if (!this.#silence.sawSpeech) {
      const startMs = Math.round(this.#offset / this.#samplesPerMs)
      this.#preRoll = null
      this.#advance()
      return { startMs, endMs, pcm: new Float32Array(0), voiced: false }
    }

    const preRoll = this.#preRoll
    const body = concat(this.#frames, this.#samples)
    const pcm =
      preRoll && preRoll.length > 0 ? concat([preRoll, body], preRoll.length + body.length) : body

    const preRollMs = (preRoll?.length ?? 0) / this.#samplesPerMs
    const startMs = Math.max(0, Math.round(this.#offset / this.#samplesPerMs - preRollMs))

    this.#preRoll = tail(body, Math.round(this.#tuning.preRollMs * this.#samplesPerMs))
    this.#advance()

    return { startMs, endMs, pcm, voiced: true }
  }

  #advance(): void {
    this.#offset += this.#samples
    this.#frames = []
    this.#samples = 0
    this.#silence.reset()
  }
}

function concat(chunks: readonly Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

function tail(pcm: Float32Array, samples: number): Float32Array | null {
  if (samples <= 0 || pcm.length === 0) return null
  return pcm.length <= samples ? pcm.slice() : pcm.slice(pcm.length - samples)
}
