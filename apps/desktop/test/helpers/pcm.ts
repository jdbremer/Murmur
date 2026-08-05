import { AUDIO } from '../../src/main/config'

/**
 * Synthetic PCM generators for the VAD and featurizer tests.
 *
 * Deterministic on purpose — a seeded PRNG rather than `Math.random` — so a
 * failing assertion is reproducible and a threshold change shows up as the same
 * diff on every machine.
 */

/** mulberry32: tiny, fast, and good enough for test noise. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function samplesFor(ms: number, sampleRate = AUDIO.sampleRate): number {
  return Math.round((ms / 1000) * sampleRate)
}

/** Digital silence. */
export function silence(ms: number, sampleRate = AUDIO.sampleRate): Float32Array {
  return new Float32Array(samplesFor(ms, sampleRate))
}

/** Very quiet broadband noise — a real room, not a null signal. */
export function roomTone(ms: number, amplitude = 0.0008, seed = 1): Float32Array {
  const random = seededRandom(seed)
  const out = new Float32Array(samplesFor(ms))
  for (let index = 0; index < out.length; index += 1) {
    out[index] = (random() * 2 - 1) * amplitude
  }
  return out
}

/** A pure tone — high energy, very low zero-crossing rate at low frequencies. */
export function tone(
  ms: number,
  frequency = 220,
  amplitude = 0.3,
  sampleRate = AUDIO.sampleRate,
): Float32Array {
  const out = new Float32Array(samplesFor(ms, sampleRate))
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * amplitude
  }
  return out
}

/**
 * Speech-shaped noise: a ~140 Hz glottal buzz with formant-ish harmonics and a
 * syllable-rate amplitude envelope. Not speech, but it lands in the same
 * energy/ZCR neighbourhood, which is what the gate keys on.
 */
export function speechLike(ms: number, amplitude = 0.25, seed = 7): Float32Array {
  const random = seededRandom(seed)
  const sampleRate = AUDIO.sampleRate
  const out = new Float32Array(samplesFor(ms))
  const f0 = 140

  for (let index = 0; index < out.length; index += 1) {
    const t = index / sampleRate
    // Harmonic stack, loosely voiced.
    const voiced =
      Math.sin(2 * Math.PI * f0 * t) * 0.6 +
      Math.sin(2 * Math.PI * f0 * 2 * t) * 0.25 +
      Math.sin(2 * Math.PI * f0 * 5 * t) * 0.12 +
      Math.sin(2 * Math.PI * 1900 * t) * 0.06
    // Fricative hiss, a little of it.
    const noise = (random() * 2 - 1) * 0.08
    // ~5 Hz syllable envelope, never fully closing.
    const envelope = 0.55 + 0.45 * Math.sin(2 * Math.PI * 5 * t)
    out[index] = (voiced + noise) * envelope * amplitude
  }
  return out
}

/** Concatenate segments into one buffer. */
export function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
