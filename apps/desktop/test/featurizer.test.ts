import { describe, expect, it } from 'vitest'

import {
  applyPreEmphasis,
  computeLogMel,
  fftInPlace,
  hannWindow,
  hzToMel,
  melFilterbank,
  melToHz,
  normalisePerFeature,
  PARAKEET_MEL,
  powerSpectrum,
  reflectPad,
  toChannelsFirst,
} from '../src/main/engines/stt/onnx/featurizer'
import { silence, tone } from './helpers/pcm'

/**
 * Log-mel featurizer (PLAN §6.1).
 *
 * Every constant in `PARAKEET_MEL` is a claim about NeMo's preprocessor, and a
 * wrong one degrades accuracy silently rather than crashing. These tests pin
 * the *mathematical* properties that would catch such a mistake — the numeric
 * parity check against NeMo itself is a macOS/GPU job, described in
 * `scripts/models/export-parakeet.md`.
 */

describe('mel scale', () => {
  it('round-trips Hz → mel → Hz', () => {
    for (const hz of [0, 100, 440, 1000, 4000, 8000]) {
      expect(melToHz(hzToMel(hz))).toBeCloseTo(hz, 6)
    }
  })

  it('uses the Slaney/HTK 2595·log10 convention', () => {
    expect(hzToMel(1000)).toBeCloseTo(2595 * Math.log10(1 + 1000 / 700), 9)
    expect(hzToMel(0)).toBe(0)
  })

  it('is monotonic and compressive', () => {
    // A mel is a perceptual step: equal mel gaps are ever-wider in Hz.
    const lowSpan = melToHz(1000) - melToHz(900)
    const highSpan = melToHz(2000) - melToHz(1900)
    expect(highSpan).toBeGreaterThan(lowSpan)
  })
})

describe('melFilterbank', () => {
  const bins = PARAKEET_MEL.nFft / 2 + 1

  it('has one triangular filter per mel band', () => {
    const filters = melFilterbank(PARAKEET_MEL)
    expect(filters.length).toBe(PARAKEET_MEL.nMels * bins)
  })

  it('gives every filter unit peak when melNorm is off', () => {
    const filters = melFilterbank({ ...PARAKEET_MEL, melNorm: 'none', nMels: 40 })
    const bandBins = PARAKEET_MEL.nFft / 2 + 1
    for (let mel = 0; mel < 40; mel += 1) {
      let peak = 0
      for (let bin = 0; bin < bandBins; bin += 1) {
        peak = Math.max(peak, filters[mel * bandBins + bin] ?? 0)
      }
      // With 40 bands over 0–8 kHz every triangle spans several FFT bins, so a
      // bin lands close to each peak.
      expect(peak).toBeGreaterThan(0.5)
      expect(peak).toBeLessThanOrEqual(1.0001)
    }
  })

  it('weights bands by inverse bandwidth when melNorm is slaney', () => {
    const plain = melFilterbank({ ...PARAKEET_MEL, melNorm: 'none' })
    const slaney = melFilterbank(PARAKEET_MEL)
    const areaOf = (filters: Float32Array, mel: number): number => {
      let total = 0
      for (let bin = 0; bin < bins; bin += 1) total += filters[mel * bins + bin] ?? 0
      return total
    }

    // Slaney scales each triangle by 2/(rightHz − leftHz), so every band ends up
    // with roughly the same *area* regardless of how wide it is in Hz. Without
    // it, a high band — several times wider — dominates a low one.
    const lowRatio = areaOf(slaney, 2) / areaOf(plain, 2)
    const highRatio = areaOf(slaney, 79) / areaOf(plain, 79)
    expect(lowRatio).toBeGreaterThan(highRatio)

    // The whole point: areas are comparable across the bank under slaney…
    const slaneyAreas = [10, 30, 50, 70].map((mel) => areaOf(slaney, mel))
    const slaneySpread = Math.max(...slaneyAreas) / Math.min(...slaneyAreas)
    // …and are not, without it.
    const plainAreas = [10, 30, 50, 70].map((mel) => areaOf(plain, mel))
    const plainSpread = Math.max(...plainAreas) / Math.min(...plainAreas)
    expect(slaneySpread).toBeLessThan(plainSpread)
  })

  it('assigns every band some weight, at either normalisation', () => {
    for (const melNorm of ['slaney', 'none'] as const) {
      const filters = melFilterbank({ ...PARAKEET_MEL, melNorm })
      for (let mel = 0; mel < PARAKEET_MEL.nMels; mel += 1) {
        let total = 0
        for (let bin = 0; bin < bins; bin += 1) total += filters[mel * bins + bin] ?? 0
        expect(total, `band ${mel} (${melNorm}) has no weight`).toBeGreaterThan(0)
      }
    }
  })

  it('never produces a negative weight', () => {
    const filters = melFilterbank(PARAKEET_MEL)
    expect(filters.every((weight) => weight >= 0)).toBe(true)
  })

  it('places later filters at higher frequencies', () => {
    const filters = melFilterbank(PARAKEET_MEL)
    const centroid = (mel: number): number => {
      let weighted = 0
      let total = 0
      for (let bin = 0; bin < bins; bin += 1) {
        const weight = filters[mel * bins + bin] ?? 0
        weighted += weight * bin
        total += weight
      }
      return total > 0 ? weighted / total : 0
    }
    expect(centroid(60)).toBeGreaterThan(centroid(10))
  })
})

describe('hannWindow', () => {
  it('is periodic, starting at 0 and peaking mid-window', () => {
    const window = hannWindow(8)
    expect(window[0]).toBeCloseTo(0, 9)
    expect(window[4]).toBeCloseTo(1, 9)
    // Periodic (not symmetric): the last sample is not 0.
    expect(window[7]).toBeGreaterThan(0)
  })

  it('is symmetric about its peak', () => {
    const window = hannWindow(16)
    for (let index = 1; index < 8; index += 1) {
      expect(window[8 - index]).toBeCloseTo(window[8 + index] ?? 0, 9)
    }
  })
})

describe('fftInPlace', () => {
  it('transforms a DC signal into a single bin', () => {
    const real = Float64Array.from([1, 1, 1, 1, 1, 1, 1, 1])
    const imag = new Float64Array(8)
    fftInPlace(real, imag)

    expect(real[0]).toBeCloseTo(8, 9)
    for (let index = 1; index < 8; index += 1) {
      expect(Math.hypot(real[index] ?? 0, imag[index] ?? 0)).toBeCloseTo(0, 9)
    }
  })

  it('puts a sinusoid at its own bin', () => {
    const size = 64
    const real = new Float64Array(size)
    const imag = new Float64Array(size)
    for (let index = 0; index < size; index += 1) {
      real[index] = Math.cos((2 * Math.PI * 4 * index) / size)
    }
    fftInPlace(real, imag)

    const magnitude = (bin: number): number => Math.hypot(real[bin] ?? 0, imag[bin] ?? 0)
    expect(magnitude(4)).toBeCloseTo(size / 2, 6)
    expect(magnitude(5)).toBeCloseTo(0, 6)
  })

  it('rejects a non-power-of-two size', () => {
    expect(() => fftInPlace(new Float64Array(6), new Float64Array(6))).toThrow(/power-of-two/)
  })
})

describe('powerSpectrum', () => {
  it('returns nFft/2 + 1 bins', () => {
    expect(powerSpectrum(new Float32Array(512), 512).length).toBe(257)
  })

  it('locates a tone at the right bin', () => {
    const nFft = 512
    const sampleRate = 16_000
    const frequency = 1000
    const frame = new Float32Array(nFft)
    for (let index = 0; index < nFft; index += 1) {
      frame[index] = Math.sin((2 * Math.PI * frequency * index) / sampleRate)
    }

    const power = powerSpectrum(frame, nFft)
    const expectedBin = Math.round((frequency * nFft) / sampleRate)
    let peakBin = 0
    for (let bin = 0; bin < power.length; bin += 1) {
      if ((power[bin] ?? 0) > (power[peakBin] ?? 0)) peakBin = bin
    }
    expect(peakBin).toBe(expectedBin)
  })
})

describe('applyPreEmphasis', () => {
  it('is a first-order high-pass with y[0] = x[0]', () => {
    const out = applyPreEmphasis(Float32Array.from([1, 2, 3, 4]), 0.97)
    expect(out[0]).toBeCloseTo(1, 6)
    expect(out[1]).toBeCloseTo(2 - 0.97 * 1, 6)
    expect(out[3]).toBeCloseTo(4 - 0.97 * 3, 6)
  })

  it('is the identity when the coefficient is 0', () => {
    const input = Float32Array.from([1, 2, 3])
    expect(applyPreEmphasis(input, 0)).toBe(input)
  })
})

describe('reflectPad', () => {
  it('mirrors without repeating the edge sample', () => {
    const out = reflectPad(Float32Array.from([1, 2, 3, 4, 5]), 2)
    expect(Array.from(out)).toEqual([3, 2, 1, 2, 3, 4, 5, 4, 3])
  })

  it('is the identity for zero padding', () => {
    const input = Float32Array.from([1, 2, 3])
    expect(reflectPad(input, 0)).toBe(input)
  })
})

describe('normalisePerFeature', () => {
  it('centres every band on zero', () => {
    const frames = 4
    const nMels = 2
    // Band 0: 1..4, band 1: 10..40.
    const data = Float32Array.from([1, 10, 2, 20, 3, 30, 4, 40])
    normalisePerFeature(data, frames, nMels)

    for (let mel = 0; mel < nMels; mel += 1) {
      let sum = 0
      for (let frame = 0; frame < frames; frame += 1) sum += data[frame * nMels + mel] ?? 0
      expect(sum / frames).toBeCloseTo(0, 5)
    }
  })

  it('does nothing to an empty buffer', () => {
    const data = new Float32Array(0)
    expect(() => normalisePerFeature(data, 0, 80)).not.toThrow()
  })
})

describe('computeLogMel', () => {
  it('produces one frame per hop with nMels bands', () => {
    // 1 s at 16 kHz, 10 ms hop → ~100 frames (centre-padded).
    const features = computeLogMel(tone(1000, 440, 0.3))
    expect(features.nMels).toBe(80)
    expect(features.frames).toBeGreaterThan(95)
    expect(features.frames).toBeLessThan(105)
    expect(features.data.length).toBe(features.frames * features.nMels)
  })

  it('never produces NaN or Infinity, even on digital silence', () => {
    const features = computeLogMel(silence(500))
    expect(features.data.every((value) => Number.isFinite(value))).toBe(true)
  })

  it('puts a 1 kHz tone’s energy in the right mel band', () => {
    const features = computeLogMel(tone(500, 1000, 0.5), { ...PARAKEET_MEL, normalize: 'none' })
    const middle = Math.floor(features.frames / 2)

    let peakBand = 0
    for (let mel = 1; mel < features.nMels; mel += 1) {
      const value = features.data[middle * features.nMels + mel] ?? -Infinity
      if (value > (features.data[middle * features.nMels + peakBand] ?? -Infinity)) peakBand = mel
    }

    // 1 kHz sits a little under halfway up an 80-band 0–8 kHz mel scale.
    const expected = Math.round((hzToMel(1000) / hzToMel(8000)) * PARAKEET_MEL.nMels)
    expect(Math.abs(peakBand - expected)).toBeLessThanOrEqual(3)
  })

  it('is deterministic', () => {
    const pcm = tone(200, 300, 0.2)
    expect(Array.from(computeLogMel(pcm).data)).toEqual(Array.from(computeLogMel(pcm).data))
  })

  it('handles an empty buffer without throwing', () => {
    const features = computeLogMel(new Float32Array(0))
    expect(features.frames).toBe(0)
    expect(features.data.length).toBe(0)
  })
})

describe('toChannelsFirst', () => {
  it('transposes [frames][mels] to [mels][frames]', () => {
    const features = { data: Float32Array.from([1, 2, 3, 4, 5, 6]), frames: 3, nMels: 2 }
    // rows: (1,2) (3,4) (5,6) → columns: (1,3,5) (2,4,6)
    expect(Array.from(toChannelsFirst(features))).toEqual([1, 3, 5, 2, 4, 6])
  })
})

describe('PARAKEET_MEL', () => {
  it('records NeMo’s documented constants', () => {
    expect(PARAKEET_MEL).toMatchObject({
      sampleRate: 16_000,
      nFft: 512,
      winLength: 400, // 25 ms
      hopLength: 160, // 10 ms
      nMels: 80,
      preEmphasis: 0.97,
      normalize: 'per_feature',
      // Slaney is librosa's default, which NeMo passes through as `mel_norm`.
      // Confirmed by the parity check in scripts/models/export-parakeet.md
      // before a Parakeet entry may be added (PLAN §16).
      melNorm: 'slaney',
    })
    expect(PARAKEET_MEL.logZeroGuard).toBeCloseTo(2 ** -24, 12)
  })
})
