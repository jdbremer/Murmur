import type { AudioCaptureStatus, AudioCommand } from '@murmur/shared'

import processorUrl from './capture-processor.js?url'
import { describeMicError } from './mic-errors'

/**
 * The microphone, as a small state machine (PLAN §3.1, §5).
 *
 * Framework-free on purpose: React owns none of this state, because none of it
 * survives a re-render meaningfully — the graph is a singleton tied to the
 * page's lifetime, and the only thing the component does is forward commands.
 *
 * Four commands, and the distinction between the first two is *entirely* a
 * main-process concern:
 *
 *  - `warm`    — open the stream and stream frames. Main routes them into its
 *                rolling 300 ms pre-roll ring and throws the rest away.
 *  - `start`   — open if needed and stream frames. Main accumulates them.
 *  - `stop`    — stop emitting; the stream, the context and the worklet all
 *                stay alive so the next `start` costs nothing.
 *  - `release` — tear the graph down and drop the mic.
 *
 * `warm` therefore *does* stream: the pre-roll ring can only be full at
 * hotkey-down if frames were already arriving before it. A `warm` that dropped
 * frames would leave `PreRollBuffer` permanently empty and quietly clip the
 * first syllable of every utterance — the exact bug pre-roll exists to prevent.
 *
 * Every command is funnelled through a promise chain so an overlapping
 * `release` → `warm` (which is what a mic-device change sends) cannot interleave
 * a teardown with a half-finished `getUserMedia`.
 */

/** 100 ms at 16 kHz — matches `AUDIO.frameMs` in the main process. */
const TARGET_SAMPLE_RATE = 16_000
const FRAME_SAMPLES = 1_600

export interface CaptureCallbacks {
  /** One 16 kHz mono Float32 frame, as a transferable `ArrayBuffer`. */
  onFrame(pcm: ArrayBuffer, sampleCount: number): void
  onStatus(status: AudioCaptureStatus): void
}

export class MicrophoneCapture {
  readonly #callbacks: CaptureCallbacks

  #context: AudioContext | null = null
  #stream: MediaStream | null = null
  #source: MediaStreamAudioSourceNode | null = null
  #worklet: AudioWorkletNode | null = null
  #sink: GainNode | null = null

  /** Device the *open* graph is using, so a change can be detected. */
  #openDeviceId: string | null = null
  #streaming = false
  #disposed = false

  /** Serialises commands; see the class comment. */
  #queue: Promise<void> = Promise.resolve()

  constructor(callbacks: CaptureCallbacks) {
    this.#callbacks = callbacks
  }

  /** Queue one command from main. Never rejects — failures become a status. */
  apply(command: AudioCommand): Promise<void> {
    this.#queue = this.#queue.then(() => this.#run(command)).catch(() => undefined)
    return this.#queue
  }

  dispose(): void {
    this.#disposed = true
    this.#teardown()
  }

  async #run(command: AudioCommand): Promise<void> {
    if (this.#disposed) return

    switch (command.action) {
      case 'warm':
      case 'start':
        await this.#open(command.deviceId)
        this.#setStreaming(true)
        return
      case 'stop':
        this.#setStreaming(false)
        return
      case 'release':
        this.#teardown()
        this.#callbacks.onStatus({ status: 'idle' })
        return
    }
  }

  async #open(deviceId: string | null): Promise<void> {
    // A different device than the one already running means a real reopen —
    // there is no way to retarget a live MediaStream.
    if (this.#context && this.#openDeviceId !== deviceId) this.#teardown()
    if (this.#context) {
      // Chromium suspends the context when every window is hidden; the capture
      // window always is, so this is the normal path rather than an edge case.
      if (this.#context.state === 'suspended') await this.#context.resume()
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: 1,
          // Murmur wants the processed signal: these are the same filters a
          // video call uses, and speech models are trained on that kind of
          // audio far more than on a raw capsule feed.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })

      // A second command may have torn us down while getUserMedia was in
      // flight. Dropping the stream here is what stops an orphaned mic (and a
      // lit recording indicator) outliving a `release`.
      if (this.#disposed) {
        stopTracks(stream)
        return
      }

      const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      await context.audioWorklet.addModule(processorUrl)

      if (this.#disposed) {
        stopTracks(stream)
        void context.close()
        return
      }

      const source = context.createMediaStreamSource(stream)
      const worklet = new AudioWorkletNode(context, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: {
          targetSampleRate: TARGET_SAMPLE_RATE,
          frameSamples: FRAME_SAMPLES,
        },
      })

      worklet.port.onmessage = (event: MessageEvent) => {
        const message = event.data as { type?: string; pcm?: ArrayBuffer } | null
        if (message?.type !== 'frame' || !message.pcm) return
        this.#callbacks.onFrame(message.pcm, message.pcm.byteLength / 4)
      }

      // A worklet is only pulled if it reaches the destination, so the graph
      // ends in a muted gain node rather than nowhere. Silent, but scheduled.
      const sink = context.createGain()
      sink.gain.value = 0

      source.connect(worklet)
      worklet.connect(sink)
      sink.connect(context.destination)

      // Losing the device (unplugged headset, revoked permission) ends the
      // track. Without this the graph stays up and silently produces zeroes.
      const [track] = stream.getAudioTracks()
      track?.addEventListener('ended', () => {
        this.#teardown()
        this.#callbacks.onStatus({
          status: 'error',
          message: 'The microphone was disconnected.',
        })
      })

      this.#stream = stream
      this.#context = context
      this.#source = source
      this.#worklet = worklet
      this.#sink = sink
      this.#openDeviceId = deviceId
      this.#streaming = false

      if (context.state === 'suspended') await context.resume()

      this.#callbacks.onStatus({
        status: 'ready',
        deviceId: track?.getSettings().deviceId ?? deviceId,
        sampleRate: context.sampleRate,
      })
    } catch (error) {
      this.#teardown()
      this.#callbacks.onStatus({ status: 'error', message: describeMicError(error) })
      throw error
    }
  }

  #setStreaming(streaming: boolean): void {
    if (this.#streaming === streaming) return
    this.#streaming = streaming
    this.#worklet?.port.postMessage({ type: 'streaming', value: streaming })
  }

  #teardown(): void {
    this.#worklet?.port.postMessage({ type: 'stop' })
    if (this.#worklet) this.#worklet.port.onmessage = null

    try {
      this.#source?.disconnect()
      this.#worklet?.disconnect()
      this.#sink?.disconnect()
    } catch {
      // Disconnecting an already-torn-down graph is not worth reporting.
    }

    if (this.#stream) stopTracks(this.#stream)
    if (this.#context) void this.#context.close().catch(() => undefined)

    this.#stream = null
    this.#context = null
    this.#source = null
    this.#worklet = null
    this.#sink = null
    this.#openDeviceId = null
    this.#streaming = false
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}
