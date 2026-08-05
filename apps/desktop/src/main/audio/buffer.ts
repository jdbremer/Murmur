import { AUDIO } from '../config'

/**
 * Accumulates the Float32 frames the capture renderer streams in (PLAN §5).
 *
 * Two responsibilities and nothing else:
 *
 *  - **Bounded growth.** A stuck hotkey must not grow the heap without limit,
 *    so the buffer stops accepting once {@link maxSamples} is reached and
 *    reports `capped`, which the orchestrator turns into an auto-finalise.
 *  - **One copy at the end.** Frames are kept as-is and concatenated once, in
 *    {@link drain}. Appending into a growing `Float32Array` would copy the
 *    whole utterance on every 100 ms frame.
 *
 * Audio never leaves this object except through `drain()`, and the orchestrator
 * drops the result as soon as STT returns — that is PLAN §10.4's "memory only"
 * in code.
 */
export class UtteranceBuffer {
  readonly #frames: Float32Array[] = []
  readonly maxSamples: number
  #sampleCount = 0
  #capped = false

  constructor(maxSamples: number = Math.ceil((AUDIO.maxUtteranceMs / 1000) * AUDIO.sampleRate)) {
    this.maxSamples = maxSamples
  }

  get sampleCount(): number {
    return this.#sampleCount
  }

  get durationMs(): number {
    return (this.#sampleCount * 1000) / AUDIO.sampleRate
  }

  /** True once the hard per-utterance cap was hit (PLAN §5). */
  get capped(): boolean {
    return this.#capped
  }

  /**
   * Append one frame.
   *
   * @returns `false` when the cap was already reached and the frame was
   *   dropped, so the caller can stop capture rather than keep pushing.
   */
  push(frame: Float32Array): boolean {
    if (this.#capped) return false

    const remaining = this.maxSamples - this.#sampleCount
    if (remaining <= 0) {
      this.#capped = true
      return false
    }

    if (frame.length > remaining) {
      this.#frames.push(frame.slice(0, remaining))
      this.#sampleCount += remaining
      this.#capped = true
      return false
    }

    this.#frames.push(frame)
    this.#sampleCount += frame.length
    return true
  }

  /** Concatenate everything into one buffer and empty this one. */
  drain(): Float32Array {
    const out = new Float32Array(this.#sampleCount)
    let offset = 0
    for (const frame of this.#frames) {
      out.set(frame, offset)
      offset += frame.length
    }
    this.clear()
    return out
  }

  clear(): void {
    this.#frames.length = 0
    this.#sampleCount = 0
    this.#capped = false
  }
}

/**
 * A fixed-length rolling pre-buffer (PLAN §5).
 *
 * The mic is kept warm between utterances, so by the time a hotkey-down
 * arrives the first ~300 ms of "silence" already contains the speaker drawing
 * breath and, often, the first phoneme. Keeping that window and prepending it
 * to the utterance is what stops "send it Tuesday" arriving as "end it
 * Tuesday".
 */
export class PreRollBuffer {
  readonly #frames: Float32Array[] = []
  readonly maxSamples: number
  #sampleCount = 0

  constructor(maxSamples: number = Math.ceil((AUDIO.preRollMs / 1000) * AUDIO.sampleRate)) {
    this.maxSamples = maxSamples
  }

  get sampleCount(): number {
    return this.#sampleCount
  }

  push(frame: Float32Array): void {
    if (this.maxSamples <= 0) return
    this.#frames.push(frame)
    this.#sampleCount += frame.length
    while (this.#sampleCount > this.maxSamples && this.#frames.length > 0) {
      const oldest = this.#frames[0]
      if (!oldest) break
      const excess = this.#sampleCount - this.maxSamples
      if (oldest.length <= excess) {
        this.#frames.shift()
        this.#sampleCount -= oldest.length
      } else {
        this.#frames[0] = oldest.subarray(excess)
        this.#sampleCount -= excess
      }
    }
  }

  /** Copy the retained window out; the buffer keeps rolling. */
  snapshot(): Float32Array {
    const out = new Float32Array(this.#sampleCount)
    let offset = 0
    for (const frame of this.#frames) {
      out.set(frame, offset)
      offset += frame.length
    }
    return out
  }

  clear(): void {
    this.#frames.length = 0
    this.#sampleCount = 0
  }
}

/** Reinterpret an IPC `ArrayBuffer` payload as Float32 samples. */
export function framePcm(buffer: ArrayBuffer, sampleCount: number): Float32Array {
  // Copy: the IPC buffer is transferred and its backing store is not ours to keep.
  return new Float32Array(buffer.slice(0, sampleCount * Float32Array.BYTES_PER_ELEMENT))
}
