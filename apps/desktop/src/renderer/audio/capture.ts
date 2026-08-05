import type { AudioCommand, AudioDevice } from '@murmur/shared'

import { classifyCaptureError, type CaptureError } from './errors'
import {
  FrameAssembler,
  FRAME_SAMPLES,
  METER_SAMPLES,
  normaliseLevel,
  peak,
  PreRoll,
  Resampler,
  rms,
  TARGET_SAMPLE_RATE,
  toTransferable,
} from './pipeline'

/**
 * The microphone, and the audio graph attached to it (PLAN §3.1, §5).
 *
 * Owns exactly one `MediaStream` and one `AudioContext` at a time, and obeys the
 * four commands main sends on `audio.command`:
 *
 *  - `warm`    — open the device and keep it open, sending nothing. The last
 *                ~300 ms are kept in a ring so that `start` can flush them.
 *  - `start`   — flush the pre-roll, then stream ~100 ms frames to main.
 *  - `stop`    — stop streaming; the device stays open (main's warm window).
 *  - `release` — close everything and let the recording indicator go out.
 *
 * A note on downsampling: the context is *requested* at 16 kHz so Chromium's own
 * resampler does the work. When a device refuses that (some aggregate and
 * Bluetooth inputs), the context comes back at its native rate and
 * {@link Resampler} takes over. Either way main only ever sees 16 kHz mono.
 */

export interface CaptureCallbacks {
  onFrame(frame: { pcm: ArrayBuffer; sampleCount: number; ts: number }): void
  onLevel(level: { level: number; peak: number | null }): void
  onReady(info: { deviceId: string | null; sampleRate: number }): void
  onIdle(): void
  onError(error: CaptureError): void
  onDevices(devices: AudioDevice[]): void
}

type Mode = 'closed' | 'warm' | 'capturing'

const WORKLET_NAME = 'murmur-capture'
/** ~32 ms of 48 kHz audio per message from the audio thread. */
const WORKLET_CHUNK_SAMPLES = 1536

export class MicrophoneCapture {
  readonly #callbacks: CaptureCallbacks
  readonly #workletUrl: string

  #mode: Mode = 'closed'
  #deviceId: string | null = null
  #stream: MediaStream | null = null
  #context: AudioContext | null = null
  #source: MediaStreamAudioSourceNode | null = null
  #node: AudioWorkletNode | null = null
  #sink: GainNode | null = null

  #resampler = new Resampler(TARGET_SAMPLE_RATE)
  #frames = new FrameAssembler(FRAME_SAMPLES)
  #preRoll = new PreRoll()
  #preRollFrames = new FrameAssembler(FRAME_SAMPLES)
  #meter = new FrameAssembler(METER_SAMPLES)
  /** Serialises overlapping commands — `release` while `start` is still opening. */
  #queue: Promise<void> = Promise.resolve()

  constructor(options: { callbacks: CaptureCallbacks; workletUrl: string }) {
    this.#callbacks = options.callbacks
    this.#workletUrl = options.workletUrl
  }

  get mode(): Mode {
    return this.#mode
  }

  /** Run a command from main, after every command already in flight. */
  apply(command: AudioCommand): Promise<void> {
    this.#queue = this.#queue.then(() => this.#apply(command)).catch(() => undefined)
    return this.#queue
  }

  async #apply(command: AudioCommand): Promise<void> {
    switch (command.action) {
      case 'warm':
        await this.#open(command.deviceId, 'warm')
        return
      case 'start':
        await this.#open(command.deviceId, 'capturing')
        return
      case 'stop':
        if (this.#mode === 'capturing') this.#mode = 'warm'
        this.#frames.reset()
        return
      case 'release':
        this.#close()
        return
    }
  }

  /** Re-read the device list; safe to call before permission is granted. */
  async refreshDevices(): Promise<AudioDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const inputs = all.filter((device) => device.kind === 'audioinput')
      const devices = inputs.map((device, index) => ({
        deviceId: device.deviceId || `input-${index}`,
        // Labels stay empty until the microphone has been granted once; the
        // pickers substitute a position-based name rather than showing a UUID.
        label: device.label,
        isDefault: device.deviceId === 'default' || (index === 0 && device.deviceId === ''),
      }))
      this.#callbacks.onDevices(devices)
      return devices
    } catch {
      // Enumeration is best-effort: a failure here must not break capture.
      return []
    }
  }

  dispose(): void {
    this.#close()
  }

  // -- device + graph ------------------------------------------------------

  async #open(deviceId: string | null, mode: Exclude<Mode, 'closed'>): Promise<void> {
    const alreadyOpen = this.#stream !== null && this.#context !== null
    if (alreadyOpen && deviceId === this.#deviceId) {
      this.#enter(mode)
      return
    }
    if (alreadyOpen) this.#close()

    let stream: MediaStream
    try {
      stream = await this.#requestStream(deviceId)
    } catch (cause) {
      this.#close()
      this.#callbacks.onError(classifyCaptureError(cause))
      return
    }

    try {
      await this.#buildGraph(stream)
    } catch (cause) {
      stopStream(stream)
      this.#close()
      this.#callbacks.onError(classifyCaptureError(cause))
      return
    }

    this.#stream = stream
    this.#deviceId = deviceId
    this.#enter(mode)
    this.#callbacks.onReady({
      deviceId,
      sampleRate: this.#context?.sampleRate ?? TARGET_SAMPLE_RATE,
    })

    // A device can disappear mid-utterance (AirPods walking out of range).
    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        if (this.#stream !== stream) return
        this.#close()
        this.#callbacks.onError({
          code: 'no-device',
          message: 'The microphone disconnected. Reconnect it or pick another in Settings.',
        })
      })
    }
  }

  async #requestStream(deviceId: string | null): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new TypeError('getUserMedia is not available')
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: constraints(deviceId) })
    } catch (cause) {
      // A pinned device that has gone away must not brick dictation: fall back
      // to the system default and let the picker show the truth afterwards.
      if (deviceId !== null && isOverconstrained(cause)) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints(null) })
        void this.refreshDevices()
        return stream
      }
      throw cause
    }
  }

  async #buildGraph(stream: MediaStream): Promise<void> {
    const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE, latencyHint: 'interactive' })
    this.#context = context
    await context.audioWorklet.addModule(this.#workletUrl)
    if (context.state === 'suspended') await context.resume()

    this.#resampler = new Resampler(context.sampleRate)
    this.#frames.reset()
    this.#meter.reset()
    this.#preRoll.clear()
    this.#preRollFrames.reset()

    const node = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { chunkSamples: WORKLET_CHUNK_SAMPLES },
    })
    node.port.onmessage = (event: MessageEvent) => this.#onWorkletMessage(event)

    const source = context.createMediaStreamSource(stream)
    // The worklet writes no output, but a node with nowhere to go can be culled
    // from the graph; a muted sink keeps it scheduled without making a sound.
    const sink = context.createGain()
    sink.gain.value = 0
    source.connect(node)
    node.connect(sink)
    sink.connect(context.destination)

    this.#source = source
    this.#node = node
    this.#sink = sink
  }

  #enter(mode: Exclude<Mode, 'closed'>): void {
    if (mode === 'capturing' && this.#mode !== 'capturing') {
      // Flush the pre-roll first so the utterance main receives starts slightly
      // *before* the key went down (PLAN §5).
      const now = Date.now()
      const held = this.#preRoll.drain()
      let offset = 0
      for (const frame of held) offset += frame.length
      for (const frame of held) {
        const ageMs = (offset / TARGET_SAMPLE_RATE) * 1000
        offset -= frame.length
        this.#emitFrame(frame, now - ageMs)
      }
    }
    if (mode === 'warm') this.#frames.reset()
    this.#mode = mode
  }

  #onWorkletMessage(event: MessageEvent): void {
    const data = event.data as { type?: string; pcm?: ArrayBuffer }
    if (data?.type !== 'audio' || !data.pcm) return
    if (this.#mode === 'closed') return

    const samples = this.#resampler.push(new Float32Array(data.pcm))
    if (samples.length === 0) return

    for (const block of this.#meter.push(samples)) {
      this.#callbacks.onLevel({
        level: normaliseLevel(rms(block)),
        peak: normaliseLevel(peak(block)),
      })
    }

    if (this.#mode === 'capturing') {
      const at = Date.now()
      for (const frame of this.#frames.push(samples)) this.#emitFrame(frame, at)
      return
    }

    // Warm: nothing goes to main, but the ring stays fresh.
    for (const frame of this.#preRollFrames.push(samples)) this.#preRoll.push(frame)
  }

  #emitFrame(frame: Float32Array, ts: number): void {
    this.#callbacks.onFrame({
      pcm: toTransferable(frame),
      sampleCount: frame.length,
      ts: Math.round(ts),
    })
  }

  #close(): void {
    const wasOpen = this.#mode !== 'closed'
    this.#mode = 'closed'

    if (this.#node) {
      try {
        this.#node.port.postMessage('close')
      } catch {
        /* the port may already be gone */
      }
      this.#node.port.onmessage = null
      this.#node.disconnect()
    }
    this.#source?.disconnect()
    this.#sink?.disconnect()
    if (this.#stream) stopStream(this.#stream)
    void this.#context?.close().catch(() => undefined)

    this.#node = null
    this.#source = null
    this.#sink = null
    this.#stream = null
    this.#context = null
    this.#deviceId = null
    this.#frames.reset()
    this.#meter.reset()
    this.#preRoll.clear()
    this.#preRollFrames.reset()
    this.#resampler.reset()

    if (wasOpen) this.#callbacks.onIdle()
  }
}

/**
 * PLAN §5: lean on macOS's voice-processing input rather than shipping our own
 * echo canceller. Automatic gain keeps a quiet speaker usable; noise
 * suppression is deliberately left off, because its artefacts cost more STT
 * accuracy than the noise it removes.
 */
function constraints(deviceId: string | null): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    channelCount: 1,
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: false,
  }
}

function isOverconstrained(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'name' in cause &&
    (cause as { name: unknown }).name === 'OverconstrainedError'
  )
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}
