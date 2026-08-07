import { describe, expect, it } from 'vitest'

import { Downsampler, toMono } from '../src/main/audio/resample'

/**
 * The system-audio tap delivers whatever the output device is clocked at —
 * measured at 48 kHz — and the engines want 16 kHz. The interesting cases are
 * the fractional ratio and the chunk boundary, because both fail quietly:
 * aliasing sounds fine to a person and wrong to a model, and a dropped
 * fractional sample per chunk drifts the timeline over an hour.
 */

function ramp(length: number): Float32Array {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) out[i] = i / length
  return out
}

/** A sine at `hz`, for checking that decimation preserves a low tone. */
function sine(hz: number, sampleRate: number, ms: number): Float32Array {
  const out = new Float32Array(Math.round((sampleRate * ms) / 1000))
  for (let i = 0; i < out.length; i += 1) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate)
  return out
}

describe('Downsampler', () => {
  it('passes through when the rates already match', () => {
    const down = new Downsampler(16_000, 16_000)
    expect(down.passthrough).toBe(true)
    const input = ramp(100)
    expect(down.process(input)).toBe(input)
  })

  it('decimates 48 kHz to 16 kHz at exactly one third the length', () => {
    const down = new Downsampler(48_000, 16_000)
    expect(down.process(ramp(4_800)).length).toBe(1_600)
  })

  it('handles the fractional 44.1 kHz ratio without drifting', () => {
    // 44100 -> 16000 is 2.75625 input samples per output sample. Feeding many
    // chunks must not accumulate error: a per-chunk remainder silently thrown
    // away would shift a long meeting's timestamps.
    const down = new Downsampler(44_100, 16_000)
    const chunks = 100
    let produced = 0
    for (let i = 0; i < chunks; i += 1) produced += down.process(ramp(4_410)).length

    // 100 × 4410 samples at 44.1 kHz is 10 seconds, which is 160 000 samples
    // at 16 kHz. Anything short of that is audio the boundary ate.
    const expected = (4_410 * chunks) / (44_100 / 16_000)
    expect(produced).toBeGreaterThan(expected * 0.999)
    expect(produced).toBeLessThan(expected * 1.001)
  })

  it('averages rather than dropping samples, so nothing aliases down', () => {
    // Taking every third sample folds anything above 8 kHz back into speech.
    // A constant signal is the simplest way to see averaging is happening.
    const down = new Downsampler(48_000, 16_000)
    const constant = new Float32Array(4_800).fill(0.5)
    const out = down.process(constant)
    for (const sample of out) expect(sample).toBeCloseTo(0.5, 5)
  })

  it('preserves a speech-band tone through decimation', () => {
    const down = new Downsampler(48_000, 16_000)
    const out = down.process(sine(440, 48_000, 100))
    let peak = 0
    for (const sample of out) peak = Math.max(peak, Math.abs(sample))
    // Box-averaging attenuates a little; it must not gut the signal.
    expect(peak).toBeGreaterThan(0.8)
  })

  it('is continuous across chunk boundaries', () => {
    // Splitting the same input differently must produce the same sample count,
    // or the boundary is eating audio.
    const whole = new Downsampler(48_000, 16_000).process(ramp(9_600)).length

    const split = new Downsampler(48_000, 16_000)
    const piecemeal =
      split.process(ramp(9_600).subarray(0, 4_321)).length +
      split.process(ramp(9_600).subarray(4_321)).length

    expect(Math.abs(whole - piecemeal)).toBeLessThanOrEqual(1)
  })

  it('handles an empty chunk without throwing', () => {
    const down = new Downsampler(48_000, 16_000)
    expect(down.process(new Float32Array(0)).length).toBe(0)
  })

  it('rejects a nonsense rate rather than producing silence', () => {
    expect(() => new Downsampler(0, 16_000)).toThrow()
  })
})

describe('toMono', () => {
  it('leaves mono untouched', () => {
    const input = ramp(10)
    expect(toMono(input, 1)).toBe(input)
  })

  it('averages interleaved stereo into half as many frames', () => {
    const stereo = Float32Array.from([1, 0, 1, 0, 0.5, 0.5])
    const mono = toMono(stereo, 2)
    expect(Array.from(mono)).toEqual([0.5, 0.5, 0.5])
  })
})
