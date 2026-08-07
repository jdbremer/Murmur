import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MeetingRecord, Settings, Transcript } from '@murmur/shared'
import { createDefaultSettings } from '@murmur/shared'

import { CaptureController } from '../src/main/audio/controller'
import { FrameBus } from '../src/main/audio/frame-bus'
import type { SystemAudioListener, SystemAudioSource } from '../src/main/audio/system-capture'
import { AUDIO } from '../src/main/config'
import { TranscribeQueue } from '../src/main/engines/stt-queue'
import type { SttEngine } from '../src/main/engines/types'
import { createNullLogger } from '../src/main/logging'
import { MeetingRecorder } from '../src/main/meeting/recorder'
import { speechLike } from './helpers/pcm'

/**
 * End-to-end through the recorder with a fake engine and a fake far side.
 *
 * This is the pay-off from making `SystemAudioSource` an interface: the whole
 * meeting pipeline runs with no microphone, no CoreAudio and no permission, so
 * the thing the user actually receives — the file — can be asserted on.
 */

const FRAME = Math.round((AUDIO.sampleRate * AUDIO.frameMs) / 1000)

let folder: string

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'murmur-recorder-'))
})
afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

/** Returns whatever text was queued, in order, so tracks stay identifiable. */
function fakeEngine(texts: string[]): SttEngine {
  let at = 0
  return {
    id: 'whisper-cpp',
    load: async () => {},
    transcribe: async (): Promise<Transcript> => ({
      text: texts[at++ % texts.length] ?? '',
      avgLogProb: null,
      durationMs: 1,
    }),
    unload: async () => {},
    status: () =>
      ({
        engine: null,
        state: 'idle',
        modelId: null,
        reason: null,
        detail: '',
        warnings: [],
      }) as never,
    onStatusChange: () => () => {},
    dispose: async () => {},
  } as unknown as SttEngine
}

function fakeSystemAudio(): SystemAudioSource & { emit: SystemAudioListener } {
  let listener: SystemAudioListener = () => {}
  return {
    mode: 'native',
    capability: () => ({ supported: true, reason: '' }),
    access: () => ({ mode: 'native', status: 'granted', detail: '' }),
    probe: async () => ({ mode: 'native', status: 'granted', detail: '' }),
    start: async (next) => {
      listener = next
      return true
    },
    stop: () => {
      listener = () => {}
    },
    emit: (frame) => listener(frame),
  }
}

function build(options: { texts?: string[]; settings?: Partial<Settings['meetings']> } = {}) {
  const frames = new FrameBus()
  const capture = new CaptureController({
    ipc: { emit: () => {} } as never,
    target: () => ({}) as never,
    log: createNullLogger(),
  })
  const systemAudio = fakeSystemAudio()
  const saved: MeetingRecord[] = []
  const settings: Settings = {
    ...createDefaultSettings(),
    meetings: {
      ...createDefaultSettings().meetings,
      enabled: true,
      folder,
      ...options.settings,
    },
  }

  const recorder = new MeetingRecorder({
    capture,
    frames,
    systemAudio,
    queue: new TranscribeQueue({ isBusy: () => false }),
    stt: () => fakeEngine(options.texts ?? ['hello from the test']),
    settings: () => settings,
    defaultFolder: folder,
    persist: (record) => saved.push(record),
    log: createNullLogger(),
  })

  return { recorder, frames, systemAudio, saved, settings }
}

/** Push speech followed by enough silence to close a segment. */
function speak(publish: (frame: Float32Array) => void, ms = 2_500, amplitude = 0.25): void {
  const speech = speechLike(ms, amplitude)
  for (let at = 0; at + FRAME <= speech.length; at += FRAME) {
    publish(speech.subarray(at, at + FRAME))
  }
  const quiet = new Float32Array(FRAME)
  for (let i = 0; i < 12; i += 1) publish(quiet)
}

describe('MeetingRecorder', () => {
  it('refuses to record while the feature is switched off', async () => {
    const { recorder } = build({ settings: { enabled: false } })
    await expect(recorder.start('Nope', null)).rejects.toThrow(/turned off/i)
    expect(readdirSync(folder)).toHaveLength(0)
  })

  it('writes a named transcript containing what both sides said', async () => {
    const { recorder, frames, systemAudio } = build({ texts: ['I can hear you fine'] })
    await recorder.start('Weekly Sync', 'us.zoom.xos')

    speak((frame) => frames.publish(frame))
    speak((frame) => systemAudio.emit(frame))

    const record = await recorder.stop()
    expect(record).not.toBeNull()

    const text = readFileSync(record?.path ?? '', 'utf8')
    expect(record?.path).toMatch(/Weekly Sync\.md$/)
    expect(text).toContain('I can hear you fine')
    expect(record?.segmentCount).toBeGreaterThan(0)
  })

  it('attributes the microphone to you and the tap to them', async () => {
    // The two tracks are distinguished by loudness rather than call order,
    // because a mic segment can be held back by the echo policy and arrive
    // after the system one — which is exactly what happens inside the
    // start-of-session warm-up window.
    const byLoudness: SttEngine = {
      transcribe: async (pcm: Float32Array): Promise<Transcript> => {
        let peak = 0
        for (const sample of pcm) peak = Math.max(peak, Math.abs(sample))
        return { text: peak > 0.4 ? 'theirs' : 'mine', avgLogProb: null, durationMs: 1 }
      },
    } as unknown as SttEngine

    const frames = new FrameBus()
    const systemAudio = fakeSystemAudio()
    const recorder = new MeetingRecorder({
      capture: new CaptureController({
        ipc: { emit: () => {} } as never,
        target: () => ({}) as never,
        log: createNullLogger(),
      }),
      frames,
      systemAudio,
      queue: new TranscribeQueue({ isBusy: () => false }),
      stt: () => byLoudness,
      settings: () => ({
        ...createDefaultSettings(),
        meetings: { ...createDefaultSettings().meetings, enabled: true, folder },
      }),
      defaultFolder: folder,
      persist: () => {},
      log: createNullLogger(),
    })

    await recorder.start('Attribution', null)
    speak((frame) => frames.publish(frame), 2_500, 0.2)
    speak((frame) => systemAudio.emit(frame), 2_500, 0.8)

    const record = await recorder.stop()
    const text = readFileSync(record?.path ?? '', 'utf8')

    expect(text).toContain('You:** mine')
    expect(text).toContain('Them:** theirs')
  })

  it('records the meeting even when the engine is gone, with an honest gap', async () => {
    // An engine crash-loop must cost the transcript that stretch, not the
    // remaining hour of a meeting still being captured.
    const { recorder, frames } = build()
    const withoutEngine = new MeetingRecorder({
      capture: new CaptureController({
        ipc: { emit: () => {} } as never,
        target: () => ({}) as never,
        log: createNullLogger(),
      }),
      frames,
      systemAudio: fakeSystemAudio(),
      queue: new TranscribeQueue({ isBusy: () => false }),
      stt: () => null,
      settings: () => ({
        ...createDefaultSettings(),
        meetings: { ...createDefaultSettings().meetings, enabled: true, folder },
      }),
      defaultFolder: folder,
      persist: () => {},
      log: createNullLogger(),
    })
    void recorder

    await withoutEngine.start('No Engine', null)
    speak((frame) => frames.publish(frame))

    const record = await withoutEngine.stop()
    const text = readFileSync(record?.path ?? '', 'utf8')
    expect(text).toContain('transcription unavailable')
    expect(record).not.toBeNull()
  })

  it('falls back to microphone-only when the far side cannot be captured', async () => {
    const { recorder, frames } = build()
    const denied: SystemAudioSource = {
      ...fakeSystemAudio(),
      start: async () => false,
    }
    const micOnly = new MeetingRecorder({
      capture: new CaptureController({
        ipc: { emit: () => {} } as never,
        target: () => ({}) as never,
        log: createNullLogger(),
      }),
      frames,
      systemAudio: denied,
      queue: new TranscribeQueue({ isBusy: () => false }),
      stt: () => fakeEngine(['just me then']),
      settings: () => ({
        ...createDefaultSettings(),
        meetings: { ...createDefaultSettings().meetings, enabled: true, folder },
      }),
      defaultFolder: folder,
      persist: () => {},
      log: createNullLogger(),
    })
    void recorder

    const state = await micOnly.start('Mic Only', null)
    expect(state).toMatchObject({ hasSystemAudio: false })

    speak((frame) => frames.publish(frame))
    const record = await micOnly.stop()

    expect(record?.hadSystemAudio).toBe(false)
    expect(readFileSync(record?.path ?? '', 'utf8')).toContain('audio: microphone only')
  })

  it('persists the meeting and stops taking frames once finished', async () => {
    const { recorder, frames, saved } = build()
    await recorder.start('Bookkeeping', null)
    speak((frame) => frames.publish(frame))
    await recorder.stop()

    expect(saved).toHaveLength(1)
    expect(recorder.recording).toBe(false)
    // Nothing is listening any more, so a stray frame must not reopen a file.
    const before = readdirSync(folder).length
    speak((frame) => frames.publish(frame))
    expect(readdirSync(folder)).toHaveLength(before)
  })

  it('keeps the audio as WAV when asked, one file per track', async () => {
    const { recorder, frames, systemAudio } = build({ settings: { keepAudio: true } })
    const record = await recorder.start('Kept Audio', null)
    void record

    speak((frame) => frames.publish(frame))
    speak((frame) => systemAudio.emit(frame))
    await recorder.stop()

    const files = readdirSync(folder).sort()
    expect(files).toContain(files.find((f) => f.endsWith('(you).wav')))
    expect(files).toContain(files.find((f) => f.endsWith('(them).wav')))
    // Non-trivial: the header alone is 44 bytes.
    const you = files.find((f) => f.endsWith('(you).wav')) ?? ''
    expect(statSync(join(folder, you)).size).toBeGreaterThan(44)
  })

  it('writes no audio files unless keepAudio is on', async () => {
    const { recorder, frames } = build()
    await recorder.start('No Audio', null)
    speak((frame) => frames.publish(frame))
    await recorder.stop()

    expect(readdirSync(folder).filter((f) => f.endsWith('.wav'))).toHaveLength(0)
  })

  it('marks the gap when the machine sleeps mid-meeting', async () => {
    // Sleeping must not read as "nobody spoke for two hours".
    const { recorder, frames } = build()
    await recorder.start('Interrupted', null)
    speak((frame) => frames.publish(frame))

    recorder.suspend()
    // Frames arriving while suspended are ignored rather than mis-timestamped.
    speak((frame) => frames.publish(frame))
    recorder.resume()
    speak((frame) => frames.publish(frame))

    const record = await recorder.stop()
    expect(readFileSync(record?.path ?? '', 'utf8')).toContain('[asleep')
  })

  it('writes the conversation in start-time order, not arrival order', async () => {
    // The echo holdback can delay a mic segment past a later system one, so
    // arrival order is not conversation order.
    const { recorder, frames, systemAudio } = build({ texts: ['first', 'second', 'third'] })
    await recorder.start('Ordering', null)

    speak((frame) => frames.publish(frame))
    speak((frame) => systemAudio.emit(frame))
    speak((frame) => frames.publish(frame))

    const record = await recorder.stop()
    const text = readFileSync(record?.path ?? '', 'utf8')

    const stamps = [...text.matchAll(/\*\*\[(\d+):(\d+)\]/g)].map(
      (m) => Number(m[1]) * 60 + Number(m[2]),
    )
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
  })

  it('reports an offer without starting to record', async () => {
    const { recorder } = build()
    recorder.offer('Detected Call', 'us.zoom.xos')

    expect(recorder.state()).toMatchObject({ state: 'offered', title: 'Detected Call' })
    expect(recorder.recording).toBe(false)
    expect(readdirSync(folder)).toHaveLength(0)

    recorder.clearOffer()
    expect(recorder.state()).toMatchObject({ state: 'idle' })
  })
})
