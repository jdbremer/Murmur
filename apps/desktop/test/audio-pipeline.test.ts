import { describe, expect, it } from 'vitest'

import { classifyCaptureError } from '../src/renderer/audio/errors'
import {
  FrameAssembler,
  FRAME_SAMPLES,
  METER_SAMPLES,
  normaliseLevel,
  peak,
  PreRoll,
  PRE_ROLL_SAMPLES,
  Resampler,
  rms,
  TARGET_SAMPLE_RATE,
  toTransferable,
} from '../src/renderer/audio/pipeline'

describe('Resampler', () => {
  it('is a pass-through when the rates already match', () => {
    const resampler = new Resampler(TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE)
    expect(resampler.passthrough).toBe(true)
    expect(Array.from(resampler.push(new Float32Array([0.1, 0.2])))).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(0.2, 6),
    ])
  })

  it('decimates 48 kHz to 16 kHz by averaging each window', () => {
    const resampler = new Resampler(48_000, 16_000)
    const output = resampler.push(new Float32Array([1, 1, 1, 0, 0, 0, 0.5, 0.5, 0.5]))
    expect(Array.from(output)).toEqual([
      expect.closeTo(1, 6),
      expect.closeTo(0, 6),
      expect.closeTo(0.5, 6),
    ])
  })

  it('carries the remainder across calls instead of dropping it', () => {
    const resampler = new Resampler(48_000, 16_000)
    const first = resampler.push(new Float32Array([1, 1]))
    expect(first).toHaveLength(0)
    const second = resampler.push(new Float32Array([1, 2, 2, 2]))
    expect(Array.from(second)).toEqual([expect.closeTo(1, 6), expect.closeTo(2, 6)])
  })

  it('handles a non-integer ratio without drifting', () => {
    const resampler = new Resampler(44_100, 16_000)
    const input = new Float32Array(44_100).fill(0.25)
    const output = resampler.push(input)
    // One second in, one second out, within a sample of rounding.
    expect(Math.abs(output.length - 16_000)).toBeLessThanOrEqual(1)
    expect(output[0]).toBeCloseTo(0.25, 6)
  })

  it('produces the expected count over many small blocks', () => {
    const resampler = new Resampler(48_000, 16_000)
    let produced = 0
    for (let index = 0; index < 100; index += 1) {
      produced += resampler.push(new Float32Array(128).fill(0.5)).length
    }
    expect(produced).toBeGreaterThanOrEqual(4266)
    expect(produced).toBeLessThanOrEqual(4267)
  })

  it('rejects nonsense rates', () => {
    expect(() => new Resampler(0, 16_000)).toThrow(RangeError)
  })
})

describe('FrameAssembler', () => {
  it('cuts fixed-size frames and keeps the remainder', () => {
    const assembler = new FrameAssembler(4)
    expect(assembler.push(new Float32Array([1, 2, 3]))).toHaveLength(0)
    const frames = assembler.push(new Float32Array([4, 5, 6, 7, 8]))
    expect(frames).toHaveLength(2)
    expect(Array.from(frames[0] ?? [])).toEqual([1, 2, 3, 4])
    expect(Array.from(frames[1] ?? [])).toEqual([5, 6, 7, 8])
    expect(assembler.pendingSamples).toBe(0)
  })

  it('loses nothing across a long stream', () => {
    const assembler = new FrameAssembler(FRAME_SAMPLES)
    let emitted = 0
    for (let index = 0; index < 50; index += 1) {
      for (const frame of assembler.push(new Float32Array(333))) emitted += frame.length
    }
    expect(emitted + assembler.pendingSamples).toBe(50 * 333)
  })

  it('rejects a nonsense frame size', () => {
    expect(() => new FrameAssembler(0)).toThrow(RangeError)
  })
})

describe('PreRoll', () => {
  it('keeps roughly the configured window and drops the oldest audio', () => {
    const roll = new PreRoll(1000)
    for (let index = 0; index < 20; index += 1) roll.push(new Float32Array(400).fill(index))
    expect(roll.samples).toBeGreaterThanOrEqual(1000)
    expect(roll.samples).toBeLessThan(1000 + 400)

    const drained = roll.drain()
    // Newest audio survives; the oldest was discarded.
    const last = drained.at(-1)?.[0]
    expect(last).toBe(19)
    expect(roll.samples).toBe(0)
  })

  it('holds ~300 ms by default (PLAN §5)', () => {
    expect(PRE_ROLL_SAMPLES / TARGET_SAMPLE_RATE).toBeCloseTo(0.3, 6)
  })

  it('is inert when disabled', () => {
    const roll = new PreRoll(0)
    roll.push(new Float32Array(10))
    expect(roll.drain()).toHaveLength(0)
  })
})

describe('level metering', () => {
  it('measures RMS and peak', () => {
    const samples = new Float32Array([1, -1, 1, -1])
    expect(rms(samples)).toBeCloseTo(1, 6)
    expect(peak(new Float32Array([0.2, -0.7, 0.3]))).toBeCloseTo(0.7, 6)
    expect(rms(new Float32Array(0))).toBe(0)
  })

  it('maps silence to 0 and full scale to 1', () => {
    expect(normaliseLevel(0)).toBe(0)
    expect(normaliseLevel(1)).toBe(1)
  })

  it('puts conversational speech in the usable middle of the range', () => {
    const speech = normaliseLevel(0.05)
    expect(speech).toBeGreaterThan(0.25)
    expect(speech).toBeLessThan(0.85)
  })

  it('is monotonic', () => {
    let previous = -1
    for (const amplitude of [0.001, 0.01, 0.05, 0.1, 0.3, 0.6, 1]) {
      const level = normaliseLevel(amplitude)
      expect(level).toBeGreaterThanOrEqual(previous)
      previous = level
    }
  })

  it('meters about thirty times a second (PLAN §2.1)', () => {
    expect(TARGET_SAMPLE_RATE / METER_SAMPLES).toBeCloseTo(30, 0)
  })

  it('frames about every 100 ms (PLAN §5)', () => {
    expect(FRAME_SAMPLES / TARGET_SAMPLE_RATE).toBeCloseTo(0.1, 6)
  })
})

describe('toTransferable', () => {
  it('copies the samples into a standalone buffer', () => {
    const samples = new Float32Array([0.5, -0.25])
    const buffer = toTransferable(samples)
    expect(buffer.byteLength).toBe(8)
    expect(Array.from(new Float32Array(buffer))).toEqual([0.5, -0.25])
    // A view of the copy, not of a larger pool.
    expect(new Float32Array(buffer)).toHaveLength(samples.length)
  })
})

describe('classifyCaptureError', () => {
  it('names the next action for a denied microphone', () => {
    const error = classifyCaptureError(named('NotAllowedError'))
    expect(error.code).toBe('permission-denied')
    expect(error.message).toContain('System Settings')
  })

  it('recognises a microphone another app is holding', () => {
    expect(classifyCaptureError(named('NotReadableError')).code).toBe('mic-in-use')
    expect(classifyCaptureError(named('AbortError')).code).toBe('mic-in-use')
    expect(classifyCaptureError(named('NotReadableError')).message).toMatch(/another app/i)
  })

  it('recognises a missing or vanished device', () => {
    expect(classifyCaptureError(named('NotFoundError')).code).toBe('no-device')
    expect(classifyCaptureError(named('OverconstrainedError')).code).toBe('no-device')
  })

  it('falls back to something readable for anything else', () => {
    const error = classifyCaptureError(new Error('kaboom'))
    expect(error.code).toBe('unknown')
    expect(error.message).toContain('kaboom')
    expect(classifyCaptureError(undefined).code).toBe('unknown')
  })
})

function named(name: string): Error {
  const error = new Error(`${name} raised`)
  error.name = name
  return error
}
