import { beforeAll, describe, expect, it } from 'vitest'

import { describeMicError } from '../src/renderer/audio/mic-errors'

/**
 * The capture AudioWorklet (PLAN §5).
 *
 * The worklet is the one piece of the capture path with real algorithmic risk:
 * if it emits the wrong *rate*, nothing throws — Whisper simply transcribes
 * nonsense, and the bug looks like "the model is bad". So the tests here are
 * mostly about sample rates and frame boundaries.
 *
 * It is plain JS living in AudioWorkletGlobalScope, so the suite installs the
 * three globals that scope provides (`AudioWorkletProcessor`, `sampleRate`,
 * `registerProcessor`) and grabs the class as it registers itself.
 */

interface PortMessage {
  type: string
  pcm?: ArrayBuffer
  value?: boolean
}

interface FakePort {
  postMessage(message: PortMessage, transfer?: ArrayBuffer[]): void
  onmessage: ((event: { data: PortMessage }) => void) | null
  readonly sent: PortMessage[]
}

interface ProcessorLike {
  port: FakePort
  process(inputs: Float32Array[][]): boolean
}

type ProcessorConstructor = new (options: {
  processorOptions?: { targetSampleRate?: number; frameSamples?: number }
}) => ProcessorLike

const globals = globalThis as unknown as {
  AudioWorkletProcessor: unknown
  sampleRate: number
  registerProcessor: (name: string, ctor: ProcessorConstructor) => void
}

let CaptureProcessor: ProcessorConstructor
let registeredName = ''

function makePort(): FakePort {
  const sent: PortMessage[] = []
  return {
    sent,
    onmessage: null,
    postMessage(message) {
      sent.push(message)
    },
  }
}

beforeAll(async () => {
  globals.AudioWorkletProcessor = class {
    port: FakePort = makePort()
  }
  globals.sampleRate = 48_000
  globals.registerProcessor = (name, ctor) => {
    registeredName = name
    CaptureProcessor = ctor
  }
  await import('../src/renderer/audio/capture-processor.js')
})

/** Build a processor at a given context rate and put it in streaming mode. */
function createProcessor(
  contextRate: number,
  options: { frameSamples?: number; streaming?: boolean } = {},
): ProcessorLike {
  globals.sampleRate = contextRate
  const processor = new CaptureProcessor({
    processorOptions: { targetSampleRate: 16_000, frameSamples: options.frameSamples ?? 1_600 },
  })
  if (options.streaming !== false) {
    processor.port.onmessage?.({ data: { type: 'streaming', value: true } })
  }
  return processor
}

/** Feed `count` samples through in 128-frame render quanta, like Chromium does. */
function feed(processor: ProcessorLike, samples: Float32Array): void {
  for (let offset = 0; offset < samples.length; offset += 128) {
    const quantum = samples.subarray(offset, Math.min(offset + 128, samples.length))
    processor.process([[quantum as Float32Array]])
  }
}

function framesFrom(port: FakePort): Float32Array[] {
  return port.sent
    .filter((message) => message.type === 'frame' && message.pcm)
    .map((message) => new Float32Array(message.pcm as ArrayBuffer))
}

describe('capture worklet registration', () => {
  it('registers under the name the page constructs', () => {
    expect(registeredName).toBe('capture-processor')
  })
})

describe('resampling', () => {
  it('passes samples through untouched when the context is already 16 kHz', () => {
    const processor = createProcessor(16_000, { frameSamples: 128 })
    const input = new Float32Array(128)
    for (let i = 0; i < input.length; i += 1) input[i] = i / 128

    feed(processor, input)

    const [frame] = framesFrom(processor.port)
    expect(frame).toBeDefined()
    expect(Array.from(frame as Float32Array)).toEqual(Array.from(input))
  })

  it('decimates 48 kHz to 16 kHz at exactly a 3:1 ratio', () => {
    const processor = createProcessor(48_000, { frameSamples: 100 })
    // 300 input samples at 48 kHz == 100 output samples at 16 kHz.
    feed(processor, new Float32Array(300).fill(0.5))

    const frames = framesFrom(processor.port)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toHaveLength(100)
  })

  it('averages the input window rather than dropping samples', () => {
    const processor = createProcessor(48_000, { frameSamples: 1 })
    // One output sample from three inputs: the box filter must return the mean,
    // not the first sample. Dropping instead of averaging is what aliases.
    const input = new Float32Array([0, 0.3, 0.9])
    feed(processor, input)

    const [frame] = framesFrom(processor.port)
    expect(frame?.[0]).toBeCloseTo(0.4, 5)
  })

  it('handles a non-integer ratio without accumulating drift', () => {
    // 44.1 kHz is the classic awkward case: 2.75625 input samples per output.
    // `frameSamples: 1` makes every output sample its own message, so the
    // message count *is* the output sample count.
    const outputsFor = (seconds: number): number => {
      const processor = createProcessor(44_100, { frameSamples: 1 })
      feed(processor, new Float32Array(44_100 * seconds).fill(0.25))
      return framesFrom(processor.port).length
    }

    // The phase accumulator needs `ratio` input samples before it can emit the
    // first output, so the count runs one sample short. That offset is constant,
    // not cumulative — which is the property that matters: a drifting resampler
    // desynchronises progressively, and a one-sample offset never does.
    expect(outputsFor(1)).toBe(16_000 - 1)
    expect(outputsFor(4)).toBe(64_000 - 1)
  })

  it('downmixes multi-channel input to mono', () => {
    const processor = createProcessor(16_000, { frameSamples: 2 })
    const left = new Float32Array([1, 1])
    const right = new Float32Array([0, 0])

    processor.process([[left, right]])

    const [frame] = framesFrom(processor.port)
    expect(Array.from(frame as Float32Array)).toEqual([0.5, 0.5])
  })
})

describe('framing', () => {
  it('emits fixed-size frames and holds back the partial remainder', () => {
    const processor = createProcessor(16_000, { frameSamples: 1_600 })
    // 1.5 frames' worth: one frame out, 800 samples still buffered.
    feed(processor, new Float32Array(2_400).fill(0.1))

    const frames = framesFrom(processor.port)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toHaveLength(1_600)
  })

  it('transfers each frame rather than reusing one buffer', () => {
    const processor = createProcessor(16_000, { frameSamples: 128 })
    feed(processor, new Float32Array(512).fill(0.2))

    const frames = framesFrom(processor.port)
    expect(frames).toHaveLength(4)
    // A reused buffer would have been detached by the first transfer and every
    // later frame would read back as zero-length.
    for (const frame of frames) expect(frame).toHaveLength(128)
  })
})

describe('streaming gate', () => {
  it('emits nothing until the page enables streaming', () => {
    const processor = createProcessor(16_000, { frameSamples: 128, streaming: false })
    feed(processor, new Float32Array(512).fill(0.4))

    expect(framesFrom(processor.port)).toHaveLength(0)
  })

  it('drops the partial frame when streaming stops, so a resume cannot splice', () => {
    const processor = createProcessor(16_000, { frameSamples: 128 })
    // Half a frame in, then stop and restart.
    feed(processor, new Float32Array(64).fill(1))
    processor.port.onmessage?.({ data: { type: 'streaming', value: false } })
    processor.port.onmessage?.({ data: { type: 'streaming', value: true } })
    feed(processor, new Float32Array(128).fill(0.5))

    const [frame] = framesFrom(processor.port)
    expect(frame).toHaveLength(128)
    // Every sample is from after the resume; none of the stale 1.0s survived.
    expect(Array.from(frame as Float32Array)).toEqual(Array.from(new Float32Array(128).fill(0.5)))
  })

  it('stops being scheduled once the page tears the graph down', () => {
    const processor = createProcessor(16_000)
    processor.port.onmessage?.({ data: { type: 'stop' } })

    // `false` tells Chromium it may collect the node.
    expect(processor.process([[new Float32Array(128)]])).toBe(false)
  })

  it('keeps running while input is momentarily absent', () => {
    const processor = createProcessor(16_000)
    expect(processor.process([])).toBe(true)
    expect(processor.process([[]])).toBe(true)
  })
})

describe('describeMicError', () => {
  it('names the System Settings pane for a denied permission', () => {
    const error = new Error('denied')
    error.name = 'NotAllowedError'
    expect(describeMicError(error)).toContain('Privacy & Security')
  })

  it('explains a busy device rather than echoing the DOM name', () => {
    const error = new Error('busy')
    error.name = 'NotReadableError'
    expect(describeMicError(error)).toBe('The microphone is in use by another app.')
  })

  it('points at Settings when the chosen device vanished', () => {
    const error = new Error('gone')
    error.name = 'OverconstrainedError'
    expect(describeMicError(error)).toContain('Pick another in Settings')
  })

  it('falls back to the underlying message, then to a generic line', () => {
    expect(describeMicError(new Error('kaboom'))).toBe('Could not open the microphone: kaboom')
    expect(describeMicError('not an error')).toBe('Could not open the microphone.')
  })
})
