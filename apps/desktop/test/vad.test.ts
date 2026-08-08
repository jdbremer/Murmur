import { describe, expect, it } from 'vitest'

import { AUDIO } from '../src/main/config'
import {
  amplitudeToDb,
  analyse,
  frameRms,
  frameZcr,
  levelFromFrame,
  SilenceTracker,
  trimSilence,
} from '../src/main/audio/vad'
import { concat, roomTone, silence, speechLike, tone } from './helpers/pcm'

/** An arbitrary trailing-silence window: this exercises the tracker's
 *  contract, not a product policy (hands-free no longer finalises on silence,
 *  and meeting capture brings its own MEETING.segmentSilenceMs). */
const FINALISE_MS = 800

/**
 * VAD tests (PLAN §5).
 *
 * The gate is energy + zero-crossings with an adaptive noise floor, so the
 * interesting cases are the ones where those two disagree: a loud low tone
 * (high energy, low ZCR) and hiss (low energy, high ZCR) must both stay closed,
 * while speech-shaped noise must open it.
 */

describe('frame primitives', () => {
  it('measures RMS', () => {
    expect(frameRms(new Float32Array([0, 0, 0, 0]), 0, 4)).toBe(0)
    expect(frameRms(new Float32Array([1, -1, 1, -1]), 0, 4)).toBeCloseTo(1, 6)
    expect(frameRms(new Float32Array([0.5, -0.5]), 0, 2)).toBeCloseTo(0.5, 6)
  })

  it('returns 0 RMS for an empty or inverted range', () => {
    expect(frameRms(new Float32Array([1, 1]), 2, 2)).toBe(0)
    expect(frameRms(new Float32Array([1, 1]), 5, 1)).toBe(0)
  })

  it('counts zero crossings per sample, not per sign change run', () => {
    // +,-,+,- is three crossings across four samples.
    expect(frameZcr(new Float32Array([1, -1, 1, -1]), 0, 4)).toBeCloseTo(3 / 4, 6)
    // A run of exact zeros must not count once per sample.
    expect(frameZcr(new Float32Array([0, 0, 0, 0]), 0, 4)).toBe(0)
    expect(frameZcr(new Float32Array([1, 1, 1, 1]), 0, 4)).toBe(0)
  })

  it('maps amplitude to dB with a finite floor', () => {
    expect(amplitudeToDb(1)).toBeCloseTo(0, 6)
    expect(amplitudeToDb(0.1)).toBeCloseTo(-20, 6)
    expect(Number.isFinite(amplitudeToDb(0))).toBe(true)
  })
})

describe('analyse', () => {
  it('finds no speech in digital silence', () => {
    const result = analyse(silence(2000))
    expect(result.speechStart).toBeNull()
    expect(result.speechEnd).toBeNull()
    expect(result.frames.every((frame) => !frame.speech)).toBe(true)
  })

  it('finds no speech in quiet room tone', () => {
    const result = analyse(roomTone(2000))
    expect(result.speechStart).toBeNull()
  })

  it('opens the gate on speech-shaped noise', () => {
    const result = analyse(concat(roomTone(400), speechLike(1200), roomTone(400)))
    expect(result.speechStart).not.toBeNull()
    expect(result.speechEnd).not.toBeNull()
    expect(result.frames.some((frame) => frame.speech)).toBe(true)
  })

  it('keeps the gate shut for a low-frequency tone burst (energy without voicing)', () => {
    // 40 Hz at 16 kHz crosses zero ~80 times a second: a ZCR of 0.005 is the
    // floor, and this sits under it, so the door slam / rumble case stays out.
    const result = analyse(concat(roomTone(400), tone(800, 20, 0.5), roomTone(400)))
    expect(result.speechStart).toBeNull()
  })

  it('handles a buffer shorter than one frame without throwing', () => {
    const result = analyse(new Float32Array(100))
    expect(result.frames).toHaveLength(0)
    expect(result.speechStart).toBeNull()
  })
})

describe('trimSilence', () => {
  it('reports silence and returns the original buffer untouched', () => {
    const input = roomTone(1500)
    const result = trimSilence(input, AUDIO.sampleRate)
    expect(result.silent).toBe(true)
    expect(result.speechMs).toBe(0)
    expect(result.pcm).toBe(input)
  })

  it('trims leading and trailing silence around speech', () => {
    const speech = speechLike(1000)
    const input = concat(roomTone(1500), speech, roomTone(1500))
    const result = trimSilence(input, AUDIO.sampleRate)

    expect(result.silent).toBe(false)
    expect(result.pcm.length).toBeLessThan(input.length)
    // The speech itself must survive, padding included.
    expect(result.pcm.length).toBeGreaterThanOrEqual(speech.length * 0.8)
    expect(result.speechMs).toBeGreaterThan(300)
  })

  it('keeps padding around the speech rather than cutting exactly at the onset', () => {
    const input = concat(roomTone(1000), speechLike(800), roomTone(1000))
    const tight = trimSilence(input, AUDIO.sampleRate, { padFrames: 0 })
    const padded = trimSilence(input, AUDIO.sampleRate, { padFrames: 16 })
    expect(padded.pcm.length).toBeGreaterThan(tight.pcm.length)
  })

  it('bridges a short pause inside one utterance via the hangover', () => {
    // 200 ms of quiet mid-sentence: with a 25-frame (500 ms) hangover the gate
    // stays open, so both halves come back as one region.
    const input = concat(
      roomTone(600),
      speechLike(600, 0.25, 3),
      roomTone(200),
      speechLike(600, 0.25, 9),
      roomTone(600),
    )
    const result = trimSilence(input, AUDIO.sampleRate)
    expect(result.silent).toBe(false)
    // Both speech segments plus the bridged pause: comfortably over 1 s.
    expect(result.pcm.length).toBeGreaterThan((1.2 * AUDIO.sampleRate) / 1)
  })
})

describe('SilenceTracker', () => {
  const frame = (source: Float32Array, index: number, size = 1600): Float32Array =>
    source.slice(index * size, (index + 1) * size)

  it('does not finalise before any speech has been seen', () => {
    const tracker = new SilenceTracker(AUDIO.sampleRate)
    const quiet = roomTone(3000)
    for (let index = 0; index < 30; index += 1) tracker.push(frame(quiet, index))

    expect(tracker.sawSpeech).toBe(false)
    expect(tracker.shouldFinalise(FINALISE_MS)).toBe(false)
  })

  it('finalises after the configured trailing silence, once speech has happened', () => {
    const tracker = new SilenceTracker(AUDIO.sampleRate)

    const speech = speechLike(1000)
    for (let index = 0; index < 10; index += 1) tracker.push(frame(speech, index))
    expect(tracker.sawSpeech).toBe(true)
    expect(tracker.shouldFinalise(FINALISE_MS)).toBe(false)

    // 900 ms of quiet at 100 ms per frame.
    const quiet = roomTone(1000)
    for (let index = 0; index < 9; index += 1) tracker.push(frame(quiet, index))

    expect(tracker.trailingSilenceMs).toBeGreaterThanOrEqual(FINALISE_MS)
    expect(tracker.shouldFinalise(FINALISE_MS)).toBe(true)
  })

  it('resets trailing silence when speech resumes', () => {
    const tracker = new SilenceTracker(AUDIO.sampleRate)
    const speech = speechLike(1000)
    const quiet = roomTone(1000)

    for (let index = 0; index < 6; index += 1) tracker.push(frame(speech, index))
    for (let index = 0; index < 5; index += 1) tracker.push(frame(quiet, index))
    expect(tracker.trailingSilenceMs).toBeGreaterThan(0)

    for (let index = 0; index < 4; index += 1) tracker.push(frame(speech, index))
    expect(tracker.trailingSilenceMs).toBe(0)
  })

  it('reset() clears everything', () => {
    const tracker = new SilenceTracker(AUDIO.sampleRate)
    const speech = speechLike(600)
    for (let index = 0; index < 5; index += 1) tracker.push(frame(speech, index))
    tracker.reset()
    expect(tracker.sawSpeech).toBe(false)
    expect(tracker.trailingSilenceMs).toBe(0)
  })
})

describe('levelFromFrame', () => {
  it('maps silence to 0 and full scale to 1', () => {
    expect(levelFromFrame(new Float32Array(320))).toBe(0)
    expect(levelFromFrame(new Float32Array(320).fill(1))).toBe(1)
  })

  it('is monotonic in amplitude', () => {
    const quiet = levelFromFrame(new Float32Array(320).fill(0.01))
    const loud = levelFromFrame(new Float32Array(320).fill(0.3))
    expect(loud).toBeGreaterThan(quiet)
    expect(quiet).toBeGreaterThan(0)
  })
})
