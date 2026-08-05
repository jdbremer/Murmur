/**
 * Minimal RIFF/WAVE encoder.
 *
 * `whisper-server`'s `/inference` endpoint takes a multipart upload, and the
 * format it is guaranteed to read on every build is 16-bit PCM WAV. Encoding
 * one is ~30 lines, so we do it here rather than take a dependency that would
 * also have to be audited and signed.
 *
 * Pure and allocation-explicit, so it is unit-testable and so a five-minute
 * utterance produces exactly one buffer.
 */

export const WAV_HEADER_BYTES = 44

/**
 * Float32 (−1..1) → 16-bit little-endian PCM WAV.
 *
 * Samples outside −1..1 are clamped rather than wrapped: a clipped sample
 * sounds bad, a wrapped one sounds like a gunshot and derails the model.
 */
export function encodeWav(pcm: Float32Array, sampleRate: number): Buffer {
  const dataBytes = pcm.length * 2
  const buffer = Buffer.allocUnsafe(WAV_HEADER_BYTES + dataBytes)

  // RIFF chunk descriptor
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')

  // "fmt " sub-chunk — PCM, mono
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // sub-chunk size for PCM
  buffer.writeUInt16LE(1, 20) // audio format: 1 = PCM
  buffer.writeUInt16LE(1, 22) // channels: mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate = rate * channels * bytesPerSample
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample

  // "data" sub-chunk
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)

  let offset = WAV_HEADER_BYTES
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index] ?? 0))
    // Asymmetric scaling: −1 maps to −32768, +1 to +32767.
    buffer.writeInt16LE(sample < 0 ? sample * 0x8000 : sample * 0x7fff, offset)
    offset += 2
  }

  return buffer
}
