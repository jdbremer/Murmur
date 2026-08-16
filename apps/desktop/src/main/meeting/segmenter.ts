import type { MeetingTrack } from '@murmur/shared'

import { AUDIO, MEETING } from '../config'
import { PcmSegmenter } from '../audio/segmenter'

/**
 * Cuts one meeting track into transcribable segments (PLAN §18.2).
 *
 * The cut policy itself lives in `audio/segmenter.ts` — file transcription
 * (PLAN §18.4) uses the identical rules, for the identical reason: both feed
 * the background half of the STT queue, so both need the silence-aligned cuts
 * and the hard cap that keep a dictation from waiting behind them.
 *
 * What is meeting-specific is here: the track stamp, the `MEETING` tuning, and
 * the decision to *drop* unvoiced spans entirely — a meeting where you are
 * muted costs nothing on the `me` track: no engine time, no empty lines.
 */

export interface MeetingSegmentCut {
  track: MeetingTrack
  /** Milliseconds from the start of the recording. */
  startMs: number
  endMs: number
  pcm: Float32Array
}

export class TrackSegmenter {
  readonly #track: MeetingTrack
  readonly #segmenter = new PcmSegmenter(AUDIO.sampleRate, {
    silenceMs: MEETING.segmentSilenceMs,
    minMs: MEETING.minSegmentMs,
    maxMs: MEETING.maxSegmentMs,
    preRollMs: MEETING.segmentPreRollMs,
  })

  constructor(track: MeetingTrack) {
    this.#track = track
  }

  /** Milliseconds of audio buffered in the open segment. */
  get pendingMs(): number {
    return this.#segmenter.pendingMs
  }

  /**
   * Feed one ~100 ms frame.
   *
   * @returns a segment when this frame closed one, otherwise `null`.
   */
  push(frame: Float32Array): MeetingSegmentCut | null {
    return this.#stamp(this.#segmenter.push(frame))
  }

  /**
   * Close whatever is buffered, speech or not.
   *
   * Called when the recording stops: the last thing said must not be discarded
   * just because the user hit stop before going quiet.
   */
  flush(): MeetingSegmentCut | null {
    return this.#stamp(this.#segmenter.flush())
  }

  #stamp(cut: ReturnType<PcmSegmenter['push']>): MeetingSegmentCut | null {
    if (!cut || !cut.voiced) return null
    return { track: this.#track, startMs: cut.startMs, endMs: cut.endMs, pcm: cut.pcm }
  }
}
