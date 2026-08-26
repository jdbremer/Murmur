import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { analyse } from '../src/main/audio/vad'

/**
 * The gate that stops an ONNX model transcribing silence.
 *
 * Every ONNX speech model here invents words when handed audio with no speech
 * in it. Measured on Granite Speech 5.0: pure digital silence decodes to
 * "thank", quiet noise to "thank you", room noise to "okay" — the same
 * vocabulary whisper.cpp invents, which is what `transcript.ts` cleans up
 * after.
 *
 * `stripHallucinatedTail` cannot be reused on this path, and the reason is
 * worth pinning in a test rather than only in a comment. It needs per-segment
 * confidence to compare a suspect tail against its neighbours; the ONNX host
 * has one `avgLogProb` for the whole utterance. Measured, that number does not
 * separate the two cases at all — correctly transcribed speech that was quiet
 * *and* noisy scored **-0.359**, worse than every hallucination measured
 * (-0.10 to -0.30). A threshold on it would discard good transcriptions in
 * precisely the rooms where people already struggle.
 *
 * Voice activity does separate them, completely, which is what these tests
 * hold in place.
 */
describe('the silence gate the ONNX host runs before transcribing', () => {
  /** Deterministic pseudo-noise — no Math.random, so a failure reproduces. */
  const noise = (amplitude: number, samples = 24_000, seed = 3): Float32Array => {
    let state = seed
    return Float32Array.from({ length: samples }, () => {
      state = (state * 1103515245 + 12345) % 2147483648
      return (state / 2147483648 - 0.5) * 2 * amplitude
    })
  }

  /**
   * 1.5 s of real recorded speech.
   *
   * Real rather than a synthesised buzz, because the gate tests zero-crossing
   * rate as well as energy: a sum of pure tones is not the ordinary case and
   * passing it proves less than it appears to.
   */
  const recorded = Float32Array.from(
    (
      JSON.parse(
        readFileSync(join(__dirname, '__fixtures__/granite-speech/speech-pcm.json'), 'utf8'),
      ) as { pcm: number[] }
    ).pcm,
  )
  const speech = (gain = 1): Float32Array => Float32Array.from(recorded, (v) => v * gain)

  it('finds no speech in digital silence', () => {
    expect(analyse(new Float32Array(24_000)).speechStart).toBeNull()
  })

  it('finds no speech in noise at any level', () => {
    // The three levels that made Granite say "thank", "thank you" and "okay".
    for (const amplitude of [0.001, 0.005, 0.02, 0.05]) {
      expect(analyse(noise(amplitude)).speechStart, `amplitude ${amplitude}`).toBeNull()
    }
  })

  it('still finds speech that is very quiet', () => {
    // A twentieth of normal level. The gate must not become a loudness test —
    // someone dictating quietly in an open office is the ordinary case.
    expect(analyse(speech(0.05)).speechStart).not.toBeNull()
  })

  it('still finds speech buried in noise', () => {
    // The noise buffer is built once, not per sample — the naive version is
    // quadratic and turned this file into a 48-second test run.
    const hiss = noise(0.02, recorded.length)
    const buried = Float32Array.from(speech(0.3), (v, i) => v + (hiss[i] ?? 0))
    expect(analyse(buried).speechStart).not.toBeNull()
  })

  it('still finds speech in an utterance as short as a single word', () => {
    // The gate must not become a duration test. Someone dictating just "okay"
    // sends a few hundred milliseconds, and `trimSilence` has already cut the
    // quiet either side of it before this runs — so what reaches the gate is
    // the word alone. Measured: detected down to 120 ms, which is shorter than
    // a spoken syllable.
    for (const ms of [800, 500, 300, 200, 120]) {
      const samples = Math.round((ms / 1000) * 16_000)
      expect(analyse(recorded.slice(0, samples)).speechStart, `${ms}ms`).not.toBeNull()
    }
  })

  it('finds nothing in an empty buffer rather than throwing', () => {
    expect(analyse(new Float32Array(0)).speechStart).toBeNull()
  })

  it('reports where the speech starts, so the gate is not merely a boolean', () => {
    // Silence, then speech. The index is what lets a caller trim as well as
    // decide, which is why `analyse` returns it rather than a yes/no.
    const padded = new Float32Array(recorded.length + 16_000)
    padded.set(recorded, 16_000)
    const found = analyse(padded)
    expect(found.speechStart).not.toBeNull()
    expect(found.speechStart ?? 0).toBeGreaterThan(8_000)
  })
})
