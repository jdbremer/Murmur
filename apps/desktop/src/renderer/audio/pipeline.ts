/**
 * The sample-level half of microphone capture (PLAN §5) — pure functions only.
 *
 * Everything here runs on Float32 arrays and nothing here touches the DOM, the
 * Web Audio API or IPC. That is deliberate: this stage is built on a machine
 * with no microphone and no display, so the parts that can be wrong in a way a
 * reviewer cannot see — resampling arithmetic, frame boundaries, the level
 * curve — are the parts that are unit-tested. {@link ./capture.ts} owns the
 * device and the audio graph and does no arithmetic of its own.
 */

/** Everything downstream of the microphone speaks 16 kHz mono Float32. */
export const TARGET_SAMPLE_RATE = 16_000
/** ~100 ms per IPC frame (PLAN §5). */
export const FRAME_SAMPLES = TARGET_SAMPLE_RATE / 10
/** ~33 ms — a 30 Hz meter, which the Bar interpolates up to 60 fps. */
export const METER_SAMPLES = Math.round(TARGET_SAMPLE_RATE / 30)
/** ~300 ms of pre-roll so the first syllable survives (PLAN §5). */
export const PRE_ROLL_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.3)

/**
 * Rate conversion with a box-average anti-alias filter.
 *
 * Usually a no-op: the capture graph asks for a 16 kHz `AudioContext` and
 * Chromium resamples the device natively, which is better than anything worth
 * hand-writing here. This exists for the contexts that refuse the request (some
 * aggregate and Bluetooth devices), where the alternative is aliased audio
 * being fed to an STT model that will quietly transcribe it wrong.
 *
 * Averaging each output sample over its whole source window is a crude
 * low-pass, but it is the correct crude one for integer-ish decimation ratios
 * (48000/16000 = 3), which is the case that actually occurs.
 */
export class Resampler {
  readonly #ratio: number
  #tail: Float32Array = new Float32Array(0)
  /** Fractional read position inside `tail ++ input`. */
  #position = 0

  constructor(
    readonly inputRate: number,
    readonly outputRate: number = TARGET_SAMPLE_RATE,
  ) {
    if (!(inputRate > 0) || !(outputRate > 0)) {
      throw new RangeError('Sample rates must be positive')
    }
    this.#ratio = inputRate / outputRate
  }

  /** True when input and output rates match and `push` is a straight copy. */
  get passthrough(): boolean {
    return this.#ratio === 1
  }

  reset(): void {
    this.#tail = new Float32Array(0)
    this.#position = 0
  }

  push(input: Float32Array): Float32Array {
    if (this.passthrough) return input.slice()
    if (input.length === 0) return new Float32Array(0)

    const source = concat(this.#tail, input)
    const ratio = this.#ratio
    // How many output samples have a *complete* source window available.
    const available = Math.max(0, Math.floor((source.length - this.#position) / ratio))
    const output = new Float32Array(available)

    let position = this.#position
    for (let index = 0; index < available; index += 1) {
      const from = Math.floor(position)
      const to = Math.min(source.length, Math.floor(position + ratio))
      let sum = 0
      let count = 0
      for (let cursor = from; cursor < to; cursor += 1) {
        sum += source[cursor] ?? 0
        count += 1
      }
      output[index] = count > 0 ? sum / count : 0
      position += ratio
    }

    const consumed = Math.floor(position)
    this.#tail = source.slice(consumed)
    this.#position = position - consumed
    return output
  }
}

/** Cuts a continuous stream into fixed-size frames, keeping the remainder. */
export class FrameAssembler {
  readonly #size: number
  #pending: Float32Array

  constructor(size: number) {
    if (!Number.isInteger(size) || size <= 0)
      throw new RangeError('Frame size must be a positive integer')
    this.#size = size
    this.#pending = new Float32Array(0)
  }

  get pendingSamples(): number {
    return this.#pending.length
  }

  reset(): void {
    this.#pending = new Float32Array(0)
  }

  push(samples: Float32Array): Float32Array[] {
    const buffer = concat(this.#pending, samples)
    const frames: Float32Array[] = []
    let offset = 0
    while (buffer.length - offset >= this.#size) {
      frames.push(buffer.slice(offset, offset + this.#size))
      offset += this.#size
    }
    this.#pending = buffer.slice(offset)
    return frames
  }
}

/**
 * A rolling window of the most recent audio, kept while the mic is warm.
 *
 * PLAN §5 wants ~300 ms of pre-buffer so that a user who starts talking as they
 * press the key does not lose the first syllable. It lives here rather than in
 * the main process because the capture renderer deliberately sends *nothing*
 * while merely warm: the pre-roll is flushed as ordinary frames the instant
 * capture starts, so main sees one uninterrupted utterance.
 */
export class PreRoll {
  readonly #capacity: number
  #frames: Float32Array[] = []
  #samples = 0

  constructor(capacity: number = PRE_ROLL_SAMPLES) {
    this.#capacity = Math.max(0, capacity)
  }

  get samples(): number {
    return this.#samples
  }

  push(frame: Float32Array): void {
    if (this.#capacity === 0 || frame.length === 0) return
    this.#frames.push(frame)
    this.#samples += frame.length
    while (this.#samples - (this.#frames[0]?.length ?? 0) >= this.#capacity) {
      const dropped = this.#frames.shift()
      if (!dropped) break
      this.#samples -= dropped.length
    }
  }

  /** Hand over everything held and start again empty. */
  drain(): Float32Array[] {
    const frames = this.#frames
    this.#frames = []
    this.#samples = 0
    return frames
  }

  clear(): void {
    this.#frames = []
    this.#samples = 0
  }
}

/** Root-mean-square amplitude of a block, in 0..1. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0
    sum += sample * sample
  }
  return Math.sqrt(sum / samples.length)
}

/** Largest absolute sample in a block, in 0..1. */
export function peak(samples: Float32Array): number {
  let highest = 0
  for (let index = 0; index < samples.length; index += 1) {
    const magnitude = Math.abs(samples[index] ?? 0)
    if (magnitude > highest) highest = magnitude
  }
  return Math.min(1, highest)
}

/** Quietest amplitude the meter shows at all, in dBFS. */
export const METER_FLOOR_DB = -62
/** Amplitude that pins the meter to full scale, in dBFS. */
export const METER_CEILING_DB = -8

/**
 * Map a raw amplitude to the 0..1 the Bar draws.
 *
 * Linear RMS is useless for this: conversational speech sits around 0.02–0.2,
 * so a linear bar spends its life in the bottom fifth of its range and looks
 * dead. Decibels match how the ear hears loudness, and the window below is the
 * usable span of a laptop microphone at arm's length.
 */
export function normaliseLevel(amplitude: number): number {
  if (!(amplitude > 0)) return 0
  const db = 20 * Math.log10(Math.min(1, amplitude))
  const scaled = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)
  return clamp01(scaled)
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/** Copy a Float32Array's bytes into a standalone `ArrayBuffer` for IPC. */
export function toTransferable(samples: Float32Array): ArrayBuffer {
  const copy = new Float32Array(samples.length)
  copy.set(samples)
  return copy.buffer
}

function concat(head: Float32Array, tail: Float32Array): Float32Array {
  if (head.length === 0) return tail
  if (tail.length === 0) return head
  const merged = new Float32Array(head.length + tail.length)
  merged.set(head, 0)
  merged.set(tail, head.length)
  return merged
}
