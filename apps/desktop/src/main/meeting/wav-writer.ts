import { closeSync, openSync, writeSync } from 'node:fs'

/**
 * Streams PCM to a `.wav` while a meeting is being recorded (PLAN §18.2).
 *
 * The existing `engines/stt/wav.ts` encodes a whole buffer at once, which is
 * right for a five-second utterance and impossible for a three-hour meeting —
 * it would mean holding every sample in memory to write the file at the end.
 *
 * So this writes a placeholder RIFF header up front, appends frames as they
 * arrive, and seeks back to patch the two length fields on close. The cost is
 * that a file abandoned mid-write (a crash, a pulled power cable) has a header
 * claiming zero length. That is deliberate: every player and every decoder
 * handles a truncated WAV by reading to EOF, so the audio is still recoverable,
 * whereas buffering for correctness would mean losing all of it.
 *
 * 16-bit signed PCM rather than the float32 we carry internally: it halves the
 * file and is what every tool expects from a recording.
 */

const HEADER_BYTES = 44

export class WavStreamWriter {
  readonly #fd: number
  readonly #path: string
  readonly #sampleRate: number
  #dataBytes = 0
  #closed = false

  constructor(path: string, sampleRate: number) {
    this.#path = path
    this.#sampleRate = sampleRate
    // `wx` so a transcript's audio can never silently overwrite another's.
    this.#fd = openSync(path, 'wx')
    writeSync(this.#fd, this.#header(0), 0, HEADER_BYTES, 0)
  }

  get path(): string {
    return this.#path
  }

  get bytesWritten(): number {
    return this.#dataBytes
  }

  append(pcm: Float32Array): void {
    if (this.#closed || pcm.length === 0) return
    const bytes = Buffer.allocUnsafe(pcm.length * 2)
    for (let i = 0; i < pcm.length; i += 1) {
      // Clamp before scaling: a sample above 1.0 would otherwise wrap to a
      // loud click rather than clipping.
      const clamped = Math.max(-1, Math.min(1, pcm[i] ?? 0))
      bytes.writeInt16LE(Math.round(clamped * 32767), i * 2)
    }
    writeSync(this.#fd, bytes, 0, bytes.length, HEADER_BYTES + this.#dataBytes)
    this.#dataBytes += bytes.length
  }

  /** Patch the header with the real lengths and close. Safe to call twice. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      writeSync(this.#fd, this.#header(this.#dataBytes), 0, HEADER_BYTES, 0)
    } finally {
      closeSync(this.#fd)
    }
  }

  #header(dataBytes: number): Buffer {
    const header = Buffer.alloc(HEADER_BYTES)
    const byteRate = this.#sampleRate * 2
    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(36 + dataBytes, 4)
    header.write('WAVE', 8, 'ascii')
    header.write('fmt ', 12, 'ascii')
    header.writeUInt32LE(16, 16) // PCM chunk size
    header.writeUInt16LE(1, 20) // format: PCM
    header.writeUInt16LE(1, 22) // mono
    header.writeUInt32LE(this.#sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(2, 32) // block align
    header.writeUInt16LE(16, 34) // bits per sample
    header.write('data', 36, 'ascii')
    header.writeUInt32LE(dataBytes, 40)
    return header
  }
}
