import { describe, expect, it } from 'vitest'

import type { MeetingSegment } from '@murmur/shared'

import { MEETING } from '../src/main/config'
import { MicHoldback, looksLikeBleed, transcriptsOverlap } from '../src/main/meeting/holdback'

/**
 * The echo policy, and the single rule it exists to enforce:
 *
 *   **audio evidence may delay a segment; only a text match may delete one.**
 *
 * The tempting design — gate the microphone whenever it correlates with what
 * the speakers are playing — deletes real speech, because genuine local talk
 * during double-talk scores above any threshold worth picking. These tests
 * pin the safer behaviour so a future "optimisation" cannot quietly undo it.
 */

function segment(text: string, track: MeetingSegment['track'] = 'me'): MeetingSegment {
  return { id: `${track}-${text}`, track, startMs: 0, endMs: 1_000, text }
}

describe('transcriptsOverlap', () => {
  it('matches an imperfect echo of the same sentence', () => {
    expect(transcriptsOverlap('can everyone hear me okay', 'can everyone hear me ok')).toBe(true)
  })

  it('matches when the echo is truncated', () => {
    expect(transcriptsOverlap('so I think we should ship it on Friday', 'we should ship it')).toBe(
      true,
    )
  })

  it('does not match two different sentences that share filler', () => {
    expect(transcriptsOverlap('yeah so I agree with that', 'okay and the invoice is overdue')).toBe(
      false,
    )
  })

  it('ignores empty input rather than matching everything', () => {
    expect(transcriptsOverlap('', 'anything')).toBe(false)
    expect(transcriptsOverlap('anything', '   ')).toBe(false)
  })
})

describe('looksLikeBleed', () => {
  it('is never suspicious while the far end is silent', () => {
    expect(looksLikeBleed(0.001, 0.004, false)).toBe(false)
  })

  it('suspects quiet mic audio underneath a talking far end', () => {
    expect(looksLikeBleed(0.004, 0.02, true)).toBe(true)
  })

  it('protects a speech onset: loud peak beats a quiet average', () => {
    // The instant someone starts talking is loud in peak before it is loud in
    // mean, so requiring both to be low is what stops the first syllable of
    // every sentence being gated away.
    expect(looksLikeBleed(0.004, 0.4, true)).toBe(false)
  })
})

describe('MicHoldback', () => {
  it('passes ordinary mic speech straight through', () => {
    const holdback = new MicHoldback()
    const out = holdback.offer(segment('this is my own voice'), false, 0)
    expect(out?.text).toBe('this is my own voice')
  })

  it('holds a suspect segment rather than emitting it immediately', () => {
    const holdback = new MicHoldback()
    expect(holdback.offer(segment('can everyone hear me'), true, 0)).toBeNull()
  })

  it('releases a held segment when nothing explains it — the regression that matters', () => {
    // Genuine local speech over a loud call. Audio evidence flagged it; no
    // system transcript ever matched. It must survive.
    const holdback = new MicHoldback()
    holdback.offer(segment('actually I disagree with that'), true, 0)

    expect(holdback.due(MEETING.micHoldbackMs - 1)).toHaveLength(0)
    const released = holdback.due(MEETING.micHoldbackMs + 1)
    expect(released).toHaveLength(1)
    expect(released[0]?.text).toBe('actually I disagree with that')
  })

  it('drops a held segment that a system transcript explains', () => {
    const holdback = new MicHoldback()
    holdback.offer(segment('can everyone hear me okay'), true, 0)
    holdback.noteSystem('can everyone hear me ok', 100)

    expect(holdback.due(MEETING.micHoldbackMs + 1)).toHaveLength(0)
  })

  it('drops a suspect segment whose system transcript already arrived', () => {
    const holdback = new MicHoldback()
    holdback.noteSystem('shall we start with the roadmap', 0)
    expect(holdback.offer(segment('shall we start with the roadmap'), true, 100)).toBeNull()
    expect(holdback.due(MEETING.micHoldbackMs + 200)).toHaveLength(0)
  })

  it('keeps unrelated local speech even while the far end is transcribed', () => {
    const holdback = new MicHoldback()
    holdback.offer(segment('let me pull up the invoice'), true, 0)
    holdback.noteSystem('and then we shipped the release on Tuesday', 100)

    const released = holdback.due(MEETING.micHoldbackMs + 1)
    expect(released).toHaveLength(1)
    expect(released[0]?.text).toBe('let me pull up the invoice')
  })

  it('drain releases everything still held when the recording stops', () => {
    const holdback = new MicHoldback()
    holdback.offer(segment('one'), true, 0)
    holdback.offer(segment('two'), true, 0)
    expect(holdback.drain()).toHaveLength(2)
    expect(holdback.drain()).toHaveLength(0)
  })
})
