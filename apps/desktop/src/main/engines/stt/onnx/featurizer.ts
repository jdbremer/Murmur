/**
 * Log-mel filterbank features for the ONNX Runtime STT path (PLAN §6.1).
 *
 * Which models need this, and which do not — this matters and is easy to get
 * wrong:
 *
 *  - **Parakeet / NeMo Conformer models** consume 80-bin log-mel features
 *    computed exactly the way NeMo's `AudioToMelSpectrogramPreprocessor` does.
 *    Getting a constant wrong here does not crash — it quietly degrades
 *    accuracy, which is the worst kind of bug, so every constant below cites
 *    where it comes from.
 *  - **Moonshine consumes raw 16 kHz waveform.** Its `preprocessor_config.json`
 *    declares `feature_extractor_type: "Wav2Vec2FeatureExtractor"` with
 *    `feature_size: 1`; the front-end convolutions inside the encoder replace
 *    the mel stage entirely. Do not run this featurizer for Moonshine.
 *
 * Everything here is pure and deterministic, so it can be checked against a
 * reference implementation offline (see `scripts/models/export-parakeet.md` for
 * how the fixtures are produced).
 */

export interface MelConfig {
  sampleRate: number
  /** FFT size. NeMo: `n_fft = 512` at 16 kHz (0.025 s window rounded up). */
  nFft: number
  /** Window length in samples. NeMo: `window_size = 0.025 s` → 400. */
  winLength: number
  /** Hop in samples. NeMo: `window_stride = 0.01 s` → 160. */
  hopLength: number
  /** Number of mel bands. NeMo Conformer/Parakeet: 80. */
  nMels: number
  /** Lowest mel-filter edge, Hz. */
  fMin: number
  /** Highest mel-filter edge, Hz. Defaults to Nyquist. */
  fMax: number
  /** Added inside the log to keep it finite. NeMo: 2**-24. */
  logZeroGuard: number
  /** NeMo applies a 0.97 pre-emphasis filter before framing. */
  preEmphasis: number
  /** Per-utterance mean/variance normalisation, as NeMo's `normalize: per_feature`. */
  normalize: 'per_feature' | 'none'
  /**
   * Filterbank normalisation.
   *
   * `slaney` scales each triangle by `2 / (rightHz - leftHz)` so every filter
   * has unit *area* rather than unit peak — librosa's default, which NeMo
   * passes straight through as `mel_norm`. `none` leaves unit-peak triangles.
   *
   * **This is the single most likely thing to be wrong**, because getting it
   * wrong does not crash: it rescales every feature and quietly costs accuracy.
   * The export script records the model's actual value, and the parity check in
   * `scripts/models/export-parakeet.md` is what confirms it before a Parakeet
   * entry may enter the catalog.
   */
  melNorm: 'slaney' | 'none'
}

/**
 * The Parakeet / NeMo Conformer front-end.
 *
 * Source of the numbers: NVIDIA NeMo's `AudioToMelSpectrogramPreprocessor`
 * defaults as used by the `parakeet-tdt` configs — 16 kHz, 25 ms window, 10 ms
 * stride, 80 mel bins, Hann window, pre-emphasis 0.97, per-feature
 * normalisation, `log_zero_guard_value = 2**-24` added before the log.
 */
export const PARAKEET_MEL: MelConfig = Object.freeze({
  sampleRate: 16_000,
  nFft: 512,
  winLength: 400,
  hopLength: 160,
  nMels: 80,
  fMin: 0,
  fMax: 8_000,
  logZeroGuard: 2 ** -24,
  preEmphasis: 0.97,
  normalize: 'per_feature',
  melNorm: 'slaney',
})

export interface MelFeatures {
  /** Row-major `[frames][nMels]`, flattened. */
  data: Float32Array
  frames: number
  nMels: number
}

// ---------------------------------------------------------------------------
// Building blocks (pure, individually testable)
// ---------------------------------------------------------------------------

/** Slaney-style Hz → mel, the convention NeMo and torchaudio share. */
export function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700)
}

export function melToHz(mel: number): number {
  return 700 * (10 ** (mel / 2595) - 1)
}

/**
 * Triangular mel filterbank, `[nMels][nFft/2 + 1]` flattened row-major.
 *
 * See {@link MelConfig.melNorm} for why the normalisation is a parameter rather
 * than a constant.
 */
export function melFilterbank(config: MelConfig): Float32Array {
  const bins = Math.floor(config.nFft / 2) + 1
  const filters = new Float32Array(config.nMels * bins)

  const melMin = hzToMel(config.fMin)
  const melMax = hzToMel(config.fMax)
  // nMels + 2 edges: each filter spans [edge i, edge i+2] peaking at edge i+1.
  const edges = new Float64Array(config.nMels + 2)
  for (let index = 0; index < edges.length; index += 1) {
    edges[index] = melToHz(melMin + ((melMax - melMin) * index) / (config.nMels + 1))
  }

  const binToHz = config.sampleRate / config.nFft

  for (let mel = 0; mel < config.nMels; mel += 1) {
    const left = edges[mel] ?? 0
    const centre = edges[mel + 1] ?? 0
    const right = edges[mel + 2] ?? 0
    // Slaney: unit area rather than unit peak. Narrow low-frequency bands get a
    // larger scale, wide high-frequency ones a smaller one.
    const scale = config.melNorm === 'slaney' && right > left ? 2 / (right - left) : 1

    for (let bin = 0; bin < bins; bin += 1) {
      const hz = bin * binToHz
      let weight = 0
      if (hz >= left && hz <= centre && centre > left) {
        weight = (hz - left) / (centre - left)
      } else if (hz > centre && hz <= right && right > centre) {
        weight = (right - hz) / (right - centre)
      }
      filters[mel * bins + bin] = weight * scale
    }
  }

  return filters
}

/** Periodic Hann window — the variant used for spectral analysis. */
export function hannWindow(length: number): Float32Array {
  const window = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / length)
  }
  return window
}

/**
 * Radix-2 in-place complex FFT.
 *
 * Small and self-contained on purpose: an FFT dependency would be another
 * package to audit and sign for a function that is 40 lines. `size` must be a
 * power of two, which every `nFft` we use is.
 */
export function fftInPlace(real: Float64Array, imag: Float64Array): void {
  const size = real.length
  if (size !== imag.length || (size & (size - 1)) !== 0) {
    throw new Error('fftInPlace requires equal-length power-of-two buffers')
  }

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = real[i] ?? 0
      real[i] = real[j] ?? 0
      real[j] = tr
      const ti = imag[i] ?? 0
      imag[i] = imag[j] ?? 0
      imag[j] = ti
    }
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length
    const wpr = Math.cos(angle)
    const wpi = Math.sin(angle)
    for (let start = 0; start < size; start += length) {
      let wr = 1
      let wi = 0
      for (let offset = 0; offset < length / 2; offset += 1) {
        const a = start + offset
        const b = a + length / 2
        const xr = real[b] ?? 0
        const xi = imag[b] ?? 0
        const tr = wr * xr - wi * xi
        const ti = wr * xi + wi * xr
        real[b] = (real[a] ?? 0) - tr
        imag[b] = (imag[a] ?? 0) - ti
        real[a] = (real[a] ?? 0) + tr
        imag[a] = (imag[a] ?? 0) + ti
        const nextWr = wr * wpr - wi * wpi
        wi = wr * wpi + wi * wpr
        wr = nextWr
      }
    }
  }
}

/** Power spectrum (|X|²) of one windowed frame, `nFft/2 + 1` bins. */
export function powerSpectrum(frame: Float32Array, nFft: number): Float32Array {
  const real = new Float64Array(nFft)
  const imag = new Float64Array(nFft)
  const copy = Math.min(frame.length, nFft)
  for (let index = 0; index < copy; index += 1) real[index] = frame[index] ?? 0

  fftInPlace(real, imag)

  const bins = Math.floor(nFft / 2) + 1
  const power = new Float32Array(bins)
  for (let bin = 0; bin < bins; bin += 1) {
    const re = real[bin] ?? 0
    const im = imag[bin] ?? 0
    power[bin] = re * re + im * im
  }
  return power
}

// ---------------------------------------------------------------------------
// The featurizer
// ---------------------------------------------------------------------------

/**
 * PCM → log-mel features.
 *
 * Order of operations, matching NeMo:
 *   pre-emphasis → frame (centre-padded, reflect) → Hann → |FFT|² →
 *   mel filterbank → log(x + guard) → per-feature normalisation.
 */
export function computeLogMel(pcm: Float32Array, config: MelConfig = PARAKEET_MEL): MelFeatures {
  const emphasised = applyPreEmphasis(pcm, config.preEmphasis)
  const padded = reflectPad(emphasised, Math.floor(config.nFft / 2))

  const frames = Math.max(0, Math.floor((padded.length - config.nFft) / config.hopLength) + 1)
  const window = hannWindow(config.winLength)
  const filters = melFilterbank(config)
  const bins = Math.floor(config.nFft / 2) + 1

  const out = new Float32Array(frames * config.nMels)
  const windowed = new Float32Array(config.nFft)

  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * config.hopLength
    windowed.fill(0)
    for (let index = 0; index < config.winLength; index += 1) {
      windowed[index] = (padded[start + index] ?? 0) * (window[index] ?? 0)
    }

    const power = powerSpectrum(windowed, config.nFft)
    for (let mel = 0; mel < config.nMels; mel += 1) {
      let sum = 0
      const filterOffset = mel * bins
      for (let bin = 0; bin < bins; bin += 1) {
        sum += (filters[filterOffset + bin] ?? 0) * (power[bin] ?? 0)
      }
      out[frame * config.nMels + mel] = Math.log(sum + config.logZeroGuard)
    }
  }

  if (config.normalize === 'per_feature') normalisePerFeature(out, frames, config.nMels)

  return { data: out, frames, nMels: config.nMels }
}

/** `y[n] = x[n] - a * x[n-1]`, with `y[0] = x[0]`. */
export function applyPreEmphasis(pcm: Float32Array, coefficient: number): Float32Array {
  if (coefficient === 0) return pcm
  const out = new Float32Array(pcm.length)
  out[0] = pcm[0] ?? 0
  for (let index = 1; index < pcm.length; index += 1) {
    out[index] = (pcm[index] ?? 0) - coefficient * (pcm[index - 1] ?? 0)
  }
  return out
}

/**
 * Reflect-pad both ends by `pad` samples — what `torch.stft(center=True)` does,
 * so frame `k` is centred on sample `k * hop`.
 */
export function reflectPad(pcm: Float32Array, pad: number): Float32Array {
  if (pad <= 0 || pcm.length === 0) return pcm
  const out = new Float32Array(pcm.length + pad * 2)
  out.set(pcm, pad)
  for (let index = 0; index < pad; index += 1) {
    // Mirror without repeating the edge sample itself.
    out[pad - 1 - index] = pcm[Math.min(index + 1, pcm.length - 1)] ?? 0
    out[pad + pcm.length + index] = pcm[Math.max(pcm.length - 2 - index, 0)] ?? 0
  }
  return out
}

/**
 * Zero-mean, unit-variance per mel band across the utterance (NeMo's
 * `normalize: per_feature`). Mutates `data` in place.
 */
export function normalisePerFeature(data: Float32Array, frames: number, nMels: number): void {
  if (frames === 0) return
  for (let mel = 0; mel < nMels; mel += 1) {
    let sum = 0
    for (let frame = 0; frame < frames; frame += 1) sum += data[frame * nMels + mel] ?? 0
    const mean = sum / frames

    let variance = 0
    for (let frame = 0; frame < frames; frame += 1) {
      const delta = (data[frame * nMels + mel] ?? 0) - mean
      variance += delta * delta
    }
    // NeMo uses the unbiased estimator and guards single-frame utterances.
    const std = Math.sqrt(variance / Math.max(1, frames - 1)) + 1e-5

    for (let frame = 0; frame < frames; frame += 1) {
      data[frame * nMels + mel] = ((data[frame * nMels + mel] ?? 0) - mean) / std
    }
  }
}

/**
 * Transpose `[frames][nMels]` → `[nMels][frames]`.
 *
 * NeMo's exported graphs take `[batch, features, time]`, which is the transpose
 * of the layout that falls out of framing. Kept separate so the featurizer
 * itself stays in the natural order and the adapter is one obvious call.
 */
export function toChannelsFirst(features: MelFeatures): Float32Array {
  const { data, frames, nMels } = features
  const out = new Float32Array(data.length)
  for (let frame = 0; frame < frames; frame += 1) {
    for (let mel = 0; mel < nMels; mel += 1) {
      out[mel * frames + frame] = data[frame * nMels + mel] ?? 0
    }
  }
  return out
}
