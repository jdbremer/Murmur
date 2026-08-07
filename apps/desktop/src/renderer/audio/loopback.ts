/**
 * Windows system-audio capture for meetings (PLAN §18.2).
 *
 * A second, independent graph beside {@link MicrophoneCapture}. Separate rather
 * than a mode on it because the two streams are genuinely unrelated: different
 * source, different lifetime, different consumer, and both can be live at once
 * during a call.
 *
 * `getDisplayMedia` is the only way Chromium exposes loopback audio, so the
 * request nominally asks for display media — but `security.ts` answers it with
 * `{ audio: 'loopback' }` and no video, so **no screen content is captured or
 * even enumerated**. If a video track ever appears here it is a bug in that
 * handler, so one is stopped immediately and loudly rather than quietly
 * ignored.
 */

const TARGET_SAMPLE_RATE = 16_000
const FRAME_SAMPLES = 1_600

export interface LoopbackCaptureOptions {
  onFrame: (pcm: ArrayBuffer, sampleCount: number) => void
  onError: (message: string) => void
}

export class LoopbackCapture {
  readonly #options: LoopbackCaptureOptions
  #context: AudioContext | null = null
  #stream: MediaStream | null = null
  #node: AudioWorkletNode | null = null
  #starting = false

  constructor(options: LoopbackCaptureOptions) {
    this.#options = options
  }

  get running(): boolean {
    return this.#stream !== null
  }

  async start(): Promise<void> {
    if (this.#stream || this.#starting) return
    this.#starting = true
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true, // Required by the API; the handler substitutes audio-only.
        audio: true,
      })

      // Defence in depth: if a video track arrives despite the handler, drop it
      // rather than hold a screen capture we never asked to keep.
      for (const track of stream.getVideoTracks()) {
        track.stop()
        stream.removeTrack(track)
      }
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop())
        throw new Error('The system audio stream carried no audio.')
      }

      const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE })
      await context.audioWorklet.addModule(new URL('./capture-processor.js', import.meta.url).href)

      const node = new AudioWorkletNode(context, 'murmur-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          targetSampleRate: TARGET_SAMPLE_RATE,
          frameSamples: FRAME_SAMPLES,
          contextSampleRate: context.sampleRate,
        },
      })

      node.port.onmessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; pcm?: ArrayBuffer; sampleCount?: number }
        if (data.type === 'frame' && data.pcm) {
          this.#options.onFrame(data.pcm, data.sampleCount ?? 0)
        }
      }

      context.createMediaStreamSource(stream).connect(node)
      // A muted sink so the graph is actually pulled — without a destination
      // the worklet never runs. Gain 0 so loopback audio is not re-played.
      const sink = context.createGain()
      sink.gain.value = 0
      node.connect(sink).connect(context.destination)

      // The user can revoke sharing from the OS; treat that as a stop.
      stream.getAudioTracks()[0]?.addEventListener('ended', () => this.stop())

      this.#stream = stream
      this.#context = context
      this.#node = node
    } catch (error) {
      this.#options.onError(error instanceof Error ? error.message : String(error))
      this.stop()
    } finally {
      this.#starting = false
    }
  }

  stop(): void {
    this.#node?.port.close()
    this.#node?.disconnect()
    this.#node = null
    this.#stream?.getTracks().forEach((track) => track.stop())
    this.#stream = null
    void this.#context?.close().catch(() => undefined)
    this.#context = null
  }
}
