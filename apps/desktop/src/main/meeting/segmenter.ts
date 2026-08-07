import type { MeetingTrack } from '@murmur/shared'

import { AUDIO, MEETING } from '../config'
import { SilenceTracker } from '../audio/vad'

/**
 * Cuts one continuous track into transcribable segments (PLAN §18.2).
 *
 * Pure apart from the `SilenceTracker` it owns: frames in, segments out, no
 * clock, no I/O, no engine. That is what makes the cut policy — the part most
 * likely to be wrong — testable against synthetic PCM.
 *
 * Why VAD-cut rather than fixed windows: a fixed 5 s window splits whatever
 * word straddles the boundary, and the usual repair is to merge adjacent
 * segments afterwards and hope. Cutting on silence means the boundary lands
 * where nobody is speaking, so there is nothing to repair.
 *
 * Three rules, in priority order:
 *
 *  1. **Hard cut at {@link MEETING.maxSegmentMs}** regardless of what the VAD
 *     thinks. This bounds how long a dictation can wait behind meeting work
 *     (see the note on `MEETING`), so it is not negotiable for silence.
 *  2. **Cut on trailing silence** once the segment is long enough to be worth
 *     transcribing.
 *  3. **Drop segments with no speech in them.** A meeting where you are muted
 *     costs nothing on the `me` track — no engine time, no empty lines.
 */

export interface MeetingSegmentCut {
  track: MeetingTrack
  /** Milliseconds from the start of the recording. */
  startMs: number
  endMs: number
  pcm: Float32Array
}

const SAMPLES_PER_MS = AUDIO.sampleRate / 1000

export class TrackSegmenter {
  readonly #track: MeetingTrack
  readonly #silence: SilenceTracker
  #frames: Float32Array[] = []
  #samples = 0
  /** Samples consumed before the current segment began. */
  #offset = 0
  /** Tail of the previous segment, carried in so a cut never clips an onset. */
  #preRoll: Float32Array | null = null

  constructor(track: MeetingTrack) {
    this.#track = track
    this.#silence = new SilenceTracker(AUDIO.sampleRate)
  }

  /** Milliseconds of audio buffered in the open segment. */
  get pendingMs(): number {
    return this.#samples / SAMPLES_PER_MS
  }

  /**
   * Feed one ~100 ms frame.
   *
   * @returns a segment when this frame closed one, otherwise `null`.
   */
  push(frame: Float32Array): MeetingSegmentCut | null {
    this.#frames.push(frame)
    this.#samples += frame.length
    const sawSpeech = this.#silence.push(frame)
    void sawSpeech

    if (this.pendingMs >= MEETING.maxSegmentMs) return this.#cut()

    if (
      this.pendingMs >= MEETING.minSegmentMs &&
      this.#silence.shouldFinalise(MEETING.segmentSilenceMs)
    ) {
      return this.#cut()
    }

    return null
  }

  /**
   * Close whatever is buffered, speech or not.
   *
   * Called when the recording stops: the last thing said must not be discarded
   * just because the user hit stop before going quiet.
   */
  flush(): MeetingSegmentCut | null {
    if (this.#samples === 0) return null
    if (!this.#silence.sawSpeech) {
      this.#discard()
      return null
    }
    return this.#cut({ force: true })
  }

  #cut(options: { force?: boolean } = {}): MeetingSegmentCut | null {
    // Rule 3: nothing was said, so there is nothing to transcribe. Reset and
    // keep the offset moving so later timestamps stay true to the wall clock.
    if (!this.#silence.sawSpeech && !options.force) {
      this.#discard()
      return null
    }

    const preRoll = this.#preRoll
    const body = concat(this.#frames, this.#samples)
    const pcm =
      preRoll && preRoll.length > 0 ? concat([preRoll, body], preRoll.length + body.length) : body

    const preRollMs = (preRoll?.length ?? 0) / SAMPLES_PER_MS
    const startMs = Math.max(0, Math.round(this.#offset / SAMPLES_PER_MS - preRollMs))
    const endMs = Math.round((this.#offset + this.#samples) / SAMPLES_PER_MS)

    this.#preRoll = tail(body, Math.round(MEETING.segmentPreRollMs * SAMPLES_PER_MS))
    this.#advance()

    return { track: this.#track, startMs, endMs, pcm }
  }

  #discard(): void {
    this.#preRoll = null
    this.#advance()
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
