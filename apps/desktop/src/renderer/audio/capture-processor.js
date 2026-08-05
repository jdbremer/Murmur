/**
 * The capture AudioWorklet (PLAN §5).
 *
 * Runs on the audio render thread, so it must never allocate in `process()` and
 * never block. Its whole job is: downmix to mono, resample to 16 kHz, and post
 * fixed-size frames back to the page.
 *
 * Why the resampler exists at all: the page asks for an `AudioContext` at
 * 16 kHz and Chromium almost always honours it, in which case `ratio === 1` and
 * every sample passes straight through. But a device that refuses the rate
 * would otherwise silently feed 48 kHz audio to a model expecting 16 kHz —
 * which does not error, it just transcribes gibberish. The box-average
 * decimator below is the safety net: averaging the input window that maps to
 * each output sample is a crude low-pass, but it is a real one, and it beats
 * dropping samples (which aliases high frequencies straight down into the
 * speech band).
 *
 * This file is plain JS on purpose — it is emitted as a standalone asset and
 * loaded by URL via `audioWorklet.addModule`, so it is never part of the page
 * bundle and cannot import from it.
 */

const DEFAULT_TARGET_RATE = 16000
const DEFAULT_FRAME_SAMPLES = 1600 // 100 ms at 16 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()

    const processorOptions = (options && options.processorOptions) || {}
    const targetSampleRate = processorOptions.targetSampleRate || DEFAULT_TARGET_RATE
    const frameSamples = processorOptions.frameSamples || DEFAULT_FRAME_SAMPLES

    // `sampleRate` is a global in AudioWorkletGlobalScope: the context's rate.
    this.ratio = sampleRate / targetSampleRate
    this.frameSamples = frameSamples

    this.frame = new Float32Array(frameSamples)
    this.filled = 0

    // Box-filter accumulator for the resampler.
    this.sum = 0
    this.count = 0
    this.phase = 0

    // Frames are only posted while the page says so. `warm` and `start` both
    // stream — main keeps a rolling 300 ms pre-roll ring from the warm frames
    // so the first syllable of an utterance survives (PLAN §5).
    this.streaming = false
    this.stopped = false

    this.port.onmessage = (event) => {
      const message = event.data
      if (!message) return
      if (message.type === 'streaming') {
        this.streaming = message.value === true
        // Drop whatever was half-collected so a resumed stream does not splice
        // a stale fragment onto the front of the new utterance.
        if (!this.streaming) this.#resetFrame()
      } else if (message.type === 'stop') {
        this.stopped = true
      }
    }
  }

  process(inputs) {
    if (this.stopped) return false

    const input = inputs[0]
    if (!input || input.length === 0) return true

    const channelCount = input.length
    const first = input[0]
    if (!first) return true

    for (let i = 0; i < first.length; i += 1) {
      // Downmix: getUserMedia is asked for mono, but a device that ignores the
      // constraint must not have one arbitrary channel picked for it.
      let sample = 0
      for (let c = 0; c < channelCount; c += 1) {
        const channel = input[c]
        sample += channel ? channel[i] : 0
      }
      sample /= channelCount

      this.sum += sample
      this.count += 1
      this.phase += 1

      if (this.phase >= this.ratio) {
        this.phase -= this.ratio
        const value = this.count > 0 ? this.sum / this.count : 0
        this.sum = 0
        this.count = 0
        this.#emit(value)
      }
    }

    return true
  }

  #emit(value) {
    if (!this.streaming) return

    this.frame[this.filled] = value
    this.filled += 1

    if (this.filled >= this.frameSamples) {
      // Transfer rather than copy: the page immediately hands this to IPC and
      // never touches it again, so there is no reason to keep our copy alive.
      const out = this.frame
      this.port.postMessage({ type: 'frame', pcm: out.buffer }, [out.buffer])
      // `out.buffer` is detached by the transfer, so a fresh frame is required.
      this.frame = new Float32Array(this.frameSamples)
      this.filled = 0
    }
  }

  #resetFrame() {
    this.filled = 0
    this.sum = 0
    this.count = 0
    this.phase = 0
  }
}

registerProcessor('capture-processor', CaptureProcessor)
