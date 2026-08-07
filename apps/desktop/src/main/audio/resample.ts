/**
 * Down-samples captured audio to the 16 kHz mono the engines expect.
 *
 * The microphone path never needs this — its AudioWorklet already runs at
 * 16 kHz. The system-audio tap does: CoreAudio hands over whatever the output
 * device is clocked at, measured at 48 kHz float32 on Apple silicon, and 48 →
 * 16 is a clean 3:1. Other devices are not so tidy (44.1 kHz gives 2.75625),
 * so this handles fractional ratios rather than assuming the common case.
 *
 * Box-averaging rather than dropping samples, matching
 * `renderer/audio/capture-processor.js`: taking every third sample aliases
 * anything above 8 kHz straight back down into the speech band, which is
 * audible to a transcription model even when it is inaudible to a person.
 *
 * Stateful because chunk boundaries do not land on output-sample boundaries —
 * a stateless call per chunk would drop a fraction of a sample every time and
 * drift the timeline over an hour-long meeting.
 */
export class Downsampler {
  readonly #ratio: number
  /** Fractional input position carried across chunks. */
  #cursor = 0

  constructor(inputRate: number, outputRate: number) {
    if (!(inputRate > 0) || !(outputRate > 0)) {
      throw new Error(`Invalid sample rates: ${inputRate} -> ${outputRate}`)
    }
    this.#ratio = inputRate / outputRate
  }

  /** True when input and output rates match and `process` is a passthrough. */
  get passthrough(): boolean {
    return this.#ratio === 1
  }

  process(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0)
    if (this.passthrough) return input

    const out: number[] = []
    let cursor = this.#cursor

    while (cursor + this.#ratio <= input.length) {
      const start = cursor
      const end = cursor + this.#ratio
      out.push(mean(input, start, end))
      cursor = end
    }

    // Carry the leftover tail into the next chunk rather than discarding it.
    this.#cursor = cursor - input.length
    if (this.#cursor > 0) this.#cursor = 0

    return Float32Array.from(out)
  }

  reset(): void {
    this.#cursor = 0
  }
}

/**
 * Mean over a fractional sample window `[start, end)`.
 *
 * Partial samples at each edge are weighted by how much of them the window
 * covers, which is what keeps a 2.75625 ratio from wobbling in amplitude.
 */
function mean(input: Float32Array, start: number, end: number): number {
  const first = Math.floor(start)
  const last = Math.min(input.length - 1, Math.ceil(end) - 1)

  let sum = 0
  let weight = 0
  for (let i = first; i <= last; i += 1) {
    const lo = Math.max(start, i)
    const hi = Math.min(end, i + 1)
    const w = hi - lo
    if (w <= 0) continue
    sum += (input[i] ?? 0) * w
    weight += w
  }
  return weight > 0 ? sum / weight : 0
}

/**
 * Interleaved multi-channel float32 to mono, averaging channels.
 *
 * The tap is configured as a mono mixdown so this is normally a no-op, but a
 * device that reports stereo must not be read as double-rate mono.
 */
export function toMono(input: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return input
  const frames = Math.floor(input.length / channels)
  const out = new Float32Array(frames)
  for (let f = 0; f < frames; f += 1) {
    let sum = 0
    for (let c = 0; c < channels; c += 1) sum += input[f * channels + c] ?? 0
    out[f] = sum / channels
  }
  return out
}
