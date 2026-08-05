/**
 * Murmur's capture worklet (PLAN §3.1, §5).
 *
 * Deliberately the smallest thing that can work: it downmixes to mono and hands
 * the audio thread's 128-sample blocks over to the renderer in ~32 ms chunks.
 * Resampling, framing, metering and the pre-roll all live in
 * `pipeline.ts`, where they are unit-tested — nothing that can be arithmetically
 * wrong belongs in a file that cannot be tested without an audio device.
 *
 * Plain JavaScript on purpose. `AudioWorkletGlobalScope` has no module graph to
 * bundle into, so the file is shipped as an asset and registered by URL; a
 * TypeScript source here would need its own build target for no gain.
 *
 * The buffer is transferred, not copied, so the audio thread never allocates on
 * behalf of the renderer twice.
 */

/* global sampleRate, currentTime, AudioWorkletProcessor, registerProcessor */

const DEFAULT_CHUNK_SAMPLES = 1536

class MurmurCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const chunk = options?.processorOptions?.chunkSamples
    this.chunkSamples = Number.isInteger(chunk) && chunk > 0 ? chunk : DEFAULT_CHUNK_SAMPLES
    this.buffer = new Float32Array(this.chunkSamples)
    this.filled = 0
    this.closed = false
    this.port.onmessage = (event) => {
      if (event.data === 'close') this.closed = true
    }
    // Announce the rate the audio thread actually gave us; the renderer decides
    // from this whether it has to resample (see `Resampler.passthrough`).
    this.port.postMessage({ type: 'ready', sampleRate })
  }

  process(inputs) {
    if (this.closed) return false

    const input = inputs[0]
    if (!input || input.length === 0) return true
    const first = input[0]
    if (!first || first.length === 0) return true

    for (let index = 0; index < first.length; index += 1) {
      let sample = 0
      for (let channel = 0; channel < input.length; channel += 1) {
        sample += input[channel][index]
      }
      this.buffer[this.filled] = sample / input.length
      this.filled += 1

      if (this.filled === this.chunkSamples) {
        const payload = this.buffer.buffer
        this.port.postMessage({ type: 'audio', pcm: payload, sampleRate, at: currentTime }, [
          payload,
        ])
        this.buffer = new Float32Array(this.chunkSamples)
        this.filled = 0
      }
    }

    return true
  }
}

registerProcessor('murmur-capture', MurmurCaptureProcessor)
