import { describe, expect, it, vi } from 'vitest'

import type { Transcript } from '@murmur/shared'

import { TranscribeQueue } from '../src/main/engines/stt-queue'

/**
 * The queue exists because neither engine tolerates concurrent calls, and
 * because a meeting must never make a dictation feel slow.
 */

function transcript(text: string): Transcript {
  return { text, avgLogProb: null, durationMs: 1 }
}

/** A job that resolves when you tell it to. */
function deferred(): {
  run: () => Promise<Transcript>
  finish: (text: string) => void
  started: () => boolean
} {
  let started = false
  let resolve: (value: Transcript) => void = () => {}
  const promise = new Promise<Transcript>((r) => {
    resolve = r
  })
  return {
    run: () => {
      started = true
      return promise
    },
    finish: (text) => resolve(transcript(text)),
    started: () => started,
  }
}

describe('TranscribeQueue', () => {
  it('runs one job at a time', async () => {
    const queue = new TranscribeQueue({ isBusy: () => false })
    const first = deferred()
    const second = deferred()

    const a = queue.submit('background', first.run)
    const b = queue.submit('background', second.run)

    expect(first.started()).toBe(true)
    expect(second.started()).toBe(false)

    first.finish('one')
    await a
    await vi.waitFor(() => expect(second.started()).toBe(true))
    second.finish('two')
    expect((await b).text).toBe('two')
  })

  it('lets a dictation jump ahead of queued meeting work', async () => {
    const queue = new TranscribeQueue({ isBusy: () => false })
    const running = deferred()
    const background = deferred()
    const interactive = deferred()

    const first = queue.submit('background', running.run)
    queue.submit('background', background.run)
    queue.submit('interactive', interactive.run)

    running.finish('running')
    await first

    // The interactive job was submitted last but must run next.
    await vi.waitFor(() => expect(interactive.started()).toBe(true))
    expect(background.started()).toBe(false)
  })

  it('holds meeting work back entirely while the user is dictating', async () => {
    // This is the mechanism that actually protects dictation latency. Aborting
    // an in-flight request would not: whisper-server finishes the inference
    // regardless of whether the client is still waiting.
    let dictating = true
    const queue = new TranscribeQueue({ isBusy: () => dictating })
    const meeting = deferred()

    queue.submit('background', meeting.run)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(meeting.started()).toBe(false)

    dictating = false
    await vi.waitFor(() => expect(meeting.started()).toBe(true), { timeout: 2_000 })
  })

  it('never holds an interactive job back, whatever else is happening', async () => {
    const queue = new TranscribeQueue({ isBusy: () => true })
    const job = deferred()
    queue.submit('interactive', job.run)
    expect(job.started()).toBe(true)
  })

  it('surfaces a failing job without stalling the queue behind it', async () => {
    const queue = new TranscribeQueue({ isBusy: () => false })
    const failed = queue.submit('background', () => Promise.reject(new Error('engine died')))
    await expect(failed).rejects.toThrow('engine died')

    const after = await queue.submit('background', () => Promise.resolve(transcript('still works')))
    expect(after.text).toBe('still works')
  })

  it('clear rejects everything waiting, so shutdown cannot hang', async () => {
    const queue = new TranscribeQueue({ isBusy: () => true })
    const pending = queue.submit('background', () => Promise.resolve(transcript('never')))
    queue.clear('shutting down')
    await expect(pending).rejects.toThrow('shutting down')
  })
})
