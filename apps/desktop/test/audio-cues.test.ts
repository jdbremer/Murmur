import { describe, expect, it } from 'vitest'

import type { DictationEvent } from '@murmur/shared'

import {
  CUE,
  cueDurationMs,
  cueNotes,
  decideCue,
  envelopeAt,
  renderEnvelope,
  restingStateOf,
  type CueNote,
} from '../src/renderer/audio/cues'

/**
 * The cue is inaudible on a build machine, so its shape is asserted instead.
 *
 * Two things are worth guarding here. The musical ones — a rising fifth to
 * open, the same fifth falling to close — because inverting them would be both
 * wrong and, in a silent test run, invisible. And the envelope's endpoints,
 * because a curve that starts or ends anywhere but zero is a click, which is
 * the one defect that would make the feature worse than having none.
 */

const listening: DictationEvent = {
  state: 'listening',
  handsFree: false,
  level: 0.5,
  command: false,
}
const processing: DictationEvent = { state: 'processing', stage: 'transcribing', command: false }
const idle: DictationEvent = { state: 'idle' }
const inserted: DictationEvent = { state: 'inserted', charCount: 27, method: 'paste' }
const failed: DictationEvent = { state: 'error', code: 'no-speech', message: "Didn't catch that" }

describe('cueNotes', () => {
  it('opens on a rising perfect fifth and closes on a falling one', () => {
    const [startGrace, startDownbeat] = cueNotes('start')
    const [stopGrace, stopDownbeat] = cueNotes('stop')

    expect(startGrace.frequencyHz).toBe(CUE.lowHz)
    expect(startDownbeat.frequencyHz).toBe(CUE.highHz)
    expect(stopGrace.frequencyHz).toBe(CUE.highHz)
    expect(stopDownbeat.frequencyHz).toBe(CUE.lowHz)
  })

  it('tunes the pair as an exact 3:2, so the notes ring rather than beat', () => {
    expect(CUE.highHz / CUE.lowHz).toBeCloseTo(1.5, 10)
  })

  it('keeps the grace note well under the downbeat', () => {
    for (const cue of ['start', 'stop'] as const) {
      const [grace, downbeat] = cueNotes(cue)
      expect(grace.gain).toBeLessThan(downbeat.gain / 5)
      expect(grace.atMs).toBe(0)
      expect(downbeat.atMs).toBeGreaterThan(grace.atMs)
    }
  })

  it('stays quiet enough to live with — the downbeat peaks around -16 dBFS', () => {
    const [, downbeat] = cueNotes('start')
    expect(20 * Math.log10(downbeat.gain)).toBeGreaterThan(-20)
    expect(20 * Math.log10(downbeat.gain)).toBeLessThan(-14)
  })

  it('is over fast enough to precede speech rather than overlap it', () => {
    expect(cueDurationMs('start')).toBeLessThan(250)
    expect(cueDurationMs('stop')).toBeLessThan(250)
  })
})

describe('envelopeAt', () => {
  const tau = CUE.tailTauMs.start

  it('starts and ends at silence', () => {
    expect(envelopeAt(0, tau)).toBe(0)
    expect(envelopeAt(CUE.noteDurationMs, tau)).toBe(0)
    expect(envelopeAt(-1, tau)).toBe(0)
    expect(envelopeAt(CUE.noteDurationMs + 50, tau)).toBe(0)
  })

  it('peaks exactly at the end of the attack', () => {
    expect(envelopeAt(CUE.attackMs, tau)).toBeCloseTo(1, 6)
    expect(envelopeAt(CUE.attackMs / 2, tau)).toBeCloseTo(0.5, 6)
  })

  it('decays monotonically once struck', () => {
    let previous = envelopeAt(CUE.attackMs, tau)
    for (let t = CUE.attackMs + 1; t <= CUE.noteDurationMs; t += 1) {
      const value = envelopeAt(t, tau)
      expect(value).toBeLessThanOrEqual(previous)
      previous = value
    }
  })

  it('drops ~20 dB within 15 ms of the peak — a struck note, not a beep', () => {
    const db = 20 * Math.log10(envelopeAt(CUE.attackMs + 15, tau))
    expect(db).toBeLessThan(-15)
    expect(db).toBeGreaterThan(-26)
  })

  it('leaves a quiet tail behind the body, which is what reads as a room', () => {
    // Far enough out that the ~5 ms body is long gone and only the tail remains.
    const tail = envelopeAt(CUE.attackMs + 60, tau)
    expect(tail).toBeGreaterThan(0.005)
    expect(tail).toBeLessThan(CUE.tailWeight)
  })

  it('rings longer on the closing cue than the opening one', () => {
    const t = CUE.attackMs + 60
    expect(envelopeAt(t, CUE.tailTauMs.stop)).toBeGreaterThan(envelopeAt(t, CUE.tailTauMs.start))
  })
})

describe('renderEnvelope', () => {
  const downbeatOf = (cue: 'start' | 'stop'): CueNote => cueNotes(cue)[1]

  it('lands on zero at both ends, so the curve cannot click', () => {
    for (const cue of ['start', 'stop'] as const) {
      const curve = renderEnvelope(downbeatOf(cue))
      expect(curve[0]).toBe(0)
      expect(curve[curve.length - 1]).toBe(0)
    }
  })

  it('never exceeds the gain it was asked for', () => {
    const curve = renderEnvelope(downbeatOf('start'))
    expect(Math.max(...curve)).toBeLessThanOrEqual(CUE.peakGain + 1e-9)
    expect(Math.max(...curve)).toBeCloseTo(CUE.peakGain, 3)
  })

  it('resolves the attack with enough points to interpolate cleanly', () => {
    const curve = renderEnvelope(downbeatOf('start'))
    const pointsPerMs = curve.length / CUE.noteDurationMs
    expect(pointsPerMs * CUE.attackMs).toBeGreaterThanOrEqual(4)
  })

  it('scales linearly with gain', () => {
    const note = downbeatOf('start')
    const loud = Array.from(renderEnvelope({ ...note, gain: 0.2 }))
    const quiet = Array.from(renderEnvelope({ ...note, gain: 0.1 }))
    expect(loud).toHaveLength(quiet.length)
    for (const [i, value] of loud.entries()) {
      expect(value).toBeCloseTo((quiet[i] ?? Number.NaN) * 2, 6)
    }
  })
})

describe('decideCue', () => {
  it('sounds the start cue on entering listening', () => {
    expect(decideCue('idle', listening)).toBe('start')
  })

  it('sounds the stop cue on the normal release', () => {
    expect(decideCue('listening', processing)).toBe('stop')
  })

  it('sounds the stop cue on cancel and on failure too', () => {
    // Esc, and "didn't catch that" — both answer "am I still recording?" with
    // no, which is the question the cue exists to answer.
    expect(decideCue('listening', idle)).toBe('stop')
    expect(decideCue('listening', failed)).toBe('stop')
  })

  it('stays silent while listening repeats itself', () => {
    // `listening` re-fires as the level and the hands-free latch change; the cue
    // is an edge, not a state.
    expect(decideCue('listening', listening)).toBeNull()
    expect(decideCue('listening', { ...listening, handsFree: true, level: 0.9 })).toBeNull()
  })

  it('stays silent for transitions that never touch listening', () => {
    expect(decideCue('processing', { state: 'inserting' })).toBeNull()
    expect(decideCue('inserting', inserted)).toBeNull()
    expect(decideCue('idle', failed)).toBeNull()
    expect(decideCue('idle', idle)).toBeNull()
  })

  it('makes a full utterance sound exactly twice', () => {
    const utterance: DictationEvent[] = [
      listening,
      { ...listening, level: 0.8 },
      processing,
      { state: 'inserting' },
      inserted,
    ]

    let previous = restingStateOf(idle)
    const played = utterance.flatMap((event) => {
      const cue = decideCue(previous, event)
      previous = restingStateOf(event)
      return cue === null ? [] : [cue]
    })

    expect(played).toEqual(['start', 'stop'])
  })
})

describe('restingStateOf', () => {
  it('collapses the momentary events the way the state machine does', () => {
    expect(restingStateOf(inserted)).toBe('idle')
    expect(restingStateOf(failed)).toBe('idle')
    expect(restingStateOf(listening)).toBe('listening')
    expect(restingStateOf(processing)).toBe('processing')
  })
})
