import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Database } from 'better-sqlite3'
import type { AskEvent, AskTurn, EngineStatus } from '@murmur/shared'

import { AskService, MAX_PREEMPT_RETRIES } from '../src/main/ask/service'
import { PreemptedError } from '../src/main/engines/gate'
import type { EngineChatEnd, EngineChatRequest, PolishEngine } from '../src/main/engines/types'
import { createNullLogger } from '../src/main/logging'
import { databasePath, openDatabase } from '../src/main/store/db'
import { AskRepository, DictationsRepository } from '../src/main/store/repositories'
import { RetrievalRepository } from '../src/main/store/retrieval'

/**
 * The Ask orchestrator (PLAN §2.2.9).
 *
 * The behaviour worth the most care is what happens when a dictation arrives
 * mid-answer. Dictation preempting chat is the whole reason the gate exists,
 * and the service is what makes it survivable: a preemption has to restart the
 * answer while a cancel has to stay cancelled, and the two reach this code as
 * the same `AbortError` distinguished only by the abort *reason*. Confusing
 * them either strands a cancelled answer in a retry loop or silently drops one
 * that a dictation merely interrupted.
 */

const NOW = 1_700_000_000_000
const log = createNullLogger()

let directory: string
let db: Database
let events: AskEvent[]
let dictations: DictationsRepository
let store: AskRepository
let service: AskService

/** A stand-in engine whose streaming behaviour each test scripts. */
class FakeEngine implements PolishEngine {
  readonly id = 'llama-cpp' as const
  calls = 0
  script: (attempt: number, request: EngineChatRequest) => AsyncGenerator<string, EngineChatEnd>
  state: EngineStatus['state'] = 'ready'
  lastMessages: EngineChatRequest['messages'] = []

  constructor(script?: FakeEngine['script']) {
    this.script =
      script ??
      async function* () {
        yield 'ok'
        return { truncated: false }
      }
  }

  streamChat(request: EngineChatRequest): AsyncGenerator<string, EngineChatEnd> {
    this.lastMessages = request.messages
    return this.script(this.calls++, request)
  }

  status(): EngineStatus {
    return {
      state: this.state,
      engine: 'llama-cpp',
      modelId: 'qwen3-1.7b',
      reason: null,
      detail: '',
      warnings: [],
    }
  }

  load(): Promise<void> {
    return Promise.resolve()
  }
  polish(): never {
    throw new Error('not used')
  }
  unload(): Promise<void> {
    return Promise.resolve()
  }
  dispose(): Promise<void> {
    return Promise.resolve()
  }
  onStatusChange(): () => void {
    return () => undefined
  }
}

let engine: FakeEngine | null

function build(): AskService {
  return new AskService({
    retrieval: new RetrievalRepository(db, { now: () => NOW, log }),
    store,
    engine: () => engine,
    emit: (event) => events.push(event),
    now: () => NOW,
    log,
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'murmur-ask-svc-'))
  db = openDatabase(databasePath(directory), { log }).db
  dictations = new DictationsRepository(db)
  store = new AskRepository(db)
  events = []
  engine = new FakeEngine()
  service = build()

  dictations.insert({
    ts: NOW - 86_400_000,
    rawText: 'The migration is blocked on the schema change.',
    polishedText: null,
    appBundleId: 'com.tinyspeck.slackmacgap',
    appName: 'Slack',
    appCategory: 'work',
    durationMs: 1000,
    sttModelId: 'whisper-small',
    polishModelId: null,
    timings: { sttMs: 200, polishMs: 0, totalMs: 400 },
  })
})

afterEach(() => {
  try {
    db.close()
  } catch {
    /* already closed */
  }
  rmSync(directory, { recursive: true, force: true })
})

/** The active conversation's turns — what the pane would render. */
const activeTurns = (): AskTurn[] => {
  const id = service.state().activeId
  return id ? store.turns(id) : []
}

const kinds = (): string[] => events.map((event) => event.type)
const deltas = (): string =>
  events.flatMap((event) => (event.type === 'delta' ? [event.text] : [])).join('')
const statuses = (): string[] =>
  events.flatMap((event) => (event.type === 'status' ? [event.status] : []))

async function* say(...parts: string[]): AsyncGenerator<string, EngineChatEnd> {
  for (const part of parts) yield part
  return { truncated: false }
}

describe('AskService', () => {
  it('stores the question, grounds the answer, and stores it back', async () => {
    engine = new FakeEngine(() => say('The migration ', 'is blocked [1].'))
    service = build()

    await service.ask({
      question: 'what is blocking the migration?',
      conversationId: null,
      sources: [],
    })

    expect(kinds()).toEqual([
      'question',
      'status',
      'sources',
      'status',
      'delta',
      'delta',
      'status',
      'done',
    ])
    expect(deltas()).toBe('The migration is blocked [1].')

    const stored = activeTurns()
    expect(stored.map((t) => t.role)).toEqual(['user', 'assistant'])
    expect(stored[1]?.content).toBe('The migration is blocked [1].')
  })

  it('cites only the sources the answer used', async () => {
    engine = new FakeEngine(() => say('Blocked on the schema change [1].'))
    service = build()
    await service.ask({ question: 'migration', conversationId: null, sources: [] })

    const answer = activeTurns()[1]
    expect(answer?.citations).toHaveLength(1)
    expect(answer?.citations[0]?.source).toBe('dictation')
    expect(answer?.citations[0]?.index).toBe(1)
  })

  it('records no citations when the model declines to answer', async () => {
    engine = new FakeEngine(() => say('I could not find anything about that in your notes.'))
    service = build()
    await service.ask({ question: 'pineapple', conversationId: null, sources: [] })
    expect(activeTurns()[1]?.citations).toEqual([])
  })

  it('answers even when retrieval finds nothing', async () => {
    engine = new FakeEngine(() => say('I could not find anything about that in your notes.'))
    service = build()
    await service.ask({ question: 'zzzznonexistent', conversationId: null, sources: [] })

    const sources = events.find((event) => event.type === 'sources')
    expect(sources).toMatchObject({ searched: 0, citations: [] })
    expect(engine.lastMessages.at(-1)?.content).toContain('(none found)')
  })

  it('does not show the model the question twice', async () => {
    // The new question is already the prompt's final user turn. Replaying it in
    // the history as well invites the model to answer the earlier copy.
    await service.ask({ question: 'first question', conversationId: null, sources: [] })
    events = []
    await service.ask({ question: 'second question', conversationId: null, sources: [] })

    const asUser = engine?.lastMessages.filter((m) => m.content.includes('second question')) ?? []
    expect(asUser).toHaveLength(1)
  })

  it('carries earlier turns into the next question in the same thread', async () => {
    engine = new FakeEngine(() => say('Thursday.'))
    service = build()
    await service.ask({ question: 'when is the migration?', conversationId: null, sources: [] })

    const id = service.state().activeId
    expect(id).toBeTruthy()
    await service.ask({ question: 'and who signs it off?', conversationId: id, sources: [] })

    const roles = engine.lastMessages.map((m) => m.role)
    expect(roles[0]).toBe('system')
    // The follow-up sees the earlier exchange — that is what makes "and who
    // signs it off?" answerable at all.
    expect(roles).toContain('assistant')
  })

  it('starts a fresh thread with no history when asked from blank', async () => {
    // The other half of the same property: a new conversation must not inherit
    // the last one's context, or an unrelated question gets answered in terms
    // of whatever was on screen before it.
    engine = new FakeEngine(() => say('Thursday.'))
    service = build()
    await service.ask({ question: 'when is the migration?', conversationId: null, sources: [] })
    const first = service.state().activeId

    await service.ask({ question: 'unrelated question', conversationId: null, sources: [] })
    expect(service.state().activeId).not.toBe(first)
    expect(engine.lastMessages.map((m) => m.role)).toEqual(['system', 'user'])
  })

  describe('when a dictation takes the model', () => {
    it('restarts the answer and tells the renderer to clear the partial one', async () => {
      engine = new FakeEngine((attempt) =>
        attempt === 0
          ? (async function* (): AsyncGenerator<string, EngineChatEnd> {
              yield 'half an ans'
              throw new PreemptedError()
            })()
          : say('the whole answer'),
      )
      service = build()
      await service.ask({ question: 'migration', conversationId: null, sources: [] })

      expect(kinds()).toContain('restart')
      expect(statuses()).toContain('paused')
      // The stored answer is the complete rerun, never the two concatenated.
      expect(activeTurns()[1]?.content).toBe('the whole answer')
      expect(engine.calls).toBe(2)
    })

    it('emits the restart before any delta of the new answer', async () => {
      // The renderer clears its buffer on `restart`. A delta arriving first
      // would be wiped, and the answer would open mid-sentence.
      engine = new FakeEngine((attempt) =>
        attempt === 0
          ? (async function* (): AsyncGenerator<string, EngineChatEnd> {
              yield 'partial'
              throw new PreemptedError()
            })()
          : say('fresh'),
      )
      service = build()
      await service.ask({ question: 'migration', conversationId: null, sources: [] })

      const order = events.flatMap((e) =>
        e.type === 'restart' ? ['restart'] : e.type === 'delta' ? [e.text] : [],
      )
      expect(order).toEqual(['partial', 'restart', 'fresh'])
    })

    it('gives up rather than restarting forever', async () => {
      // Someone dictating steadily could restart an answer indefinitely. A pane
      // that flickers for ever is worse than one that says it gave way.
      engine = new FakeEngine(() =>
        (async function* (): AsyncGenerator<string, EngineChatEnd> {
          yield 'x'
          throw new PreemptedError()
        })(),
      )
      service = build()
      await service.ask({ question: 'migration', conversationId: null, sources: [] })

      expect(engine.calls).toBe(MAX_PREEMPT_RETRIES + 1)
      const error = events.find((event) => event.type === 'error')
      expect(error).toMatchObject({ type: 'error' })
      expect(statuses().at(-1)).toBe('error')
    })
  })

  describe('cancellation', () => {
    it('stops for good rather than retrying', async () => {
      // A cancel and a preemption both arrive as an abort. Only the reason
      // tells them apart, and only one of them is allowed to restart.
      engine = new FakeEngine(() =>
        (async function* (): AsyncGenerator<string, EngineChatEnd> {
          yield 'starting'
          service.cancel()
          const error = new Error('Cancelled')
          error.name = 'AskCancelledError'
          throw error
        })(),
      )
      service = build()
      await service.ask({ question: 'migration', conversationId: null, sources: [] })

      expect(engine.calls).toBe(1)
      expect(kinds()).not.toContain('error')
      expect(kinds()).not.toContain('done')
      expect(statuses().at(-1)).toBe('idle')
    })

    it('keeps the question but stores no answer', async () => {
      engine = new FakeEngine(() =>
        (async function* (): AsyncGenerator<string, EngineChatEnd> {
          service.cancel()
          const error = new Error('Cancelled')
          error.name = 'AskCancelledError'
          throw error

          yield ''
        })(),
      )
      service = build()
      await service.ask({ question: 'migration', conversationId: null, sources: [] })
      expect(activeTurns().map((t) => t.role)).toEqual(['user'])
    })

    it('replaces an answer already in flight when a new question arrives', async () => {
      let aborted = false
      engine = new FakeEngine((attempt, request) => {
        if (attempt === 0) {
          request.signal.addEventListener('abort', () => {
            aborted = true
          })
        }
        return say('answer')
      })
      service = build()

      const first = service.ask({ question: 'one', conversationId: null, sources: [] })
      const second = service.ask({ question: 'two', conversationId: null, sources: [] })
      await Promise.all([first, second])
      expect(aborted || engine.calls === 2).toBe(true)
    })
  })

  describe('when Ask cannot run', () => {
    it('says so instead of failing silently when no engine exists', async () => {
      engine = null
      service = build()
      await service.ask({ question: 'anything', conversationId: null, sources: [] })

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'error' })
      // No question is stored: a thread showing a question that was never even
      // sent reads as an answer still loading.
      expect(activeTurns()).toEqual([])
    })

    it('reports the engine detail when the model is unavailable', async () => {
      engine = new FakeEngine()
      engine.state = 'unavailable'
      service = build()

      expect(service.state().unavailable).toBeTruthy()
    })

    it('treats an idle-unloaded model as available, because the next call wakes it', async () => {
      // Idle covers "never loaded" and "unloaded after ten minutes". The second
      // is normal and recoverable, and must not read as an error.
      engine = new FakeEngine()
      engine.state = 'idle'
      service = build()

      expect(service.state().unavailable).toBeNull()
      await service.ask({ question: 'migration', conversationId: null, sources: [] })
      expect(kinds()).toContain('done')
    })

    it('rejects an engine with no chat capability', () => {
      // Built by hand rather than by deleting the method off a FakeEngine:
      // `streamChat` lives on the prototype, so `delete instance.streamChat` is
      // a no-op and the test would pass against an engine that still has it.
      const base = new FakeEngine()
      const chatless: PolishEngine = {
        id: base.id,
        load: () => base.load(),
        polish: () => base.polish(),
        unload: () => base.unload(),
        dispose: () => base.dispose(),
        status: () => base.status(),
        onStatusChange: () => base.onStatusChange(),
      }
      engine = chatless as unknown as FakeEngine
      service = build()
      expect(service.state().unavailable).toMatch(/cannot answer/i)
    })
  })

  it('ignores an empty question', async () => {
    await service.ask({ question: '   ', conversationId: null, sources: [] })
    expect(events).toEqual([])
    expect(activeTurns()).toEqual([])
  })

  it('reports the corpus it can search', () => {
    expect(service.state().counts).toEqual({ dictations: 1, notes: 0, meetings: 0 })
  })

  it('clears the conversation without touching what it cited', async () => {
    await service.ask({ question: 'migration', conversationId: null, sources: [] })
    expect(activeTurns()).toHaveLength(2)

    service.clear()
    expect(activeTurns()).toEqual([])
    // The dictation the answer cited is untouched: Ask reads history, it does
    // not own it.
    expect(dictations.query({ search: '', limit: 10, offset: 0 }).total).toBe(1)
  })

  it('surfaces an engine failure as an error in the thread', async () => {
    engine = new FakeEngine(() =>
      (async function* (): AsyncGenerator<string, EngineChatEnd> {
        throw new Error('llama-server is not ready')

        yield ''
      })(),
    )
    service = build()
    await service.ask({ question: 'migration', conversationId: null, sources: [] })

    expect(events.at(-1)).toMatchObject({ type: 'error', message: 'llama-server is not ready' })
    expect(service.state().status).toBe('error')
  })

  describe('routing by question type', () => {
    /** Everything the model was shown on the last call. */
    const prompt = (): string => (engine?.lastMessages ?? []).map((m) => m.content).join('\n')

    it('summarises the whole day rather than one dictation', () => {
      // The reported bug, as a test. Twelve dictations today; the old path
      // ranked them by keyword against a question made only of instruction
      // words and handed the model whichever one happened to match.
      const day: string[] = []
      for (let i = 0; i < 12; i += 1) {
        const text = `thing number ${i} happened`
        day.push(text)
        dictations.insert({
          ts: NOW - i * 1800_000,
          rawText: text,
          polishedText: null,
          appBundleId: null,
          appName: 'Slack',
          appCategory: 'work',
          durationMs: 1000,
          sttModelId: 'whisper-small',
          polishModelId: null,
          timings: { sttMs: 200, polishMs: 0, totalMs: 400 },
        })
      }

      return service
        .ask({ question: 'Summarize everything I dictated today', conversationId: null, sources: [] })
        .then(() => {
          const shown = prompt()
          for (const text of day) expect(shown).toContain(text)
        })
    })

    it('tells the reader how much the recap actually read', () => {
      // A recap has no per-claim citations, so this line is the only thing
      // between the reader and taking its completeness on faith.
      dictations.insert({
        ts: NOW - 3600_000,
        rawText: 'something today',
        polishedText: null,
        appBundleId: null,
        appName: null,
        appCategory: 'work',
        durationMs: 1000,
        sttModelId: 'whisper-small',
        polishModelId: null,
        timings: { sttMs: 200, polishMs: 0, totalMs: 400 },
      })

      return service
        .ask({ question: 'summarise my day', conversationId: null, sources: [] })
        .then(() => {
          const sources = events.find((e) => e.type === 'sources')
          expect(sources).toMatchObject({ coverage: expect.stringContaining('from today') })
        })
    })

    it('says so plainly when a period is empty', () => {
      // "last week" here means 13–6 days back, and the only seeded record is
      // from yesterday — so the period really is empty.
      return service
        .ask({ question: 'what did I do last week', conversationId: null, sources: [] })
        .then(() => {
          expect(activeTurns().at(-1)?.content).toMatch(/nothing recorded from last week/i)
        })
    })

    it('answers a catalogue question from counts, not from passages', () => {
      // The other reported bug: "do I have any meetings transcribed?" refused,
      // because it was searched as though it were a topic.
      return service
        .ask({
          question: 'Do I have any meetings that have been transcribed?',
          conversationId: null,
          sources: [],
        })
        .then(() => {
          const shown = prompt()
          expect(shown).toContain('Inventory:')
          expect(shown).toContain('Meetings:')
          // The whole dictation corpus is summarised as a count, not pasted in.
          expect(shown).toContain('Dictations: 1')
        })
    })

    it('still uses keyword retrieval for an ordinary question', () => {
      return service
        .ask({ question: 'what is blocking the migration?', conversationId: null, sources: [] })
        .then(() => {
          expect(prompt()).toContain('Sources:')
          expect(prompt()).not.toContain('Inventory:')
        })
    })

    it('does not stream the working passes of a long recap', async () => {
      // A recap too large for one context is summarised in batches. Streaming
      // those partials would read as the answer restarting several times.
      for (let i = 0; i < 220; i += 1) {
        dictations.insert({
          ts: NOW - (i % 20) * 1800_000,
          rawText: `record ${i} ${'word '.repeat(40)}`,
          polishedText: null,
          appBundleId: null,
          appName: null,
          appCategory: 'work',
          durationMs: 1000,
          sttModelId: 'whisper-small',
          polishModelId: null,
          timings: { sttMs: 200, polishMs: 0, totalMs: 400 },
        })
      }

      let call = 0
      engine = new FakeEngine(() => {
        call += 1
        return say(`summary ${call}`)
      })
      service = build()
      await service.ask({ question: 'summarise my day', conversationId: null, sources: [] })

      // Several passes ran, but only the final merge reached the renderer.
      expect(call).toBeGreaterThan(1)
      expect(deltas()).toBe(`summary ${call}`)
      expect(activeTurns().at(-1)?.content).toBe(`summary ${call}`)
    })
  })

  describe('turn storage', () => {
    /** A conversation to hang turns on, independent of the service. */
    const thread = (): string => store.create('fixture', NOW).id

    it('keeps a question above its answer when both land in the same millisecond', () => {
      // The regression this ordering was written for. A short or cached answer
      // routinely shares a millisecond with its question, leaving `created_at`
      // tied — and a UUID tiebreak resolves that tie at random, so half the
      // time the thread renders the answer above the question that prompted it.
      for (let i = 0; i < 30; i += 1) {
        const id = thread()
        store.append(id, { role: 'user', content: `q${i}`, citations: [], coverage: '', createdAt: NOW })
        store.append(id, { role: 'assistant', content: `a${i}`, citations: [], coverage: '', createdAt: NOW })
        expect(store.turns(id).map((t) => t.role)).toEqual(['user', 'assistant'])
      }
    })

    it('keeps the end of a long conversation, not its beginning', () => {
      const id = thread()
      for (let i = 0; i < 20; i += 1) {
        store.append(id, { role: 'user', content: `q${i}`, citations: [], coverage: '', createdAt: NOW + i })
      }
      const kept = store.turns(id, 5)
      expect(kept).toHaveLength(5)
      expect(kept.at(-1)?.content).toBe('q19')
      expect(kept[0]?.content).toBe('q15')
    })

    it('survives a citations column that is not valid JSON', () => {
      // A turn whose citations fail to parse still has an answer worth showing;
      // losing the whole conversation to one bad row would be far worse.
      const id = thread()
      const turn = store.append(id, {
        role: 'assistant',
        content: 'still readable',
        citations: [],
        coverage: '',
        createdAt: NOW,
      })
      db.prepare(`UPDATE ask_turns SET citations = '{oops' WHERE id = ?`).run(turn.id)
      expect(store.turns(id)[0]).toMatchObject({ content: 'still readable', citations: [] })
    })

    it('marks the conversation used whenever a turn lands', () => {
      // A thread that answered you and then sank to the bottom of the list is
      // the bug this guards: the list sorts on `updated_at`.
      const id = store.create('fixture', NOW).id
      store.append(id, { role: 'user', content: 'q', citations: [], coverage: '', createdAt: NOW + 5_000 })
      expect(store.get(id)?.updatedAt).toBe(NOW + 5_000)
    })

    it('deletes a conversation together with its turns', () => {
      const id = thread()
      store.append(id, { role: 'user', content: 'q', citations: [], coverage: '', createdAt: NOW })
      store.delete(id)
      expect(store.turns(id)).toEqual([])
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ask_turns`).get() as { n: number }).n).toBe(0)
    })
  })

  describe('conversations', () => {
    it('names a new thread from the question that started it', async () => {
      await service.ask({
        question: 'What is blocking the beta launch?',
        conversationId: null,
        sources: [],
      })
      expect(service.state().conversations[0]?.title).toBe('What is blocking the beta launch')
    })

    it('reopens on the most recent thread rather than a blank pane', () => {
      // Coming back to the Hub should land where you left off.
      const older = store.create('older', NOW - 10_000)
      const newer = store.create('newer', NOW)
      store.append(older.id, { role: 'user', content: 'a', citations: [], coverage: '', createdAt: NOW - 10_000 })
      store.append(newer.id, { role: 'user', content: 'b', citations: [], coverage: '', createdAt: NOW })

      expect(build().state().activeId).toBe(newer.id)
    })

    it('orders the list by when each was last used, not when it was made', () => {
      const older = store.create('older', NOW - 100_000)
      store.create('newer', NOW - 50_000)
      store.append(older.id, { role: 'user', content: 'revived', citations: [], coverage: '', createdAt: NOW })

      expect(service.state().conversations[0]?.id).toBe(older.id)
    })

    it('opens another thread and shows its turns', async () => {
      await service.ask({ question: 'first thread', conversationId: null, sources: [] })
      const first = service.state().activeId ?? ''
      await service.ask({ question: 'second thread', conversationId: null, sources: [] })

      const reopened = service.open(first)
      expect(reopened.activeId).toBe(first)
      expect(reopened.turns[0]?.content).toBe('first thread')
    })

    it('cancels an answer in flight when the thread changes under it', async () => {
      // The answer belongs to the thread that asked for it. Letting it finish
      // would append it to whatever the user switched to.
      let aborted = false
      engine = new FakeEngine((_attempt, request) => {
        request.signal.addEventListener('abort', () => {
          aborted = true
        })
        return say('answer')
      })
      service = build()
      await service.ask({ question: 'a question', conversationId: null, sources: [] })

      service.open(store.create('other', NOW).id)
      expect(aborted || service.state().status === 'idle').toBe(true)
    })

    it('drops a thread that was opened but never used', async () => {
      // A "New" click the user thought better of should not leave a row behind.
      await service.ask({ question: 'a real question', conversationId: null, sources: [] })
      const real = service.state().activeId
      const abandoned = store.create('', NOW)

      service.open(real)
      expect(store.get(abandoned.id)).toBeNull()
      expect(service.state().conversations).toHaveLength(1)
    })

    it('keeps the thread being looked at, even while it is still empty', () => {
      // The pruning must not delete the blank thread the user is typing into.
      const fresh = store.create('', NOW)
      expect(service.open(fresh.id).activeId).toBe(fresh.id)
      expect(store.get(fresh.id)).not.toBeNull()
    })

    it('renames a thread', async () => {
      await service.ask({ question: 'original question', conversationId: null, sources: [] })
      const id = service.state().activeId ?? ''
      expect(service.rename(id, 'Launch blockers')?.title).toBe('Launch blockers')
      expect(service.state().conversations[0]?.title).toBe('Launch blockers')
    })

    it('deletes one thread and moves to what is left', async () => {
      await service.ask({ question: 'keep this one', conversationId: null, sources: [] })
      const keep = service.state().activeId ?? ''
      await service.ask({ question: 'delete this one', conversationId: null, sources: [] })
      const drop = service.state().activeId ?? ''

      const after = service.delete(drop)
      expect(after.conversations.map((c) => c.id)).toEqual([keep])
      expect(after.activeId).toBe(keep)
    })

    it('clears every thread without touching what they cited', async () => {
      await service.ask({ question: 'migration', conversationId: null, sources: [] })
      const cleared = service.clear()

      expect(cleared.conversations).toEqual([])
      expect(cleared.turns).toEqual([])
      // Ask reads history; it does not own it.
      expect(dictations.query({ search: '', limit: 10, offset: 0 }).total).toBe(1)
    })
  })

  describe('searching previous conversations', () => {
    async function seed(): Promise<void> {
      engine = new FakeEngine(() => say('Priya owns the rollback plan.'))
      service = build()
      await service.ask({
        question: 'who owns the rollback plan?',
        conversationId: null,
        sources: [],
      })
      engine.script = () => say('The offsite is in Lisbon.')
      await service.ask({ question: 'where is the offsite?', conversationId: null, sources: [] })
    }

    it('finds a thread by a word from the question', async () => {
      await seed()
      const hits = service.search('rollback')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.conversation.title).toBe('who owns the rollback plan')
    })

    it('finds a thread by a word from the answer', async () => {
      // The whole point of searching turns rather than titles: weeks later the
      // thing anyone remembers is a phrase from the answer.
      await seed()
      const hits = service.search('Lisbon')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.role).toBe('assistant')
      expect(hits[0]?.snippet).toContain('Lisbon')
    })

    it('returns one hit per conversation, however many turns matched', async () => {
      // Eight rows for one thread buries the seven others that also matched.
      const id = store.create('rollback thread', NOW).id
      for (let i = 0; i < 8; i += 1) {
        store.append(id, {
          role: 'user',
          content: `rollback question ${i}`,
          citations: [],
          coverage: '',
          createdAt: NOW + i,
        })
      }
      expect(service.search('rollback')).toHaveLength(1)
    })

    it('comes back empty rather than throwing on nonsense', async () => {
      await seed()
      expect(service.search('zzzznothing')).toEqual([])
      expect(service.search('"')).toEqual([])
      expect(service.search('')).toEqual([])
      expect(service.search('NEAR(')).toEqual([])
    })

    it('stops finding a conversation once it is deleted', async () => {
      // The FTS index is external-content: a missing delete trigger would leave
      // it returning conversations whose rows are gone.
      await seed()
      const hit = service.search('rollback')[0]
      service.delete(hit?.conversation.id ?? '')
      expect(service.search('rollback')).toEqual([])
    })
  })

  describe('questions that name a period', () => {
    it('says which period it searched', async () => {
      await service.ask({ question: 'what did I say today?', conversationId: null, sources: [] })
      const searching = events.find(
        (event) => event.type === 'status' && event.status === 'searching',
      )
      expect(searching).toMatchObject({ window: 'today' })
    })

    it('leaves the window empty when the question names no period', async () => {
      await service.ask({ question: 'what is blocking it?', conversationId: null, sources: [] })
      const searching = events.find(
        (event) => event.type === 'status' && event.status === 'searching',
      )
      expect(searching).toMatchObject({ window: '' })
    })
  })

  it('restores the whole conversation from disk', async () => {
    await service.ask({ question: 'migration', conversationId: null, sources: [] })
    const reopened = build()
    expect(reopened.state().turns.map((t) => t.role)).toEqual(['user', 'assistant'])
  })
})
