import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Transcript, TranscriptionEvent } from '@murmur/shared'
import { createDefaultSettings } from '@murmur/shared'

import { TRANSCRIBE } from '../src/main/config'
import { TranscribeQueue } from '../src/main/engines/stt-queue'
import type { SttEngine } from '../src/main/engines/types'
import { createNullLogger } from '../src/main/logging'
import { FileTranscriber } from '../src/main/transcription/file-transcriber'
import { concat, roomTone, speechLike } from './helpers/pcm'

/**
 * The whole import pipeline with a fake engine: PCM in, ordered segments out,
 * and — the part most worth testing — the failure and back-pressure behaviour
 * that keeps a two-hour file from taking main down with it.
 */

interface EngineControls {
  engine: SttEngine
  calls: Float32Array[]
  /** Resolve the oldest outstanding transcription. */
  release: (text?: string) => void
}

/** An engine whose completions the test hands out one by one. */
function blockingEngine(): EngineControls {
  const calls: Float32Array[] = []
  const pending: ((transcript: Transcript) => void)[] = []
  return {
    calls,
    release: (text = 'released') => {
      const next = pending.shift()
      if (next) next({ text, avgLogProb: null, durationMs: 1 })
    },
    engine: stubEngine((pcm) => {
      calls.push(pcm)
      return new Promise((resolve) => pending.push(resolve))
    }),
  }
}

/** An engine that answers immediately from a script. */
function scriptedEngine(script: (call: number) => Promise<Transcript>): SttEngine {
  let call = 0
  return stubEngine(() => script(call++))
}

function stubEngine(transcribe: (pcm: Float32Array) => Promise<Transcript>): SttEngine {
  return {
    id: 'whisper-cpp',
    load: async () => {},
    transcribe: async (pcm) => transcribe(pcm),
    unload: async () => {},
    status: () =>
      ({
        engine: null,
        state: 'ready',
        modelId: null,
        reason: null,
        detail: '',
        warnings: [],
      }) as never,
    onStatusChange: () => () => {},
    dispose: async () => {},
  }
}

function makeTranscriber(engine: SttEngine | null): {
  transcriber: FileTranscriber
  events: TranscriptionEvent[]
} {
  const transcriber = new FileTranscriber({
    queue: new TranscribeQueue({ isBusy: () => false }),
    stt: () => engine,
    settings: () => createDefaultSettings(),
    dictionary: () => [],
    log: createNullLogger(),
  })
  const events: TranscriptionEvent[] = []
  transcriber.on('changed', (event) => events.push(event))
  return { transcriber, events }
}

/** Speech long enough to segment, with silence to cut on. */
function twoUtterances(): Float32Array {
  return concat(
    speechLike(2_500),
    roomTone(TRANSCRIBE.segmentSilenceMs + 600),
    speechLike(2_000, 0.25, 11),
    roomTone(400),
  )
}

const disposers: FileTranscriber[] = []
afterEach(async () => {
  for (const transcriber of disposers.splice(0, disposers.length)) await transcriber.dispose()
  vi.useRealTimers()
})

function track(transcriber: FileTranscriber): FileTranscriber {
  disposers.push(transcriber)
  return transcriber
}

describe('FileTranscriber', () => {
  it('turns pushed audio into ordered, timestamped segments', async () => {
    let call = 0
    const { transcriber, events } = makeTranscriber(
      scriptedEngine(async () => ({ text: `segment ${++call}`, avgLogProb: null, durationMs: 1 })),
    )
    track(transcriber)

    const pcm = twoUtterances()
    const totalMs = (pcm.length / 16_000) * 1000
    const job = transcriber.begin('interview.mp3', totalMs)
    await transcriber.push(job.id, pcm, true)

    await vi.waitFor(() => {
      expect(transcriber.list().find((j) => j.id === job.id)?.state).toBe('done')
    })

    const result = transcriber.result(job.id)
    expect(result).not.toBeNull()
    expect(result?.segments.map((s) => s.text)).toEqual(['segment 1', 'segment 2'])
    // Timestamps come from the file's own clock and stay ordered.
    expect(result?.segments[0]?.startMs).toBeLessThan(result?.segments[1]?.startMs ?? 0)
    expect(result?.segments[1]?.startMs).toBeGreaterThan(2_000)
    // The bar reaches the end even though the file's tail is silence.
    expect(result?.job.completedMs).toBe(result?.job.totalMs)
    // Every landed segment was announced as it landed.
    expect(events.filter((event) => event.segment !== null)).toHaveLength(2)
  })

  it('finishes with zero segments when the file holds no speech', async () => {
    const { transcriber } = makeTranscriber(
      scriptedEngine(async () => ({ text: 'never called', avgLogProb: null, durationMs: 1 })),
    )
    track(transcriber)

    const pcm = roomTone(4_000)
    const job = transcriber.begin('silence.wav', 4_000)
    await transcriber.push(job.id, pcm, true)

    await vi.waitFor(() => {
      expect(transcriber.list().find((j) => j.id === job.id)?.state).toBe('done')
    })
    expect(transcriber.result(job.id)?.segments).toHaveLength(0)
  })

  it('refuses to begin without a loaded engine', () => {
    const { transcriber } = makeTranscriber(null)
    track(transcriber)
    expect(() => transcriber.begin('a.mp3', 1_000)).toThrow(/speech model/i)
  })

  it('allows one live job at a time', () => {
    const { transcriber } = makeTranscriber(blockingEngine().engine)
    track(transcriber)
    transcriber.begin('first.mp3', 10_000)
    expect(() => transcriber.begin('second.mp3', 10_000)).toThrow(/one file at a time/i)
  })

  it('cancel stops the job and later pushes are refused', async () => {
    const controls = blockingEngine()
    const { transcriber } = makeTranscriber(controls.engine)
    track(transcriber)

    const job = transcriber.begin('long.mp3', 60_000)
    await transcriber.push(job.id, speechLike(16_000), false)
    expect(controls.calls.length).toBeGreaterThan(0)

    transcriber.cancel(job.id)
    expect(transcriber.list().find((j) => j.id === job.id)?.state).toBe('cancelled')
    await expect(transcriber.push(job.id, speechLike(1_000), false)).rejects.toThrow(
      /not accepting audio/i,
    )
  })

  it('retries a failed segment once, then succeeds quietly', async () => {
    let call = 0
    const { transcriber } = makeTranscriber(
      scriptedEngine(async () => {
        call += 1
        if (call === 1) throw new Error('sidecar hiccup')
        return { text: 'recovered', avgLogProb: null, durationMs: 1 }
      }),
    )
    track(transcriber)

    const job = transcriber.begin('flaky.mp3', 6_000)
    await transcriber.push(job.id, concat(speechLike(2_500), roomTone(1_200)), true)

    await vi.waitFor(
      () => {
        expect(transcriber.list().find((j) => j.id === job.id)?.state).toBe('done')
      },
      { timeout: 3_000 },
    )
    expect(transcriber.result(job.id)?.segments.map((s) => s.text)).toEqual(['recovered'])
  })

  it('fails the job honestly when a segment fails twice', async () => {
    const { transcriber } = makeTranscriber(
      scriptedEngine(async () => {
        throw new Error('the model went away')
      }),
    )
    track(transcriber)

    const job = transcriber.begin('doomed.mp3', 6_000)
    await transcriber.push(job.id, concat(speechLike(2_500), roomTone(1_200)), true).catch(() => {
      // The push may observe the failure first; the job state is the assertion.
    })

    await vi.waitFor(
      () => {
        expect(transcriber.list().find((j) => j.id === job.id)?.state).toBe('failed')
      },
      { timeout: 3_000 },
    )
    expect(transcriber.list().find((j) => j.id === job.id)?.error).toMatch(/went away/)
  })

  it('parks pushes at the high-water mark and releases them as segments finish', async () => {
    const controls = blockingEngine()
    const { transcriber } = makeTranscriber(controls.engine)
    track(transcriber)

    // Enough continuous speech that the hard cut queues highWaterMs of audio.
    const seconds = (TRANSCRIBE.highWaterMs + TRANSCRIBE.maxSegmentMs) / 1000 + 2
    const pcm = speechLike(seconds * 1000)
    const job = transcriber.begin('audiobook.mp3', seconds * 1000)

    let resolved = false
    const parked = transcriber.push(job.id, pcm, false).then(() => {
      resolved = true
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(resolved).toBe(false) // held: the engine has not drained anything

    // Draining below the high-water mark lets the push complete.
    while (!resolved) {
      controls.release()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await parked
    // Release anything still queued so dispose() is not fighting the engine.
    for (let i = 0; i < 10; i += 1) controls.release()
  })

  it('fails a job whose renderer stopped pushing and vanished', async () => {
    vi.useFakeTimers()
    const { transcriber } = makeTranscriber(
      scriptedEngine(async () => ({ text: 'x', avgLogProb: null, durationMs: 1 })),
    )
    track(transcriber)

    const job = transcriber.begin('abandoned.mp3', 60_000)
    await transcriber.push(job.id, speechLike(2_000), false)

    await vi.advanceTimersByTimeAsync(TRANSCRIBE.pushStallMs + TRANSCRIBE.watchdogTickMs)

    const snapshot = transcriber.list().find((j) => j.id === job.id)
    expect(snapshot?.state).toBe('failed')
    expect(snapshot?.error).toMatch(/stopped arriving/i)
  })

  it('clear refuses a live job and removes a finished one', async () => {
    const { transcriber } = makeTranscriber(
      scriptedEngine(async () => ({ text: 'x', avgLogProb: null, durationMs: 1 })),
    )
    track(transcriber)

    const job = transcriber.begin('short.mp3', 3_000)
    expect(() => transcriber.clear(job.id)).toThrow(/cancel/i)

    await transcriber.push(job.id, roomTone(1_000), true)
    await vi.waitFor(() => {
      expect(transcriber.list().find((j) => j.id === job.id)?.state).toBe('done')
    })
    transcriber.clear(job.id)
    expect(transcriber.list()).toHaveLength(0)
  })
})
