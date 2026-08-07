import { describe, expect, it } from 'vitest'

import { AUDIO, MEETING } from '../src/main/config'
import { TrackSegmenter, type MeetingSegmentCut } from '../src/main/meeting/segmenter'
import { roomTone, speechLike } from './helpers/pcm'

/**
 * The cut policy decides how a meeting reads and how long a dictation waits
 * behind it, so it is the part worth testing hardest.
 */

const FRAME = Math.round((AUDIO.sampleRate * AUDIO.frameMs) / 1000)

/** Feed a signal frame by frame, collecting whatever segments fall out. */
function feed(segmenter: TrackSegmenter, pcm: Float32Array): MeetingSegmentCut[] {
  const cuts: MeetingSegmentCut[] = []
  for (let at = 0; at + FRAME <= pcm.length; at += FRAME) {
    const cut = segmenter.push(pcm.subarray(at, at + FRAME))
    if (cut) cuts.push(cut)
  }
  return cuts
}

describe('TrackSegmenter', () => {
  it('cuts on trailing silence once the segment is worth transcribing', () => {
    const segmenter = new TrackSegmenter('me')
    const cuts = feed(
      segmenter,
      concat(speechLike(2_500), roomTone(MEETING.segmentSilenceMs + 400)),
    )

    expect(cuts).toHaveLength(1)
    expect(cuts[0]?.track).toBe('me')
    expect(cuts[0]?.pcm.length).toBeGreaterThan(0)
  })

  it('drops a stretch with no speech in it rather than transcribing silence', () => {
    // A meeting where you are muted must cost no engine time at all.
    const segmenter = new TrackSegmenter('me')
    const cuts = feed(segmenter, roomTone(20_000))
    expect(cuts).toHaveLength(0)
  })

  it('force-cuts at the maximum length even while someone is still talking', () => {
    // This bound is what stops a dictation queueing behind a long segment, so
    // continuous speech must not be able to defer it.
    const segmenter = new TrackSegmenter('them')
    const cuts = feed(segmenter, speechLike(MEETING.maxSegmentMs + 4_000))

    expect(cuts.length).toBeGreaterThanOrEqual(1)
    for (const cut of cuts) {
      const ms = (cut.pcm.length / AUDIO.sampleRate) * 1000
      // Allow the carried pre-roll on top of the cap.
      expect(ms).toBeLessThanOrEqual(
        MEETING.maxSegmentMs + MEETING.segmentPreRollMs + AUDIO.frameMs,
      )
    }
  })

  it('does not cut a brief blip that happens to be followed by silence', () => {
    const segmenter = new TrackSegmenter('me')
    const cuts = feed(segmenter, concat(speechLike(200), roomTone(MEETING.segmentSilenceMs + 300)))
    expect(cuts).toHaveLength(0)
  })

  it('timestamps segments against the recording, not the segment', () => {
    const segmenter = new TrackSegmenter('them')
    const cuts = feed(
      segmenter,
      concat(
        speechLike(2_000),
        roomTone(MEETING.segmentSilenceMs + 300),
        speechLike(2_000),
        roomTone(MEETING.segmentSilenceMs + 300),
      ),
    )

    expect(cuts.length).toBeGreaterThanOrEqual(2)
    const [first, second] = cuts
    expect(first?.startMs).toBeLessThan(second?.startMs ?? 0)
    // The second segment starts after the first one's audio, not back at zero.
    expect(second?.startMs ?? 0).toBeGreaterThan(2_000)
  })

  it('carries pre-roll so a cut never clips the next word onset', () => {
    const segmenter = new TrackSegmenter('me')
    const cuts = feed(
      segmenter,
      concat(
        speechLike(2_000),
        roomTone(MEETING.segmentSilenceMs + 200),
        speechLike(2_000),
        roomTone(MEETING.segmentSilenceMs + 200),
      ),
    )

    const second = cuts[1]
    expect(second).toBeDefined()
    // Longer than the speech alone, because the tail of the gap came with it.
    const ms = ((second?.pcm.length ?? 0) / AUDIO.sampleRate) * 1000
    expect(ms).toBeGreaterThan(2_000)
  })

  it('flush keeps the last thing said when the user stops mid-sentence', () => {
    const segmenter = new TrackSegmenter('me')
    feed(segmenter, speechLike(3_000))
    const cut = segmenter.flush()
    expect(cut).not.toBeNull()
    expect(cut?.pcm.length).toBeGreaterThan(0)
  })

  it('flush returns nothing when only silence is buffered', () => {
    const segmenter = new TrackSegmenter('me')
    feed(segmenter, roomTone(3_000))
    expect(segmenter.flush()).toBeNull()
  })
})

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Float32Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}
