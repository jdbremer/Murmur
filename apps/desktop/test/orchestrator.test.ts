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

  it('keeps the capital when the cursor context cannot be read', async () => {
    // The unknown case must never change the text — this is the guard that
    // keeps a platform without the API from mangling every dictation.
    harness.deps.textBeforeCursor = () => null

    orchestrator.begin()
    feed(orchestrator, utterance())
    orchestrator.end()
    await vi.waitFor(() => expect(orchestrator.phase).toBe('idle'))

    expect(harness.insertedText).toEqual(['Hello world, this is a test.'])
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
    harness.deps.applyDictionary = (text) => text.replace('murmer', 'Murmur')
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
    // The polish prompt saw the corrected spelling.
    expect(harness.polish.requests[0]!.userText).toBe('ship Murmur on wednesday please')
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
  it('ignores the key release and auto-finalises on trailing silence', async () => {
    orchestrator.begin({ handsFree: true })
    expect(orchestrator.handsFree).toBe(true)

    feed(orchestrator, speechLike(1200))
    orchestrator.end() // a release must not stop hands-free
    expect(orchestrator.phase).toBe('listening')

    // ~900 ms of quiet crosses the 800 ms auto-finalise threshold.
    feed(orchestrator, roomTone(1000))
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
