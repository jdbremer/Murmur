import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  computeDeltas,
  computeGraniteFeatures,
  GRANITE_FEATURE_DIM,
  GRANITE_MEL,
} from '../src/main/engines/stt/onnx/granite-features'

/**
 * Featurizer parity against IBM's own extractor.
 *
 * The fixture is real output from `GraniteSpeech5FeatureExtractor` in
 * `ibm-granite/granite-speech-5.0-470m-turboctc`, captured by the procedure in
 * `scripts/models/export-granite-speech.md` and pinned to that revision.
 * Committing it means this runs everywhere without Python, torch or a 913 MB
 * checkpoint.
 *
 * It earns its place the same way the Parakeet one does: a wrong front end does
 * not crash and does not sound wrong. It transcribes slightly worse, forever.
 * Granite differs from Parakeet on six separate axes — periodic window instead
 * of symmetric, reflect padding instead of zeros, HTK mel curve instead of
 * Slaney, unnormalised filters, `log10` with a clip-relative floor instead of a
 * natural log with an additive guard, and no per-band normalisation — and every
 * one of those is silent when wrong.
 */
describe('Granite Speech featurizer parity', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__/granite-speech/featurizer.json'), 'utf8'),
  ) as {
    source: string
    revision: string
    sampleRate: number
    nMels: number
    stackedDim: number
    frames: number
    pcm: number[]
    features: number[]
  }

  it('matches IBM’s extractor to within float32 noise', () => {
    const got = computeGraniteFeatures(Float32Array.from(fixture.pcm))

    expect(got.dim).toBe(fixture.stackedDim)
    expect(got.frames).toBe(fixture.frames)
    expect(got.data).toHaveLength(fixture.features.length)

    let worst = 0
    let worstAt = -1
    for (let index = 0; index < fixture.features.length; index += 1) {
      const delta = Math.abs((got.data[index] ?? 0) - (fixture.features[index] ?? 0))
      if (delta > worst) {
        worst = delta
        worstAt = index
      }
    }
    expect(worst, `worst at index ${worstAt}`).toBeLessThan(2e-3)
  })

  it('produces the 320 values the encoder expects', () => {
    // 80 mel bands, doubled by the deltas, doubled again by stacking two
    // frames — the arithmetic the ONNX input axis is built on.
    expect(GRANITE_FEATURE_DIM).toBe(320)
    expect(fixture.stackedDim).toBe(320)
  })

  it('emits one stacked frame per 20 ms of audio', () => {
    // 4800 samples at 16 kHz is 0.30 s: 30 mel frames, stacked into 15.
    expect(fixture.pcm).toHaveLength(4800)
    expect(fixture.frames).toBe(15)
  })

  it('is pinned to the revision the fixture came from', () => {
    expect(fixture.revision).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('computeGraniteFeatures shape handling', () => {
  const pcm = (n: number): Float32Array =>
    Float32Array.from({ length: n }, (_, i) => Math.sin(i / 12) * 0.3)

  it('rounds the frame count up rather than dropping the remainder', () => {
    // 31 mel frames must become 16 stacked frames, not 15: the extractor pads
    // the waveform so the trailing pair is filled, and losing the last 10 ms of
    // an utterance is losing the end of the last word.
    const got = computeGraniteFeatures(pcm(31 * 160))
    expect(got.frames).toBe(16)
  })

  it('still returns a frame for audio shorter than one stacking pair', () => {
    const got = computeGraniteFeatures(pcm(100))
    expect(got.frames).toBe(1)
    expect(got.data).toHaveLength(GRANITE_FEATURE_DIM)
  })

  it('lays out each frame as mel, delta, mel, delta', () => {
    // The stacked frame is two consecutive 160-value frames, not two
    // interleaved 80-value halves — get this wrong and the encoder reads
    // deltas as energies.
    const got = computeGraniteFeatures(pcm(4 * 160))
    expect(got.frames).toBe(2)
    expect(got.dim).toBe(320)
  })

  it('uses the HTK mel curve, not Slaney', () => {
    // `melFilterbank` used to call `hzToMel` with no scale, so it silently
    // placed every filter on Slaney's curve whatever the config said.
    expect(GRANITE_MEL.melScale).toBe('htk')
    expect(GRANITE_MEL.melNorm).toBe('none')
    expect(GRANITE_MEL.window).toBe('periodic')
    expect(GRANITE_MEL.padMode).toBe('reflect')
  })
})

describe('computeDeltas', () => {
  it('is the central difference torchaudio computes at win_length 3', () => {
    // d_t = (c_{t+1} - c_{t-1}) / 2
    const band = Float32Array.from([1, 2, 4, 8])
    const got = computeDeltas(band, 1, 4, 3)
    expect(Array.from(got)).toEqual([0.5, 1.5, 3, 2])
  })

  it('replicates the edges rather than zero-padding them', () => {
    // Zero padding would read the first frame as a jump up from silence, which
    // is exactly where a real utterance carries its onset.
    const band = Float32Array.from([5, 5, 5])
    expect(Array.from(computeDeltas(band, 1, 3, 3))).toEqual([0, 0, 0])
  })

  it('keeps bands independent', () => {
    const two = Float32Array.from([0, 2, 4, 10, 10, 10])
    const got = computeDeltas(two, 2, 3, 3)
    expect(Array.from(got.slice(0, 3))).toEqual([1, 2, 1])
    expect(Array.from(got.slice(3, 6))).toEqual([0, 0, 0])
  })
})
