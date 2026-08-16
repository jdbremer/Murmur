import { describe, expect, it } from 'vitest'

import { PcmSegmenter, type PcmSegmentCut } from '../src/main/audio/segmenter'
import { AUDIO, TRANSCRIBE } from '../src/main/config'
import { concat, roomTone, speechLike } from './helpers/pcm'

/**
 * The generic segmenter's one behavioural difference from the meeting wrapper:
 * unvoiced spans are *reported*, not swallowed. File transcription's progress
 * bar rides on those reports — `meeting-segmenter.test.ts` continues to pin
 * the drop-silence behaviour from the meeting side.
 */

const FRAME = Math.round((AUDIO.sampleRate * AUDIO.frameMs) / 1000)

function tuned(): PcmSegmenter {
  return new PcmSegmenter(AUDIO.sampleRate, {
    silenceMs: TRANSCRIBE.segmentSilenceMs,
    minMs: TRANSCRIBE.minSegmentMs,
    maxMs: TRANSCRIBE.maxSegmentMs,
    preRollMs: TRANSCRIBE.segmentPreRollMs,
  })
}

function feed(segmenter: PcmSegmenter, pcm: Float32Array): PcmSegmentCut[] {
  const cuts: PcmSegmentCut[] = []
  for (let at = 0; at + FRAME <= pcm.length; at += FRAME) {
    const cut = segmenter.push(pcm.subarray(at, at + FRAME))
    if (cut) cuts.push(cut)
  }
  return cuts
}

describe('PcmSegmenter', () => {
  it('reports silent spans as unvoiced cuts with honest end times', () => {
    const segmenter = tuned()
    const cuts = feed(segmenter, roomTone(TRANSCRIBE.maxSegmentMs + 2_000))

    expect(cuts.length).toBeGreaterThanOrEqual(1)
    const first = cuts[0]
    expect(first?.voiced).toBe(false)
    // No audio rides along — silence is progress, not payload.
    expect(first?.pcm.length).toBe(0)
    expect(first?.endMs).toBeGreaterThanOrEqual(TRANSCRIBE.maxSegmentMs)
  })

  it('keeps the file clock across a silent gap', () => {
    const segmenter = tuned()
    const cuts = feed(
      segmenter,
      concat(
        speechLike(2_000),
        roomTone(TRANSCRIBE.segmentSilenceMs + 400),
        speechLike(2_000, 0.25, 13),
        roomTone(TRANSCRIBE.segmentSilenceMs + 400),
      ),
    )

    const voiced = cuts.filter((cut) => cut.voiced)
    expect(voiced.length).toBeGreaterThanOrEqual(2)
    // The second utterance is stamped after the first plus the gap between.
    expect(voiced[1]?.startMs ?? 0).toBeGreaterThan(2_000)
  })

  it('flush closes a voiced tail so the last words are never lost', () => {
    const segmenter = tuned()
    feed(segmenter, speechLike(2_500))
    const cut = segmenter.flush()
    expect(cut?.voiced).toBe(true)
    expect(cut?.pcm.length).toBeGreaterThan(0)
    expect(segmenter.flush()).toBeNull()
  })

  it('flush reports a silent tail as unvoiced rather than dropping it', () => {
    const segmenter = tuned()
    feed(segmenter, roomTone(2_000))
    const cut = segmenter.flush()
    expect(cut?.voiced).toBe(false)
    // The progress bar still gets to the end of the file.
    expect(cut?.endMs).toBeGreaterThan(1_500)
  })
})
