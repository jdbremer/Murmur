import {
  constantPad,
  hannWindow,
  melFilterbank,
  powerSpectrum,
  reflectPad,
  type MelConfig,
} from './featurizer'

/**
 * The Granite Speech 5.0 front end (see `scripts/models/export-granite-speech.md`).
 *
 * Separate from `computeLogMel` rather than another set of flags on it. The two
 * share an STFT and a mel filterbank and agree on nothing after that: Parakeet
 * pre-emphasises, zero-pads, uses a symmetric window and Slaney-normalised
 * filters, takes a natural log with an additive guard, and normalises each mel
 * band across the utterance. Granite does none of those — periodic window,
 * reflect padding, unnormalised HTK filters, `log10` with a *relative* floor —
 * and then adds two stages Parakeet has no concept of. Folding both into one
 * function would make every branch a place to read the wrong config.
 *
 * The pipeline, from `GraniteSpeech5FeatureExtractor._extract_features`:
 *
 *  1. round the frame count *up* to a multiple of two and zero-pad the audio,
 *     so the trailing stacking pair is filled rather than dropped;
 *  2. power mel spectrogram, `torchaudio` defaults — power 2, centred, reflect
 *     padded, periodic Hann, HTK mel scale, no filter normalisation;
 *  3. `log10`, clamped below at 1e-10;
 *  4. floor every value at `max - 8`, where `max` is over the **whole clip**,
 *     then `/ 4 + 1`;
 *  5. append delta coefficients, doubling 80 bands to 160;
 *  6. concatenate adjacent frame pairs, giving 320 values every 20 ms.
 *
 * Checked against IBM's own extractor by
 * `test/granite-featurizer-parity.test.ts`.
 */

/** Mel bands before deltas and stacking. */
export const GRANITE_MEL_BINS = 80

/** Two adjacent frames are concatenated, so a feature frame spans 20 ms. */
export const GRANITE_FRAME_STACKING = 2

/** Log-mel values are floored this far below the clip's maximum. */
export const GRANITE_FLOOR_DB = 8

/** `torchaudio.functional.compute_deltas` default window for this model. */
export const GRANITE_DELTA_WIN_LENGTH = 3

/** What the encoder's `input_features` axis measures: (80 + 80 deltas) × 2. */
export const GRANITE_FEATURE_DIM = GRANITE_MEL_BINS * 2 * GRANITE_FRAME_STACKING

/**
 * The STFT half of the front end.
 *
 * `logZeroGuard`, `preEmphasis` and `normalize` are inert here — this config is
 * only ever read by {@link melFilterbank} and the window/padding choices — but
 * `MelConfig` is a closed shape and inventing a second one to omit three fields
 * would cost more than it explains.
 */
export const GRANITE_MEL: MelConfig = Object.freeze({
  sampleRate: 16_000,
  nFft: 512,
  winLength: 400,
  hopLength: 160,
  nMels: GRANITE_MEL_BINS,
  fMin: 0,
  fMax: 8_000,
  logZeroGuard: 0,
  preEmphasis: 0,
  normalize: 'none',
  // `torchaudio.transforms.MelSpectrogram` defaults, all of them silent if
  // wrong: `window_fn=torch.hann_window` is *periodic*, `center=True` reflect
  // pads, `norm=None` leaves unit-peak triangles and `mel_scale="htk"` places
  // them on the HTK curve rather than Slaney's.
  melNorm: 'none',
  window: 'periodic',
  padMode: 'reflect',
  melScale: 'htk',
})

export interface GraniteFeatures {
  /** Row-major `[frames][GRANITE_FEATURE_DIM]`, flattened. */
  data: Float32Array
  /** Stacked frames — half the mel frame count. */
  frames: number
  dim: number
}

/**
 * Stacked log-mel + delta features for Granite Speech 5.0.
 *
 * `pcm` is 16 kHz mono float; anything shorter than one stacked pair still
 * yields one frame, because the extractor pads rather than refusing.
 */
export function computeGraniteFeatures(
  pcm: Float32Array,
  config: MelConfig = GRANITE_MEL,
): GraniteFeatures {
  const bins = config.nMels
  // Round *up* to a whole number of stacking pairs. The extractor pads the
  // waveform to suit rather than dropping the remainder, so a 0.31 s clip keeps
  // its last 10 ms instead of silently losing it.
  const melFrames = Math.floor(pcm.length / config.hopLength)
  const frameCount =
    GRANITE_FRAME_STACKING * Math.ceil(melFrames / GRANITE_FRAME_STACKING) || GRANITE_FRAME_STACKING
  const samplesNeeded = (frameCount - 1) * config.hopLength + 1

  let audio = pcm
  if (audio.length < samplesNeeded) {
    const padded = new Float32Array(samplesNeeded)
    padded.set(audio)
    audio = padded
  }

  // `center=True`: frame k is centred on sample k * hop.
  const centred =
    config.padMode === 'reflect'
      ? reflectPad(audio, Math.floor(config.nFft / 2))
      : constantPad(audio, Math.floor(config.nFft / 2))

  const window = hannWindow(config.winLength, config.window)
  const filters = melFilterbank(config)
  const spectrumBins = Math.floor(config.nFft / 2) + 1

  // `[bins][frames]`, band-major — the layout the delta pass and the floor both
  // want, and the one the extractor works in before its final transpose.
  const logMel = new Float32Array(bins * frameCount)
  const windowed = new Float32Array(config.nFft)
  // A 400-sample window inside a 512-point frame sits centred, not
  // left-aligned; see `computeLogMel` for why that is not merely a phase shift.
  const windowOffset = Math.floor((config.nFft - config.winLength) / 2)

  let maximum = Number.NEGATIVE_INFINITY
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * config.hopLength
    windowed.fill(0)
    for (let index = 0; index < config.winLength; index += 1) {
      windowed[windowOffset + index] =
        (centred[start + windowOffset + index] ?? 0) * (window[index] ?? 0)
    }

    const power = powerSpectrum(windowed, config.nFft)
    for (let mel = 0; mel < bins; mel += 1) {
      let sum = 0
      const filterOffset = mel * spectrumBins
      for (let bin = 0; bin < spectrumBins; bin += 1) {
        sum += (filters[filterOffset + bin] ?? 0) * (power[bin] ?? 0)
      }
      // `clamp_min_(1e-10).log10_()` — base ten, and clamped rather than
      // guarded additively, so a silent band lands on exactly -10.
      const value = Math.log10(Math.max(sum, 1e-10))
      logMel[mel * frameCount + frame] = value
      if (value > maximum) maximum = value
    }
  }

  // A floor relative to the loudest point in *this clip*, not an absolute one.
  // It is what makes the features insensitive to recording gain, and it is why
  // the maximum has to be taken across every band and frame together.
  const floor = maximum - GRANITE_FLOOR_DB
  for (let index = 0; index < logMel.length; index += 1) {
    logMel[index] = (Math.max(logMel[index] ?? 0, floor) - 0) / 4 + 1
  }

  const deltas = computeDeltas(logMel, bins, frameCount, GRANITE_DELTA_WIN_LENGTH)

  // Interleave to `[stackedFrame][80 mel | 80 delta, ×2]`, which is the
  // transpose-then-reshape the extractor ends on.
  const stacked = frameCount / GRANITE_FRAME_STACKING
  const dim = bins * 2 * GRANITE_FRAME_STACKING
  const out = new Float32Array(stacked * dim)
  for (let frame = 0; frame < frameCount; frame += 1) {
    const target = Math.floor(frame / GRANITE_FRAME_STACKING)
    const half = (frame % GRANITE_FRAME_STACKING) * bins * 2
    const base = target * dim + half
    for (let mel = 0; mel < bins; mel += 1) {
      out[base + mel] = logMel[mel * frameCount + frame] ?? 0
      out[base + bins + mel] = deltas[mel * frameCount + frame] ?? 0
    }
  }

  return { data: out, frames: stacked, dim }
}

/**
 * `torchaudio.functional.compute_deltas`.
 *
 *     d_t = Σ_{n=1..N} n · (c_{t+n} − c_{t−n}) / (2 · Σ_{n=1..N} n²),  N = (win−1)/2
 *
 * with the edges extended by replication rather than zeros — zero-padding would
 * make the first and last frames read as a sharp transition from silence, which
 * is exactly where a real utterance carries its onset.
 */
export function computeDeltas(
  bandMajor: Float32Array,
  bins: number,
  frames: number,
  winLength: number,
): Float32Array {
  const n = Math.max(1, (winLength - 1) >> 1)
  let denominator = 0
  for (let k = 1; k <= n; k += 1) denominator += k * k
  denominator *= 2

  const out = new Float32Array(bandMajor.length)
  const at = (band: number, frame: number): number =>
    bandMajor[band * frames + Math.min(frames - 1, Math.max(0, frame))] ?? 0

  for (let band = 0; band < bins; band += 1) {
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0
      for (let k = 1; k <= n; k += 1) sum += k * (at(band, frame + k) - at(band, frame - k))
      out[band * frames + frame] = sum / denominator
    }
  }
  return out
}
