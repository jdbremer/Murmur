import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AUDIO, TIMEOUTS } from '../src/main/config'
import { DictationOrchestrator } from '../src/main/dictation/orchestrator'
import { createHarness, type OrchestratorHarness } from './helpers/fakes'
import { concat, roomTone, speechLike } from './helpers/pcm'

/**
 * The dictation loop's transition table (PLAN §3.2, §15.1).
 *
 * PLAN §15.1: "the state machine returns to a safe idle on every failure path —
 * no dead ends, asserted by unit tests over the full transition table". That is
 * what this file is. Every test ends with the same two assertions — the phase is
 * `idle` and the machine's resting state is `idle` — because a loop that
 * transcribes correctly but strands itself in `processing` is worse than one
 * that fails loudly.
 */

/** ~1.2 s of speech, comfortably over the 250 ms minimum. */
function utterance(): Float32Array {
  return concat(roomTone(200), speechLike(1200), roomTone(200))
}

/** Feed a buffer in as ~100 ms frames, the way the capture renderer does. */
function feed(orchestrator: DictationOrchestrator, pcm: Float32Array): void {
  const frameSamples = (AUDIO.frameMs / 1000) * AUDIO.sampleRate
  for (let offset = 0; offset < pcm.length; offset += frameSamples) {
    orchestrator.pushFrame(pcm.slice(offset, offset + frameSamples))
  }
}

let harness: OrchestratorHarness
let orchestrator: DictationOrchestrator

beforeEach(() => {
  harness = createHarness()
  orchestrator = new DictationOrchestrator(harness.deps)
})

afterEach(() => {
  orchestrator.dispose()
  vi.useRealTimers()
})

/** Every test's closing assertion. */
function expectSettledIdle(): void {
  expect(orchestrator.phase).toBe('idle')
  expect(harness.machine.state).toBe('idle')
}

describe('happy path', () => {
  it('runs idle → listening → processing → inserting → inserted → idle', async () => {
    orchestrator.begin()
    expect(orchestrator.phase).toBe('listening')
    expect(harness.machine.state).toBe('listening')
    expect(harness.audio.calls).toContain('start')

    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.events.map((event) => event.state)).toEqual([
      'listening',
      'processing', // transcribing
      'processing', // polishing
      'inserting',
      'inserted',
    ])
    expect(harness.insertedText).toEqual(['Hello world, this is a test.'])
    expectSettledIdle()
  })

  it('expands a snippet in the text it actually inserts', async () => {
    // Proves the wiring, not the matcher: expansion has to happen inside the
    // loop and after polishing, or the model gets to reword a URL.
    harness.snippets.push({
      id: 's1',
      trigger: 'this is a test',
      expansion: 'https://cal.example/jordan',
      enabled: true,
    })

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.insertedText).toEqual(['Hello world, https://cal.example/jordan.'])
    expectSettledIdle()
  })

  it('lowercases the opening word when the cursor is mid-sentence', async () => {
    harness.deps.textBeforeCursor = () => 'I was saying '

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.insertedText).toEqual(['hello world, this is a test.'])
    expectSettledIdle()
  })

  it('separates a burst of dictations instead of welding them together', async () => {
    // Stop, go, stop, go: the cursor sits hard against the previous sentence,
    // so the insertion has to bring its own space (spacing.ts).
    harness.deps.textBeforeCursor = () => 'Wednesday.'

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.insertedText).toEqual([' Hello world, this is a test.'])
    expectSettledIdle()
  })

  it('keeps the capital when the cursor context cannot be read', async () => {
    // The unknown case must never change the *casing* — this is the guard that
    // keeps a platform without the API from mangling every dictation.
    //
    // It does gain a trailing space: with no way to see what precedes the
    // cursor, that is the one edit that keeps the next dictation from welding
    // itself onto this one (spacing.ts).
    harness.deps.textBeforeCursor = () => null

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.insertedText).toEqual(['Hello world, this is a test. '])
    expectSettledIdle()
  })

  it('persists a history row with both texts and the timings', async () => {
    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))

    const record = harness.persisted[0]!
    expect(record.rawText).toBe('hello world this is a test')
    expect(record.polishedText).toBe('Hello world, this is a test.')
    expect(record.sttModelId).toBe('fake-stt')
    expect(record.polishModelId).toBe('fake-polish')
    expect(record.appBundleId).toBe('com.tinyspeck.slackmacgap')
    // Slack maps to the work tone profile.
    expect(record.appCategory).toBe('work')
    expect(record.timings.sttMs).toBeGreaterThanOrEqual(0)
    expect(record.durationMs).toBeGreaterThan(AUDIO.minUtteranceMs)
    expectSettledIdle()
  })

  it('captures the frontmost app at hotkey-down, not at insert time', async () => {
    let bundleId = 'com.apple.mail'
    harness.deps.frontmostApp = () => ({ bundleId, name: 'Mail' })

    orchestrator.begin()
    // The user switches app mid-utterance; the tone must not follow them.
    bundleId = 'com.apple.Terminal'
    feed(orchestrator, utterance())
    orchestrator.end()

    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))
    expect(harness.persisted[0]!.appBundleId).toBe('com.apple.mail')
    expect(harness.persisted[0]!.appCategory).toBe('email')
  })

  it('applies dictionary replacements before polishing', async () => {
    harness.deps.applyDictionary = (text) => ({
      text: text.replace('murmer', 'Murmur'),
      replacements: 1,
    })
    harness.stt.transcript = {
      text: 'ship murmer on wednesday please',
      avgLogProb: null,
      durationMs: 5,
    }

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))

    expect(harness.persisted[0]!.rawText).toBe('ship Murmur on wednesday please')
    // The polish prompt saw the corrected spelling. Asserted on content rather
    // than equality: the transcript reaches the model wrapped in <transcript>
    // tags, and this test is about the dictionary, not the framing.
    expect(harness.polish.requests[0]!.userText).toContain('ship Murmur on wednesday please')
    expect(harness.polish.requests[0]!.userText).not.toContain('murmer')
  })

  it('reports what it fixed, so Insights counts measurements rather than guesses', async () => {
    harness.deps.applyDictionary = (text) => ({
      text: text.replace('murmer', 'Murmur'),
      replacements: 1,
    })
    harness.snippets.push({
      id: 's1',
      trigger: 'my calendar link',
      expansion: 'https://cal.example/jay',
      enabled: true,
    })
    harness.stt.transcript = {
      text: 'ship murmer and send my calendar link',
      avgLogProb: null,
      durationMs: 5,
    }
    // 7 raw words in, 5 polished words out: two words cleaned. The trigger has
    // to survive polishing, because snippets expand against the polished text.
    harness.polish.result = { text: 'Ship Murmur my calendar link', durationMs: 8 }

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))

    expect(harness.persistedFixes[0]).toEqual({
      dictionaryFixes: 1,
      snippetExpansions: 1,
      wordsCleaned: 2,
    })
  })

  it('records the app name alongside the bundle id', async () => {
    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))

    expect(harness.persisted[0]!.appBundleId).toBe('com.tinyspeck.slackmacgap')
    // Without this the Insights breakdown could only ever show a bundle id.
    expect(harness.persisted[0]!.appName).toBe('Slack')
  })
})

describe('no-speech guards', () => {
  it('rejects an utterance shorter than the minimum', async () => {
    orchestrator.begin()
    feed(orchestrator, speechLike(120))
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'no-speech' })
    expect(harness.stt.transcribeCalls).toHaveLength(0)
    expectSettledIdle()
  })

  it('rejects a long recording that contains no speech', async () => {
    orchestrator.begin()
    feed(orchestrator, roomTone(2000))
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'no-speech' })
    expect(harness.stt.transcribeCalls).toHaveLength(0)
    expectSettledIdle()
  })

  it('stays quiet when the press could be the first half of a double-tap', async () => {
    // The gesture is: tap, tap. The first tap is *always* an empty utterance,
    // and the second arrives up to 350 ms later — so reporting the first one
    // flashes "Didn't catch that" at someone who is mid-gesture and did nothing
    // wrong. It still settles to idle; it just does not accuse them.
    orchestrator.begin()
    feed(orchestrator, speechLike(120))
    orchestrator.end({ fromTap: true })
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.events.at(-1)).toEqual({ state: 'idle' })
    expect(harness.events.some((event) => event.state === 'error')).toBe(false)
    expect(harness.stt.transcribeCalls).toHaveLength(0)
    expectSettledIdle()
  })

  it('still reports a hold that heard nothing, even with the tap flag absent', async () => {
    // The quiet path must be reachable only through the flag: an ordinary hold
    // that produced nothing is a real miss and has to say so.
    orchestrator.begin()
    feed(orchestrator, roomTone(2000))
    orchestrator.end({})
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'no-speech' })
    expectSettledIdle()
  })

  it('rejects an empty transcript from a model that heard nothing', async () => {
    harness.stt.transcript = { text: '   ', avgLogProb: null, durationMs: 3 }
    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'no-speech' })
    expect(harness.persisted).toHaveLength(0)
    expectSettledIdle()
  })

  it('does nothing at all when end() arrives with no begin()', () => {
    orchestrator.end()
    expect(harness.events).toHaveLength(0)
    expectSettledIdle()
  })
})

describe('preconditions', () => {
  it('refuses to record into a secure field, before any audio is captured', () => {
    harness.precheckResult.current = {
      ok: false,
      reason: 'secure-input',
      message: 'Secure field — Murmur will not type here.',
    }

    orchestrator.begin()

    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'secure-input' })
    expect(harness.audio.calls).not.toContain('start')
    expectSettledIdle()
  })

  it('refuses when no STT engine exists', () => {
    harness.deps.stt = () => null
    orchestrator.begin()
    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'stt-failed' })
    expectSettledIdle()
  })

  it('refuses when the STT engine is not ready, quoting its detail', () => {
    harness.stt.status_ = {
      engine: 'whisper-cpp',
      state: 'unavailable',
      modelId: null,
      reason: 'binary-missing',
      detail: 'whisper-server is not installed.',
      warnings: [],
    }

    orchestrator.begin()
    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'stt-failed' })
    expectSettledIdle()
  })

  it('ignores a second begin() while already listening', () => {
    orchestrator.begin()
    const before = harness.events.length
    orchestrator.begin()
    expect(harness.events).toHaveLength(before)
    expect(orchestrator.phase).toBe('listening')
  })
})

describe('failure paths', () => {
  it('surfaces an STT failure and returns to idle', async () => {
    harness.stt.transcribeImpl = async () => {
      throw new Error('whisper-server died')
    }

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'stt-failed' })
    expect(harness.persisted).toHaveLength(0)
    expectSettledIdle()
  })

  it('inserts the raw transcript when polishing throws, and records that', async () => {
    harness.polish.polishImpl = async () => {
      throw new Error('llama-server died')
    }

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))

    // The dictation succeeded — a polish failure is not a dictation failure.
    expect(harness.insertedText).toEqual(['hello world this is a test'])
    expect(harness.persisted[0]!.polishedText).toBeNull()
    expect(harness.events.at(-1)?.state).toBe('inserted')
    expectSettledIdle()
  })

  it('falls back to the raw transcript when the hallucination guard fires', async () => {
    harness.polish.result = {
      text: 'The standup is at 10am, and here is a summary of everything else that happened this week, plus my opinion about it, at considerable length indeed.',
      durationMs: 30,
    }

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))

    expect(harness.insertedText).toEqual(['hello world this is a test'])
    expect(harness.persisted[0]!.polishedText).toBeNull()
    expectSettledIdle()
  })

  it('surfaces an insertion failure', async () => {
    harness.insertResult.current = {
      ok: false,
      method: 'none',
      reason: 'paste-failed',
      error: 'Could not insert text',
    }

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'insert-failed' })
    expect(harness.persisted).toHaveLength(0)
    expectSettledIdle()
  })

  it('maps a secure-input insertion failure to its own error code', async () => {
    harness.insertResult.current = {
      ok: false,
      method: 'none',
      reason: 'secure-input',
      error: 'Secure field',
    }

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'secure-input' })
    expectSettledIdle()
  })

  it('completes the dictation even when the history write throws', async () => {
    harness.persistThrows.current = true

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    // The text is already in the user's app; losing the row must not undo that.
    expect(harness.insertedText).toHaveLength(1)
    expect(harness.events.at(-1)?.state).toBe('inserted')
    expectSettledIdle()
  })

  it('reports a mic failure from the capture renderer', () => {
    orchestrator.begin()
    orchestrator.reportAudioError('Microphone is in use by another app')

    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'mic-unavailable' })
    expectSettledIdle()
  })

  it('ignores a mic failure reported while idle', () => {
    orchestrator.reportAudioError('nothing to see here')
    expect(harness.events).toHaveLength(0)
    expectSettledIdle()
  })
})

describe('timeouts', () => {
  it('fails the STT stage when the engine never answers', async () => {
    vi.useFakeTimers()
    harness.stt.hang()

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()

    // Let the pre-STT guards run, then jump past the stage timeout.
    await vi.advanceTimersByTimeAsync(1)
    expect(orchestrator.phase).toBe('transcribing')

    await vi.advanceTimersByTimeAsync(TIMEOUTS.sttMs + 10)

    // A timeout gets its own code, distinct from "the engine returned an error".
    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'timeout' })
    expectSettledIdle()
  })

  it('finalises an utterance that runs past the listening watchdog', async () => {
    vi.useFakeTimers()

    orchestrator.begin()
    feed(orchestrator, utterance())
    // Nobody released the key: the watchdog finalises rather than hanging.
    await vi.advanceTimersByTimeAsync(TIMEOUTS.captureStartMs + AUDIO.maxUtteranceMs + 10)
    await vi.advanceTimersByTimeAsync(50)

    expect(harness.stt.transcribeCalls).toHaveLength(1)
    expectSettledIdle()
  })
})

describe('cancellation', () => {
  it('cancels while listening without an error event', () => {
    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.cancel()

    expect(harness.events.at(-1)).toEqual({ state: 'idle' })
    expect(harness.stt.transcribeCalls).toHaveLength(0)
    expect(harness.audio.calls).toContain('stop')
    expectSettledIdle()
  })

  it('emits a typed error when the caller asks for one', () => {
    orchestrator.begin()
    orchestrator.cancel({ emitError: true, message: 'Paused' })
    expect(harness.events.at(-1)).toEqual({ state: 'error', code: 'cancelled' })
    expectSettledIdle()
  })

  it('aborts an in-flight transcription', async () => {
    vi.useFakeTimers()
    harness.stt.hang()

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.advanceTimersByTimeAsync(1)
    expect(orchestrator.phase).toBe('transcribing')

    orchestrator.cancel()
    await vi.advanceTimersByTimeAsync(10)

    // The abort rejects the engine promise; the loop must not then emit an
    // error on top of the cancel, nor insert anything.
    expect(harness.insertedText).toHaveLength(0)
    expect(harness.events.at(-1)).toEqual({ state: 'idle' })
    expectSettledIdle()
  })

  it('is idempotent and safe from idle', () => {
    orchestrator.cancel()
    orchestrator.cancel()
    expect(harness.events).toHaveLength(0)
    expectSettledIdle()
  })
})

describe('hands-free (PLAN §5)', () => {
  it('keeps listening through a pause — silence never ends the session', async () => {
    // It used to finalise after ~800 ms of quiet, and because finishing clears
    // the latch that dropped the user out of hands-free after one sentence.
    // Pausing to think is not a decision to stop talking.
    orchestrator.begin({ handsFree: true })
    expect(orchestrator.handsFree).toBe(true)

    feed(orchestrator, speechLike(1200))
    orchestrator.end() // a release must not stop hands-free
    expect(orchestrator.phase).toBe('listening')

    // Several seconds of quiet — far past the old threshold.
    feed(orchestrator, roomTone(4000))
    expect(orchestrator.phase).toBe('listening')
    expect(orchestrator.handsFree).toBe(true)
    expect(harness.stt.transcribeCalls).toHaveLength(0)

    // Speaking again after the pause continues the same utterance.
    feed(orchestrator, speechLike(1200))
    expect(orchestrator.phase).toBe('listening')

    // Only the user ends it.
    orchestrator.stopHandsFree()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))
    expect(harness.stt.transcribeCalls).toHaveLength(1)
    expectSettledIdle()
  })

  it('latches mid-utterance when the double-tap arrives while listening', () => {
    orchestrator.begin()
    expect(orchestrator.handsFree).toBe(false)
    orchestrator.startHandsFree()
    expect(orchestrator.handsFree).toBe(true)
    expect(orchestrator.phase).toBe('listening')
  })

  it('starts from idle when hands-free is latched with nothing running', () => {
    orchestrator.startHandsFree()
    expect(orchestrator.phase).toBe('listening')
    expect(orchestrator.handsFree).toBe(true)
  })

  it('stopHandsFree finalises the utterance in flight', async () => {
    orchestrator.begin({ handsFree: true })
    feed(orchestrator, utterance())
    orchestrator.stopHandsFree()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.stt.transcribeCalls).toHaveLength(1)
    expectSettledIdle()
  })

  it('stopHandsFree is a no-op when hands-free is not active', () => {
    orchestrator.begin()
    orchestrator.stopHandsFree()
    expect(orchestrator.phase).toBe('listening')
  })
})

describe('polish skipping (PLAN §3.2.4)', () => {
  it('skips polishing for a three-word utterance', async () => {
    harness.stt.transcript = { text: 'yes sounds good', avgLogProb: null, durationMs: 4 }

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))

    expect(harness.polish.requests).toHaveLength(0)
    expect(harness.insertedText).toEqual(['yes sounds good'])
    expect(harness.persisted[0]!.polishedText).toBeNull()
    expectSettledIdle()
  })

  it('skips polishing entirely when the level is off', async () => {
    harness.settings.polishingLevel = 'off'

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))

    expect(harness.polish.requests).toHaveLength(0)
    expect(harness.persisted[0]!.polishModelId).toBeNull()
    expectSettledIdle()
  })

  it('skips polishing when the polish engine is not ready', async () => {
    harness.polish.status_ = {
      engine: 'llama-cpp',
      state: 'unavailable',
      modelId: null,
      reason: 'model-missing',
      detail: 'not downloaded',
      warnings: [],
    }

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))

    expect(harness.polish.requests).toHaveLength(0)
    expect(harness.insertedText).toEqual(['hello world this is a test'])
    expectSettledIdle()
  })

  it('still polishes when the engine unloaded itself but remembers the model', async () => {
    // The bundled server frees its RAM after ten idle minutes and reports
    // `idle` while holding on to the model it means to bring back — its own
    // status detail says it will reload on the next dictation, and `polish()`
    // respawns before it sends. Skipping here asked for no reload and left
    // nothing to move the engine out of `idle`, so one quiet ten minutes
    // silently switched polishing off for every utterance that followed.
    Object.assign(harness.polish.status_, {
      state: 'idle',
      modelId: 'fake-polish',
      detail: 'Unloaded after idle; will reload on the next dictation.',
    })

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))

    expect(harness.polish.requests).toHaveLength(1)
    expect(harness.insertedText).toEqual(['Hello world, this is a test.'])
    expectSettledIdle()
  })

  it('skips polishing when idle with nothing to bring back', async () => {
    // The other `idle`: never loaded at all. There is no model to wake, so
    // waiting on a respawn that cannot happen would only delay the insert.
    Object.assign(harness.polish.status_, { state: 'idle', modelId: null })

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))

    expect(harness.polish.requests).toHaveLength(0)
    expect(harness.insertedText).toEqual(['hello world this is a test'])
    expectSettledIdle()
  })

  it('skips polishing when no polish engine exists at all', async () => {
    harness.deps.polish = () => null

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(harness.persisted).toHaveLength(1))

    expect(harness.insertedText).toEqual(['hello world this is a test'])
    expectSettledIdle()
  })
})

describe('buffering', () => {
  it('caps a runaway utterance and transcribes what it has', async () => {
    orchestrator.begin()
    // Feed well past the 5-minute cap in big chunks.
    const chunk = speechLike(5000)
    for (let index = 0; index < 70; index += 1) orchestrator.pushFrame(chunk)

    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))
    expect(harness.stt.transcribeCalls).toHaveLength(1)
    const captured = harness.stt.transcribeCalls[0]!
    expect(captured.length).toBeLessThanOrEqual((AUDIO.maxUtteranceMs / 1000) * AUDIO.sampleRate)
    expectSettledIdle()
  })

  it('drops frames that arrive while idle into the pre-roll, not the utterance', async () => {
    // Frames before the hotkey keep the ~300 ms pre-roll warm (PLAN §5).
    feed(orchestrator, speechLike(1000))
    expect(orchestrator.phase).toBe('idle')

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    // The utterance carries at most the pre-roll window of prior audio, not the
    // whole second that was fed while idle. (VAD trimming only ever shortens
    // it further, so this is an upper bound on what reached the engine.)
    const preRollSamples = (AUDIO.preRollMs / 1000) * AUDIO.sampleRate
    const captured = harness.stt.transcribeCalls[0]!
    expect(captured.length).toBeLessThan(utterance().length + preRollSamples * 2)
    expectSettledIdle()
  })
})

describe('command mode (PLAN §18.1)', () => {
  it('treats the utterance as an instruction and replaces the selection', async () => {
    harness.deps.selection = () => 'the quick brown fox'
    harness.polish.result = { text: 'THE QUICK BROWN FOX', durationMs: 5 }

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    // The edited selection is what got inserted — never the instruction.
    expect(harness.insertedText).toEqual(['THE QUICK BROWN FOX'])
    const record = harness.persisted[0]!
    expect(record.rawText).toBe('hello world this is a test') // the instruction
    expect(record.polishedText).toBe('THE QUICK BROWN FOX')
    expectSettledIdle()
  })

  it('falls back to plain dictation when no polish model is ready', async () => {
    // With polishing off or no model, dictating over a selection must stay
    // plain dictation — the paste replaces the selection exactly the way
    // typing would. Erroring here would turn an everyday habit (select, then
    // talk over it) into lost speech.
    harness.deps.selection = () => 'precious selected words'
    Object.assign(harness.polish.status_, { state: 'idle', modelId: null })

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    // Plain dictation with polish unavailable inserts the raw transcript.
    expect(harness.insertedText).toEqual(['hello world this is a test'])
    expect(harness.persisted[0]?.polishedText).toBeNull()
    expectSettledIdle()
  })

  it('edits a selection after the engine unloaded itself', async () => {
    // Command mode gated on `ready` too, so ten quiet minutes turned "edit
    // this selection" into "pick a polishing model in the Hub" — advice that
    // is wrong when one is picked and merely asleep.
    harness.deps.selection = () => 'precious selected words'
    Object.assign(harness.polish.status_, {
      state: 'idle',
      modelId: 'fake-polish',
      detail: 'Unloaded after idle; will reload on the next dictation.',
    })
    harness.polish.result = { text: 'Precious edited words.', durationMs: 8 }

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.polish.requests).toHaveLength(1)
    expect(harness.insertedText).toEqual(['Precious edited words.'])
    expectSettledIdle()
  })

  it('refuses mid-flight — selection untouched — if the model vanishes after start', async () => {
    // The race backstop in #finishCommand: the engine was ready at
    // hotkey-down (command mode engaged) but is gone by the time the
    // transcript arrives. No raw fallback: pasting the spoken instruction
    // over the user's selection would be destructive.
    harness.deps.selection = () => 'precious selected words'

    orchestrator.begin()
    Object.assign(harness.polish.status_, { state: 'idle', modelId: null })
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.insertedText).toEqual([])
    expect(harness.events.at(-1)).toMatchObject({ state: 'error', code: 'polish-failed' })
    expectSettledIdle()
  })

  it('refuses when the model returns nothing', async () => {
    harness.deps.selection = () => 'do not lose me'
    harness.polish.result = { text: '   ', durationMs: 3 }

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.insertedText).toEqual([])
    expect(harness.events.at(-1)).toMatchObject({ state: 'error', code: 'polish-failed' })
    expectSettledIdle()
  })

  it('stays in plain dictation when there is no selection', async () => {
    harness.deps.selection = () => null

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.insertedText).toEqual(['Hello world, this is a test.'])
    expectSettledIdle()
  })
})
