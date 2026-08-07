import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { computeLogMel, PARAKEET_MEL } from '../src/main/engines/stt/onnx/featurizer'

/**
 * Featurizer parity against NVIDIA's own extractor (PLAN §6.1, §16).
 *
 * The fixture is real output from `ParakeetFeatureExtractor` in the shipped
 * `nvidia/parakeet-tdt-0.6b-v3` repo, captured once by
 * `scripts/models/export-parakeet.md`'s procedure. Committing it means this
 * check runs everywhere without Python, torch, or the 2.4 GB checkpoint.
 *
 * It is worth more than it looks. A wrong front-end does not crash and does not
 * sound wrong — it just transcribes a bit worse forever. Writing this test
 * found five separate defects, every one of which was silent:
 *
 *  1. 80 mel bands where v3 uses 128.
 *  2. The HTK mel formula behind a function named "Slaney" — different curve,
 *     so every filter sat at the wrong frequency.
 *  3. Reflect padding where the extractor zero-pads.
 *  4. The 400-sample window left-aligned in the 512-point FFT frame instead of
 *     centred, which reads a different 400 samples per frame.
 *  5. One frame too many, whose log-mel is the padding floor and which drags
 *     the per-feature mean and standard deviation.
 */
describe('Parakeet featurizer parity', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__/parakeet/featurizer.json'), 'utf8'),
  ) as {
    source: string
    sampleRate: number
    validFrames: number
    nMels: number
    pcm: number[]
    features: number[]
  }

  it('matches NVIDIA’s extractor to within float32 noise', () => {
    const got = computeLogMel(Float32Array.from(fixture.pcm), PARAKEET_MEL)

    expect(got.nMels).toBe(fixture.nMels)
    expect(got.frames).toBe(fixture.validFrames)

    let maxAbs = 0
    for (let i = 0; i < fixture.features.length; i += 1) {
      maxAbs = Math.max(maxAbs, Math.abs((got.data[i] ?? 0) - (fixture.features[i] ?? 0)))
    }
    // The guide's bar. Anything above this is a real front-end disagreement,
    // not rounding — the fixture itself is stored to 5 decimal places.
    expect(maxAbs).toBeLessThan(1e-3)
  })

  it('pins the constants the fixture was generated against', () => {
    expect(PARAKEET_MEL.nMels).toBe(128)
    expect(PARAKEET_MEL.window).toBe('symmetric')
    expect(PARAKEET_MEL.padMode).toBe('constant')
    expect(PARAKEET_MEL.melNorm).toBe('slaney')
    expect(fixture.source).toContain('parakeet-tdt-0.6b-v3')
  })
})
