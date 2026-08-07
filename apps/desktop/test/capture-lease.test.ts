import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CaptureController } from '../src/main/audio/controller'
import { AUDIO } from '../src/main/config'
import { createNullLogger } from '../src/main/logging'

/**
 * Two consumers now want the microphone: dictation, for a few seconds, and a
 * meeting recording, for an hour. The bugs these tests pin are all the same
 * shape — the long-lived holder losing the stream to something the short-lived
 * one did, silently, with no error anywhere.
 */

interface Sent {
  action: string
  deviceId: string | null
}

function build(): { controller: CaptureController; sent: Sent[] } {
  const sent: Sent[] = []
  const controller = new CaptureController({
    ipc: {
      emit: (_target: unknown, _channel: string, payload: Sent) => {
        sent.push(payload)
      },
    } as never,
    target: () => ({}) as never,
    log: createNullLogger(),
  })
  return { controller, sent }
}

const last = (sent: Sent[]): string | undefined => sent.at(-1)?.action

describe('CaptureController leases', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opens the stream when a lease is taken', () => {
    const { controller, sent } = build()
    controller.acquire('meeting')
    expect(last(sent)).toBe('start')
    expect(controller.streaming).toBe(true)
  })

  it('keeps streaming while any lease is held', () => {
    const { controller, sent } = build()
    const a = controller.acquire('meeting')
    controller.acquire('other')

    a.release()
    expect(controller.streaming).toBe(true)
    expect(last(sent)).not.toBe('stop')
  })

  it('only arms the idle timer once the last lease goes', () => {
    const { controller, sent } = build()
    const lease = controller.acquire('meeting')
    lease.release()
    expect(last(sent)).toBe('stop')

    vi.advanceTimersByTime(AUDIO.warmIdleMs + 10)
    expect(last(sent)).toBe('release')
  })

  it('never releases the stream out from under a live meeting', () => {
    // The dictation path calls stop() and release() freely. Neither may end a
    // recording that another consumer is still holding.
    const { controller, sent } = build()
    controller.acquire('meeting')

    controller.start(null)
    controller.stop()
    controller.release()

    vi.advanceTimersByTime(AUDIO.warmIdleMs * 2)
    expect(sent.some((entry) => entry.action === 'release')).toBe(false)
    expect(controller.streaming).toBe(true)
  })

  it('re-opens on start, not warm, when the mic changes mid-meeting', () => {
    // The original bug: setDevice sent release+warm, and warm armed the
    // five-minute idle timer. Changing microphone five minutes into a
    // forty-minute call would have ended the recording with no error at all.
    const { controller, sent } = build()
    controller.acquire('meeting')
    sent.length = 0

    controller.setDevice('another-mic')

    expect(sent.map((entry) => entry.action)).toEqual(['release', 'start'])
    vi.advanceTimersByTime(AUDIO.warmIdleMs * 2)
    expect(
      sent.some((entry) => entry.action === 'release' && entry.deviceId === 'another-mic'),
    ).toBe(false)
    expect(controller.streaming).toBe(true)
  })

  it('still warms when the mic changes with nothing holding it', () => {
    const { controller, sent } = build()
    controller.setDevice('another-mic')
    expect(sent.map((entry) => entry.action)).toEqual(['release', 'warm'])
  })

  it('a lease taken while the idle timer is pending wins', () => {
    const { controller, sent } = build()
    controller.warm(null)
    controller.acquire('meeting')

    vi.advanceTimersByTime(AUDIO.warmIdleMs + 10)
    expect(sent.some((entry) => entry.action === 'release')).toBe(false)
    expect(controller.streaming).toBe(true)
  })

  it('releasing the same lease twice is harmless', () => {
    const { controller } = build()
    const lease = controller.acquire('meeting')
    lease.release()
    lease.release()
    expect(controller.streaming).toBe(false)
  })

  it('dictation still behaves normally when no meeting is running', () => {
    const { controller, sent } = build()
    controller.start(null)
    expect(last(sent)).toBe('start')
    controller.stop()
    expect(last(sent)).toBe('stop')

    vi.advanceTimersByTime(AUDIO.warmIdleMs + 10)
    expect(last(sent)).toBe('release')
  })
})
