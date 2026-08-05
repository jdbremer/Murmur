import { VAD } from '../config'

/**
 * Voice activity detection — energy + zero-crossing gate, no ML (PLAN §5).
 *
 * Deliberately *not* Silero: the US-only policy holds even for utility models,
 * so this is a WebRTC-VAD-lineage gate written in-house. It does two jobs:
 *
 *  1. **Trim** leading and trailing silence before STT, so a model never sees
 *     two seconds of room tone (which is what makes Whisper hallucinate
 *     "Thank you." into an empty recording).
 *  2. **Auto-finalise** hands-free utterances after ~800 ms of trailing
 *     silence, via the streaming {@link SilenceTracker}.
 *
 * Everything here is a pure function over Float32 PCM, which is what makes it
 * testable against synthetic signals: silence, tone bursts, and speech-shaped
 * noise all have predictable RMS/ZCR signatures.
 *
 * ## Why energy *and* zero-crossings
 *
 * Energy alone fires on a door slam and on a fan. The zero-crossing rate
 * separates them: voiced speech sits roughly in the 0.02–0.30 crossings/sample
 * band, broadband noise and hiss run much higher, and a low rumble much lower.
 * Requiring both is what keeps the gate from opening on HVAC noise while still
 * catching a quietly-spoken word.
 *
 * ## Adaptive floor
 *
 * A fixed dB threshold cannot work across a MacBook mic in a quiet room and
 * AirPods on a train. The detector keeps a running estimate of the noise floor,
 * updated only while the gate is *closed*, and calls a frame speech when it is
 * {@link VAD.thresholdDb} above that floor. Speech therefore never raises the
 * floor to the point where it hides itself.
 */

export interface VadFrameStats {
  /** Root-mean-square amplitude, 0..1-ish for normalised PCM. */
  rms: number
  /** Crossings per sample, 0..1. Voiced speech ≈ 0.02–0.30. */
  zcr: number
  /** True when this frame passed both the energy and the ZCR test. */
  speech: boolean
}

export interface VadOptions {
  frameSamples?: number
  thresholdDb?: number
  silenceFloorRms?: number
  onsetFrames?: number
  hangoverFrames?: number
  padFrames?: number
  noiseAdaptation?: number
}

interface ResolvedVadOptions {
  frameSamples: number
  thresholdDb: number
  silenceFloorRms: number
  onsetFrames: number
  hangoverFrames: number
  padFrames: number
  noiseAdaptation: number
}

function resolve(options: VadOptions): ResolvedVadOptions {
  return {
    frameSamples: options.frameSamples ?? VAD.frameSamples,
    thresholdDb: options.thresholdDb ?? VAD.thresholdDb,
    silenceFloorRms: options.silenceFloorRms ?? VAD.silenceFloorRms,
    onsetFrames: options.onsetFrames ?? VAD.onsetFrames,
    hangoverFrames: options.hangoverFrames ?? VAD.hangoverFrames,
    padFrames: options.padFrames ?? VAD.padFrames,
    noiseAdaptation: options.noiseAdaptation ?? VAD.noiseAdaptation,
  }
}

/** Voiced speech band, in crossings per sample. Outside it, energy is ignored. */
const ZCR_MIN = 0.005
const ZCR_MAX = 0.35

// ---------------------------------------------------------------------------
// Frame primitives (pure)
// ---------------------------------------------------------------------------

/** Root-mean-square amplitude of `[start, end)`. */
export function frameRms(pcm: Float32Array, start: number, end: number): number {
  const stop = Math.min(end, pcm.length)
  if (stop <= start) return 0
  let sum = 0
  for (let i = start; i < stop; i += 1) {
    const sample = pcm[i] ?? 0
    sum += sample * sample
  }
  return Math.sqrt(sum / (stop - start))
}

/** Zero-crossings per sample of `[start, end)`. */
export function frameZcr(pcm: Float32Array, start: number, end: number): number {
  const stop = Math.min(end, pcm.length)
  if (stop - start < 2) return 0
  let crossings = 0
  let previous = pcm[start] ?? 0
  for (let i = start + 1; i < stop; i += 1) {
    const sample = pcm[i] ?? 0
    // Strict sign change only: a run of exact zeros must not count once per sample.
    if ((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0)) crossings += 1
    previous = sample
  }
  return crossings / (stop - start)
}

/** Linear amplitude ratio → decibels, with a floor so silence is finite. */
export function amplitudeToDb(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-10))
}

// ---------------------------------------------------------------------------
// Whole-buffer analysis
// ---------------------------------------------------------------------------

export interface VadAnalysis {
  /** Per-frame stats, in order. */
  frames: VadFrameStats[]
  /** Samples per frame actually used. */
  frameSamples: number
  /** Index of the first speech sample, or `null` when nothing was speech. */
  speechStart: number | null
  /** Index one past the last speech sample, or `null`. */
  speechEnd: number | null
  /** Estimated noise floor RMS after processing the buffer. */
  noiseFloorRms: number
}

/**
 * Run the gate over a whole utterance.
 *
 * The result is deliberately raw — indices and per-frame stats — so callers can
 * trim, measure speech duration, or draw a debug view without re-analysing.
 */
export function analyse(pcm: Float32Array, options: VadOptions = {}): VadAnalysis {
  const config = resolve(options)
  const { frameSamples } = config
  const frameCount = Math.floor(pcm.length / frameSamples)

  // Seed the noise floor from the quietest tenth of the buffer, so a recording
  // that opens mid-word is not mis-scaled by its own first frame.
  let noiseFloor = seedNoiseFloor(pcm, frameSamples, frameCount, config.silenceFloorRms)

  const frames: VadFrameStats[] = []
  let consecutiveSpeech = 0
  let consecutiveSilence = 0
  let open = false
  let firstSpeechFrame: number | null = null
  let lastSpeechFrame: number | null = null

  for (let index = 0; index < frameCount; index += 1) {
    const start = index * frameSamples
    const end = start + frameSamples
    const rms = frameRms(pcm, start, end)
    const zcr = frameZcr(pcm, start, end)

    const loudEnough =
      rms >= config.silenceFloorRms &&
      amplitudeToDb(rms) - amplitudeToDb(noiseFloor) >= config.thresholdDb
    const voiced = zcr >= ZCR_MIN && zcr <= ZCR_MAX
    const candidate = loudEnough && voiced

    if (candidate) {
      consecutiveSpeech += 1
      consecutiveSilence = 0
    } else {
      consecutiveSilence += 1
      consecutiveSpeech = 0
      // Only adapt while the gate is shut, so speech cannot raise its own floor.
      if (!open) {
        noiseFloor = noiseFloor * (1 - config.noiseAdaptation) + rms * config.noiseAdaptation
      }
    }

    if (!open && consecutiveSpeech >= config.onsetFrames) {
      open = true
      // Backdate the onset to where the run of speech frames actually began.
      const onsetFrame = index - (config.onsetFrames - 1)
      firstSpeechFrame ??= onsetFrame
      for (let back = onsetFrame; back < index; back += 1) {
        const frame = frames[back]
        if (frame) frame.speech = true
      }
    } else if (open && consecutiveSilence > config.hangoverFrames) {
      open = false
    }

    const speech = open && candidate ? true : open && consecutiveSilence <= config.hangoverFrames
    if (speech) lastSpeechFrame = index

    frames.push({ rms, zcr, speech: speech && open })
  }

  if (firstSpeechFrame === null || lastSpeechFrame === null) {
    return {
      frames,
      frameSamples,
      speechStart: null,
      speechEnd: null,
      noiseFloorRms: noiseFloor,
    }
  }

  const paddedStart = Math.max(0, firstSpeechFrame - config.padFrames)
  const paddedEnd = Math.min(frameCount, lastSpeechFrame + 1 + config.padFrames)

  return {
    frames,
    frameSamples,
    speechStart: paddedStart * frameSamples,
    speechEnd: Math.min(pcm.length, paddedEnd * frameSamples),
    noiseFloorRms: noiseFloor,
  }
}

function seedNoiseFloor(
  pcm: Float32Array,
  frameSamples: number,
  frameCount: number,
  minimum: number,
): number {
  if (frameCount === 0) return minimum
  const sample = Math.max(1, Math.floor(frameCount / 10))
  const values: number[] = []
  for (let index = 0; index < frameCount; index += 1) {
    values.push(frameRms(pcm, index * frameSamples, (index + 1) * frameSamples))
  }
  values.sort((a, b) => a - b)
  let sum = 0
  for (let index = 0; index < sample; index += 1) sum += values[index] ?? 0
  return Math.max(minimum, sum / sample)
}

export interface TrimResult {
  /** The trimmed audio — a *view* is never returned, always a copy. */
  pcm: Float32Array
  /** Milliseconds of speech kept (excludes the padding). */
  speechMs: number
  /** True when the gate never opened: caller should report "no speech". */
  silent: boolean
}

/**
 * Trim leading and trailing silence.
 *
 * When the gate never opens the original buffer is returned untouched with
 * `silent: true`, so the caller decides what "no speech" means — the
 * orchestrator turns it into a `no-speech` error, but a future long-form mode
 * might not.
 */
export function trimSilence(
  pcm: Float32Array,
  sampleRate: number,
  options: VadOptions = {},
): TrimResult {
  const analysis = analyse(pcm, options)
  if (analysis.speechStart === null || analysis.speechEnd === null) {
    return { pcm, speechMs: 0, silent: true }
  }

  const trimmed = pcm.slice(analysis.speechStart, analysis.speechEnd)
  const speechFrames = analysis.frames.filter((frame) => frame.speech).length
  const speechMs = (speechFrames * analysis.frameSamples * 1000) / sampleRate
  return { pcm: trimmed, speechMs, silent: trimmed.length === 0 }
}

// ---------------------------------------------------------------------------
// Streaming: hands-free auto-finalise
// ---------------------------------------------------------------------------

/**
 * Tracks trailing silence across incoming frames so hands-free mode can
 * finalise an utterance without a key release (PLAN §5).
 *
 * Fed the same ~100 ms frames the capture renderer sends. It is intentionally
 * simpler than {@link analyse}: it only needs "has it been quiet for 800 ms
 * *after* some speech", not accurate boundaries.
 */
export class SilenceTracker {
  readonly #config: ResolvedVadOptions
  readonly #sampleRate: number
  #noiseFloor: number
  #sawSpeech = false
  #silentSamples = 0

  constructor(sampleRate: number, options: VadOptions = {}) {
    this.#sampleRate = sampleRate
    this.#config = resolve(options)
    this.#noiseFloor = this.#config.silenceFloorRms
  }

  /** True once any frame in this utterance was classified as speech. */
  get sawSpeech(): boolean {
    return this.#sawSpeech
  }

  /** Milliseconds of continuous trailing silence right now. */
  get trailingSilenceMs(): number {
    return (this.#silentSamples * 1000) / this.#sampleRate
  }

  /**
   * Feed one frame.
   *
   * @returns whether this frame was speech, so the caller can drive a level
   *   meter from the same pass.
   */
  push(frame: Float32Array): boolean {
    const rms = frameRms(frame, 0, frame.length)
    const zcr = frameZcr(frame, 0, frame.length)
    const loudEnough =
      rms >= this.#config.silenceFloorRms &&
      amplitudeToDb(rms) - amplitudeToDb(this.#noiseFloor) >= this.#config.thresholdDb
    const speech = loudEnough && zcr >= ZCR_MIN && zcr <= ZCR_MAX

    if (speech) {
      this.#sawSpeech = true
      this.#silentSamples = 0
    } else {
      this.#silentSamples += frame.length
      this.#noiseFloor =
        this.#noiseFloor * (1 - this.#config.noiseAdaptation) + rms * this.#config.noiseAdaptation
    }
    return speech
  }

  /** True when the utterance should auto-finalise. */
  shouldFinalise(silenceMs: number): boolean {
    return this.#sawSpeech && this.trailingSilenceMs >= silenceMs
  }

  reset(): void {
    this.#sawSpeech = false
    this.#silentSamples = 0
    this.#noiseFloor = this.#config.silenceFloorRms
  }
}

/**
 * Normalised 0..1 level for the Bar's waveform.
 *
 * Perceptual rather than linear: RMS is mapped through a −60…0 dB window so a
 * quiet voice still moves the bars, which is what the reference UX does.
 */
export function levelFromFrame(frame: Float32Array): number {
  const rms = frameRms(frame, 0, frame.length)
  const db = amplitudeToDb(rms)
  const normalised = (db + 60) / 60
  return Math.min(1, Math.max(0, normalised))
}
