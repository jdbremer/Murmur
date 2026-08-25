import { describe, expect, it } from 'vitest'

import {
  ASK_BUDGET,
  ASK_TITLE_MAX,
  RECAP_RECORD_TOKENS,
  batchRecords,
  ASK_SYSTEM_PROMPT,
  AskEventSchema,
  buildAskPrompt,
  describeCoverage,
  deriveConversationTitle,
  estimateTokens,
  fitPassages,
  formatCorpusDigest,
  formatRecapRecord,
  isRefusal,
  parseTimeWindow,
  passageBudgetTokens,
  planAsk,
  suggestedQuestions,
  relativeDay,
  trimHistory,
  truncateToTokens,
  usedCitations,
  type AskPassage,
  type AskTurn,
} from '../src/domain/ask'

/**
 * Ask's context arithmetic (PLAN §2.2.9).
 *
 * These are the tests that matter most in the feature, because the failure they
 * guard against is silent. `llama-server` does not reject an over-long prompt —
 * it evicts the front of it, which is where the grounding rules and the first
 * sources live. The answer still streams back looking perfectly normal, with
 * citations pointing at passages the model never saw.
 */

const DAY = 86_400_000
const NOW = 1_700_000_000_000

function passage(over: Partial<AskPassage> = {}): AskPassage {
  return {
    id: over.id ?? 'd1',
    source: over.source ?? 'dictation',
    title: over.title ?? 'dictated in Slack',
    text: over.text ?? 'The deploy is blocked on the migration.',
    timestamp: over.timestamp ?? NOW - DAY,
    score: over.score ?? 1,
  }
}

function turn(role: 'user' | 'assistant', content: string): AskTurn {
  return {
    id: `${role}-${content.slice(0, 4)}`,
    role,
    content,
    citations: [],
    coverage: '',
    createdAt: NOW,
  }
}

describe('token estimation', () => {
  it('over-estimates rather than under-estimates', () => {
    // The direction of the error is the whole point: guessing low overflows the
    // window, and an overflow is invisible. A real BPE tokenizer puts ordinary
    // English near 4 chars/token, so our 3.6 must always come out higher.
    const text = 'the quick brown fox jumps over the lazy dog and keeps on running'
    expect(estimateTokens(text)).toBeGreaterThan(text.length / 4)
  })

  it('never returns a fraction of a token', () => {
    expect(Number.isInteger(estimateTokens('a'))).toBe(true)
    expect(estimateTokens('')).toBe(0)
  })
})

describe('the budget itself', () => {
  it('leaves headroom below the 4096 the sidecar launches with', () => {
    // `llama-cpp.ts` passes `--ctx-size 4096`. The chat template adds
    // per-message scaffolding this arithmetic cannot see, so the budget has to
    // stop short of the real ceiling rather than exactly at it.
    expect(ASK_BUDGET.contextTokens).toBeLessThan(4096)
    expect(4096 - ASK_BUDGET.contextTokens).toBeGreaterThanOrEqual(256)
  })

  it('reserves the whole context between its four claimants', () => {
    const claimed =
      ASK_BUDGET.answerTokens +
      ASK_BUDGET.systemTokens +
      ASK_BUDGET.historyTokens +
      passageBudgetTokens()
    expect(claimed).toBe(ASK_BUDGET.contextTokens)
  })

  it('reserves enough for the system prompt it actually ships', () => {
    // Guards the reservation against the prompt growing past it — a longer
    // prompt with an unchanged reservation is exactly how the budget starts
    // lying, and nothing else would notice.
    expect(estimateTokens(ASK_SYSTEM_PROMPT)).toBeLessThanOrEqual(ASK_BUDGET.systemTokens)
  })
})

describe('fitPassages', () => {
  it('takes the best-scoring passages first', () => {
    const fitted = fitPassages([
      passage({ id: 'low', score: 0.2 }),
      passage({ id: 'high', score: 0.9 }),
      passage({ id: 'mid', score: 0.5 }),
    ])
    expect(fitted.passages.map((p) => p.id)).toEqual(['high', 'mid', 'low'])
  })

  it('stays inside the passage budget', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      passage({ id: `d${i}`, text: 'word '.repeat(200), score: 1 - i / 200 }),
    )
    const fitted = fitPassages(many)
    expect(fitted.tokens).toBeLessThanOrEqual(passageBudgetTokens())
    expect(fitted.dropped).toBeGreaterThan(0)
  })

  it('skips an oversized passage rather than stopping at it', () => {
    // A single long note near the top must not deny the budget to the shorter,
    // equally relevant passages behind it — stopping at the first passage that
    // does not fit would make one long note look like the only source there is.
    const huge = passage({ id: 'huge', text: 'word '.repeat(5000), score: 0.99 })
    const small = passage({ id: 'small', text: 'short answer', score: 0.98 })
    const fitted = fitPassages([huge, small])
    expect(fitted.passages.map((p) => p.id)).toContain('small')
  })

  it('truncates any single passage to its own cap', () => {
    const fitted = fitPassages([passage({ text: 'word '.repeat(5000) })])
    const kept = fitted.passages[0]
    expect(kept).toBeDefined()
    expect(estimateTokens(kept?.text ?? '')).toBeLessThanOrEqual(ASK_BUDGET.passageTokens)
  })

  it('handles an empty candidate list', () => {
    expect(fitPassages([])).toEqual({ passages: [], dropped: 0, tokens: 0 })
  })
})

describe('truncateToTokens', () => {
  it('leaves short text exactly alone', () => {
    expect(truncateToTokens('short', 100)).toBe('short')
  })

  it('cuts on a word boundary, never mid-word', () => {
    const full = 'alpha beta gamma delta epsilon zeta eta theta'
    const cut = truncateToTokens(full, 4)
    expect(cut.endsWith('…')).toBe(true)

    // The kept text must be a whole-word prefix: the original continues with a
    // space, not with more letters of the last word shown.
    const kept = cut.slice(0, -1)
    expect(full.startsWith(kept)).toBe(true)
    expect(full.charAt(kept.length)).toBe(' ')
  })
})

describe('trimHistory', () => {
  it('keeps the most recent turns', () => {
    const turns = Array.from({ length: 40 }, (_, i) =>
      // Long enough that forty of them cannot fit — with two-character turns
      // the whole conversation fits and the test proves nothing.
      turn(i % 2 ? 'assistant' : 'user', `t${i} ${'word '.repeat(30)}`),
    )
    const kept = trimHistory(turns)
    expect(kept.length).toBeLessThan(turns.length)
    expect(kept.at(-1)?.content).toContain('t39')
  })

  it('never opens on an assistant turn', () => {
    // A history beginning mid-exchange reads to the model as though it answered
    // a question nobody asked, and small models will try to justify it.
    const turns = [turn('user', 'a'.repeat(4000)), turn('assistant', 'answer'), turn('user', 'q2')]
    const kept = trimHistory(turns)
    expect(kept[0]?.role).not.toBe('assistant')
  })

  it('returns nothing when a single turn already blows the budget', () => {
    expect(trimHistory([turn('user', 'x'.repeat(100_000))])).toEqual([])
  })
})

describe('buildAskPrompt', () => {
  it('puts the grounding rules in the system turn and the sources in the user turn', () => {
    // The sidecar runs with `--keep -1`, which pins the system prompt's KV
    // cache across requests. Per-question context in the system turn would
    // invalidate that cache every time and re-prefill the rules on each answer.
    const prompt = buildAskPrompt({ question: 'what broke?', passages: [passage()], now: NOW })
    expect(prompt.messages[0]?.role).toBe('system')
    expect(prompt.messages[0]?.content).toBe(ASK_SYSTEM_PROMPT)
    expect(prompt.messages[0]?.content).not.toContain('deploy is blocked')

    const last = prompt.messages.at(-1)
    expect(last?.role).toBe('user')
    expect(last?.content).toContain('deploy is blocked')
    expect(last?.content).toContain('what broke?')
  })

  it('numbers citations from one, matching the markers in the prompt', () => {
    const prompt = buildAskPrompt({
      question: 'q',
      passages: [passage({ id: 'a' }), passage({ id: 'b' })],
      now: NOW,
    })
    expect(prompt.citations.map((c) => c.index)).toEqual([1, 2])
    expect(prompt.messages.at(-1)?.content).toContain('[1]')
    expect(prompt.messages.at(-1)?.content).toContain('[2]')
  })

  it('still sends a user turn when nothing was found', () => {
    // Told explicitly that the search came back empty. Without a user turn at
    // all the model falls back on pre-training and answers anyway, which is the
    // one behaviour this whole feature is built to prevent.
    const prompt = buildAskPrompt({ question: 'anything?', passages: [], now: NOW })
    expect(prompt.messages.at(-1)?.content).toContain('(none found)')
    expect(prompt.citations).toEqual([])
  })

  it('fits inside the context once history and a full passage set are present', () => {
    const passages = fitPassages(
      Array.from({ length: 40 }, (_, i) =>
        passage({ id: `p${i}`, text: 'word '.repeat(120), score: 1 - i / 100 }),
      ),
    ).passages
    const history = trimHistory(
      Array.from({ length: 30 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', 'word '.repeat(40))),
    )
    const prompt = buildAskPrompt({ question: 'q'.repeat(200), passages, history, now: NOW })
    expect(prompt.estimatedTokens + ASK_BUDGET.answerTokens).toBeLessThanOrEqual(
      ASK_BUDGET.contextTokens,
    )
  })

  it('replays history in order, between the rules and the question', () => {
    const prompt = buildAskPrompt({
      question: 'and then?',
      passages: [passage()],
      history: [turn('user', 'first'), turn('assistant', 'reply')],
      now: NOW,
    })
    expect(prompt.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
  })
})

describe('relativeDay', () => {
  it('speaks the way a person would', () => {
    expect(relativeDay(NOW, NOW)).toBe('today')
    expect(relativeDay(NOW - DAY, NOW)).toBe('yesterday')
    expect(relativeDay(NOW - 3 * DAY, NOW)).toBe('3 days ago')
    expect(relativeDay(NOW - 9 * DAY, NOW)).toBe('last week')
    expect(relativeDay(NOW - 30 * DAY, NOW)).toBe('4 weeks ago')
    expect(relativeDay(NOW - 200 * DAY, NOW)).toBe('6 months ago')
  })

  it('does not produce a negative age for a clock that moved backwards', () => {
    expect(relativeDay(NOW + DAY, NOW)).toBe('today')
  })
})

describe('usedCitations', () => {
  const citations = buildAskPrompt({
    question: 'q',
    passages: [passage({ id: 'a' }), passage({ id: 'b' }), passage({ id: 'c' })],
    now: NOW,
  }).citations

  it('returns only the sources the answer actually cited, in order of use', () => {
    // The model is handed a dozen passages and leans on two. Listing all twelve
    // implies a synthesis that did not happen and buries the one worth opening.
    const used = usedCitations('It was blocked [3], per the earlier note [1].', citations)
    expect(used.map((c) => c.id)).toEqual(['c', 'a'])
  })

  it('ignores a citation number that does not exist', () => {
    // Small models do cite `[9]` out of three. A dead chip is worse than none.
    expect(usedCitations('as noted [9]', citations)).toEqual([])
  })

  it('does not repeat a source cited twice', () => {
    expect(usedCitations('[2] and again [2]', citations)).toHaveLength(1)
  })

  it('returns nothing for an uncited answer', () => {
    expect(usedCitations('I could not find anything about that.', citations)).toEqual([])
  })
})

describe('isRefusal', () => {
  it('recognises the refusal the prompt asks for', () => {
    expect(isRefusal('I could not find anything about that in your notes.')).toBe(true)
    expect(isRefusal("I couldn't find anything about that.")).toBe(true)
    expect(isRefusal('There is no mention of a deadline in your notes.')).toBe(true)
  })

  it('does not mistake an ordinary answer for one', () => {
    expect(isRefusal('You said the deploy was blocked on the migration [1].')).toBe(false)
  })

  it('only looks at the opening, so a hedge at the end is still an answer', () => {
    const answer = `${'You said the deploy was blocked [1]. '.repeat(20)}I could not find more.`
    expect(isRefusal(answer)).toBe(false)
  })
})

describe('the event union', () => {
  it('parses each variant the service emits', () => {
    const conversationId = 'conv-1'
    const events = [
      { type: 'status', conversationId, status: 'searching' },
      { type: 'delta', conversationId, text: 'hi' },
      { type: 'restart', conversationId },
      { type: 'sources', conversationId, citations: [], searched: 0 },
      { type: 'error', conversationId, message: 'nope' },
    ]
    for (const event of events) expect(AskEventSchema.parse(event)).toBeTruthy()
  })

  it('requires the conversation every event belongs to', () => {
    // The pane can change threads while an answer is in flight, and a delta
    // applied to the wrong thread appends one conversation's words to
    // another's answer. An event with no id would be unroutable.
    expect(() => AskEventSchema.parse({ type: 'delta', text: 'hi' })).toThrow()
  })

  it('rejects an unknown variant rather than passing it through', () => {
    expect(() => AskEventSchema.parse({ type: 'whatever' })).toThrow()
  })
})

describe('deriveConversationTitle', () => {
  it('uses the question as typed', () => {
    // Asking the model to name a thread would be a second inference on the
    // critical path of the first answer, and small models produce "Inquiry
    // Regarding Deployment Status" where the user typed six plain words.
    expect(deriveConversationTitle('What is blocking the deploy?')).toBe(
      'What is blocking the deploy',
    )
  })

  it('keeps the leading question word', () => {
    // "What is blocking the deploy" is recognisable in a list at a glance;
    // "blocking the deploy" reads like a status rather than a question asked.
    expect(deriveConversationTitle('Why did QA slip?')).toMatch(/^Why/)
  })

  it('drops trailing punctuation, so a list is not a column of question marks', () => {
    expect(deriveConversationTitle('Where is the venue?!')).toBe('Where is the venue')
    expect(deriveConversationTitle('Book the venue.')).toBe('Book the venue')
  })

  it('cuts a long question at a word boundary', () => {
    const title = deriveConversationTitle(
      'What did everyone agree about the migration and the rollback plan in the meeting last week',
    )
    expect(title.length).toBeLessThanOrEqual(ASK_TITLE_MAX + 1)
    expect(title.endsWith('…')).toBe(true)
    expect(title).not.toMatch(/\s…$/)
  })

  it('collapses newlines from a pasted or dictated question', () => {
    expect(deriveConversationTitle('what did\n\nI say')).toBe('what did I say')
  })

  it('names an empty question rather than producing a blank row', () => {
    expect(deriveConversationTitle('   ')).toBe('New conversation')
  })
})

describe('parseTimeWindow', () => {
  // A Wednesday, mid-afternoon, so "today" has room on both sides of it.
  const now = new Date('2026-08-19T15:30:00').getTime()
  const startOfToday = new Date('2026-08-19T00:00:00').getTime()
  const day = 86_400_000

  it('recognises today and yesterday', () => {
    expect(parseTimeWindow('what did I say today?', now)).toMatchObject({
      from: startOfToday,
      to: startOfToday + day,
      label: 'today',
    })
    expect(parseTimeWindow('anything from yesterday?', now)).toMatchObject({
      from: startOfToday - day,
      to: startOfToday,
    })
  })

  it('uses local midnight, not UTC', () => {
    // A UTC boundary puts an evening dictation into tomorrow, so "what did I
    // say today", asked at 6pm, would return nothing.
    const window = parseTimeWindow('today', now)
    expect(new Date(window?.from ?? 0).getHours()).toBe(0)
  })

  it('separates this week from last week', () => {
    const thisWeek = parseTimeWindow('summarise this week', now)
    const lastWeek = parseTimeWindow('what about last week', now)
    expect(thisWeek?.label).toBe('this week')
    expect(lastWeek?.label).toBe('last week')
    // Adjacent, not overlapping: a result cannot belong to both.
    expect(lastWeek?.to).toBe(thisWeek?.from)
  })

  it('reads the phrasings people actually use', () => {
    expect(parseTimeWindow('over the past week', now)?.label).toBe('this week')
    expect(parseTimeWindow('in the last month', now)?.label).toBe('this month')
    expect(parseTimeWindow('what have I been saying lately', now)?.label).toBe('the last fortnight')
  })

  it('returns nothing when no period is named', () => {
    // The important half. A wrong window silently hides the answer, which is a
    // worse failure than not filtering at all — so anything ambiguous is left
    // alone rather than guessed at.
    expect(parseTimeWindow('what is blocking the deploy?', now)).toBeNull()
    expect(parseTimeWindow('what did I say on the fifth', now)).toBeNull()
    expect(parseTimeWindow('how long is a week', now)).toBeNull()
    expect(parseTimeWindow('weekly report', now)).toBeNull()
  })

  it('never returns an inverted or empty window', () => {
    for (const question of [
      'today',
      'yesterday',
      'this week',
      'last week',
      'this month',
      'last month',
      'lately',
    ]) {
      const window = parseTimeWindow(question, now)
      expect(window).not.toBeNull()
      expect(window?.to).toBeGreaterThan(window?.from ?? 0)
    }
  })
})

describe('planAsk', () => {
  // A Wednesday afternoon, so "today" has room on both sides of it.
  const now = new Date('2026-08-19T15:30:00').getTime()
  const plan = (question: string): ReturnType<typeof planAsk> => planAsk(question, now)

  describe('recap', () => {
    it('routes a summary of a period away from keyword search', () => {
      // The bug this whole router exists for. "Summarize everything I dictated
      // today" is made *entirely* of instruction words, so ranking records by
      // how well they match those words is close to random — and the model
      // then faithfully summarises the one record it was handed.
      for (const question of [
        'Summarize everything I dictated today',
        'summarise my day',
        'give me a recap of this week',
        'What did I work on today?',
        'what did I talk about yesterday',
        'what have I been up to lately',
        'rundown of last week',
      ]) {
        expect(plan(question).intent, question).toBe('recap')
      }
    })

    it('always carries a window, even when the question names none', () => {
      // A recap with no period would enumerate the entire archive.
      const bare = plan('give me a recap')
      expect(bare.intent).toBe('recap')
      expect(bare.window?.label).toBe('today')
    })

    it('uses the period the question actually named', () => {
      expect(plan('summarise this week').window?.label).toBe('this week')
      expect(plan('what did I do yesterday').window?.label).toBe('yesterday')
    })

    it('stays a lookup when the question still has a subject', () => {
      // "Summarise what I said about the migration" has a topic, and the
      // ordinary retrieval path — find the migration, let the model summarise
      // it — is a far better answer than dumping the whole day on the model.
      const scoped = plan('summarise what I said about the migration')
      expect(scoped.intent).toBe('lookup')
      expect(scoped.topic).toContain('migration')
    })

    it('keeps a topic question scoped by time as a lookup', () => {
      // Both a recap verb and a window, but a real subject: the user wants the
      // deadline, filtered to today — not a summary of the whole day.
      const scoped = plan('what did I say about the deadline today?')
      expect(scoped.intent).toBe('lookup')
      expect(scoped.window?.label).toBe('today')
    })
  })

  describe('catalog', () => {
    it('routes questions about what exists away from content search', () => {
      // Searching transcript *text* can never establish whether a transcript
      // *exists*; the answer lives in counts and dates.
      for (const question of [
        'Do I have any meetings that have been transcribed?',
        'how many dictations do I have',
        'are there any notes about this',
        'when did I last record a meeting',
        'list my meetings',
        'what meetings do I have',
        'how long have I recorded in total',
      ]) {
        expect(plan(question).intent, question).toBe('catalog')
      }
    })

    it('notices which kind of thing was asked about', () => {
      expect(plan('do I have any meetings transcribed?').focus).toBe('meeting')
      expect(plan('how many notes do I have').focus).toBe('note')
      expect(plan('how many dictations do I have').focus).toBe('dictation')
    })

    it('leaves focus unset when the question names no kind', () => {
      expect(plan('how many do I have').focus).toBeNull()
    })

    it('wins over recap when a question satisfies both', () => {
      // "How many meetings did I record this week" reads as a recap by its
      // shape, but the answer is a number, not a summary.
      expect(plan('how many meetings did I record this week').intent).toBe('catalog')
    })
  })

  describe('lookup', () => {
    it('stays the default for an ordinary question', () => {
      for (const question of [
        'what is blocking the beta launch?',
        'who owns the rollback plan',
        'where are we holding the offsite',
      ]) {
        expect(plan(question).intent, question).toBe('lookup')
      }
    })

    it('keeps the window a topic question named', () => {
      expect(plan('what did I say about the offsite this week').window?.label).toBe('this week')
    })
  })
})

describe('batchRecords', () => {
  const now = 1_700_000_000_000

  function record(i: number, words = 20): AskPassage {
    return {
      id: `d${i}`,
      source: 'dictation',
      title: 'dictated in Slack',
      text: `record ${i} ${'word '.repeat(words)}`,
      timestamp: now - i * 60_000,
      score: 0,
    }
  }

  it('keeps a normal day in a single pass', () => {
    expect(
      batchRecords(
        Array.from({ length: 12 }, (_, i) => record(i)),
        now,
      ),
    ).toHaveLength(1)
  })

  it('splits a period too large for the context', () => {
    const batches = batchRecords(
      Array.from({ length: 400 }, (_, i) => record(i)),
      now,
    )
    expect(batches.length).toBeGreaterThan(1)
  })

  it('never loses a record', () => {
    // The property the whole map-reduce exists for. Dropping the tail is
    // indistinguishable from a confident, complete-looking, wrong answer.
    const records = Array.from({ length: 400 }, (_, i) => record(i))
    const batched = batchRecords(records, now).flat()
    expect(batched).toHaveLength(records.length)
    expect(batched.map((r) => r.id)).toEqual(records.map((r) => r.id))
  })

  it('keeps each batch inside the context budget', () => {
    for (const batch of batchRecords(
      Array.from({ length: 400 }, (_, i) => record(i)),
      now,
    )) {
      const tokens = batch.reduce((sum, r) => sum + estimateTokens(formatRecapRecord(r, now)), 0)
      expect(tokens).toBeLessThanOrEqual(passageBudgetTokens())
    }
  })

  it('keeps batches contiguous, never sampled', () => {
    // A batch that skips the middle of the afternoon produces a summary with a
    // hole in it that nothing downstream can detect.
    const records = Array.from({ length: 400 }, (_, i) => record(i))
    let cursor = 0
    for (const batch of batchRecords(records, now)) {
      for (const item of batch) expect(item.id).toBe(`d${cursor++}`)
    }
  })

  it('handles an empty period', () => {
    expect(batchRecords([], now)).toEqual([])
  })
})

describe('formatRecapRecord', () => {
  const now = 1_700_000_000_000

  it('leads with the time of day, which is what locates a record in a period', () => {
    const at = new Date('2026-08-19T14:05:00').getTime()
    const line = formatRecapRecord(
      { id: 'd', source: 'dictation', title: 'Slack', text: 'shipped it', timestamp: at, score: 0 },
      now,
    )
    expect(line).toContain('(14:05)')
    expect(line).toContain('shipped it')
    // Not a bullet: the input must not look like the requested output, or a
    // model copies the format back instead of summarising (seen on Granite 4.2).
    expect(line.trimStart().startsWith('-')).toBe(false)
  })

  it('compresses hard, because coverage beats fidelity in a recap', () => {
    const line = formatRecapRecord(
      { id: 'd', source: 'note', title: 'n', text: 'word '.repeat(500), timestamp: now, score: 0 },
      now,
    )
    expect(estimateTokens(line)).toBeLessThan(RECAP_RECORD_TOKENS + 24)
  })
})

describe('describeCoverage', () => {
  const now = 1_700_000_000_000
  const p = (source: AskPassage['source']): AskPassage => ({
    id: Math.random().toString(),
    source,
    title: 't',
    text: 'x',
    timestamp: now,
    score: 0,
  })

  it('says what an answer was actually built from', () => {
    expect(describeCoverage([p('dictation'), p('dictation'), p('meeting')], 'today')).toBe(
      '2 dictations and 1 meeting from today',
    )
  })

  it('lists all three sources readably', () => {
    expect(describeCoverage([p('dictation'), p('note'), p('meeting')], 'this week')).toBe(
      '1 dictation, 1 note and 1 meeting from this week',
    )
  })

  it('is honest about an empty period', () => {
    expect(describeCoverage([], 'yesterday')).toBe('nothing from yesterday')
  })
})

describe('formatCorpusDigest', () => {
  const now = new Date('2026-08-19T15:30:00').getTime()
  const digest = {
    dictations: {
      total: 350,
      today: 12,
      week: 47,
      firstAt: now - 120 * 86_400_000,
      lastAt: now,
      words: 11_247,
    },
    notes: { total: 2, lastAt: now, recent: [{ title: 'Q3 launch plan', at: now }] },
    meetings: {
      total: 1,
      lastAt: now,
      totalMs: 600_000,
      recent: [{ title: 'Design standup', at: now, durationMs: 600_000, indexed: true }],
    },
  }

  it('hands the model exact numbers rather than records to count', () => {
    // A small model given 350 records and asked how many there are will guess.
    // Given the number, it answers correctly every time.
    const text = formatCorpusDigest(digest, now)
    expect(text).toContain('350')
    expect(text).toContain('12 today')
    expect(text).toContain('11,247 words')
  })

  it('names the meetings, so "what meetings do I have" is answerable', () => {
    expect(formatCorpusDigest(digest, now)).toContain('Design standup')
  })

  it('flags a meeting whose transcript has gone missing', () => {
    const broken = {
      ...digest,
      meetings: { ...digest.meetings, recent: [{ ...digest.meetings.recent[0]!, indexed: false }] },
    }
    expect(formatCorpusDigest(broken, now)).toContain('transcript file missing')
  })

  it('says "never" rather than inventing a date for an empty archive', () => {
    const empty = {
      dictations: { total: 0, today: 0, week: 0, firstAt: null, lastAt: null, words: 0 },
      notes: { total: 0, lastAt: null, recent: [] },
      meetings: { total: 0, lastAt: null, totalMs: 0, recent: [] },
    }
    expect(formatCorpusDigest(empty, now)).toContain('never')
  })
})

describe('planAsk with a conversation behind it', () => {
  const now = new Date('2026-08-19T15:30:00').getTime()
  const after = (previous: string, question: string): ReturnType<typeof planAsk> =>
    planAsk(question, now, { previousQuestion: previous })

  it('carries the earlier subject into the search', () => {
    // Retrieval never sees the conversation — only the prompt does. Without
    // this, "who is fixing that?" searches for "fixing", finds whichever
    // record mentions fixing anything, and truthfully reports finding nothing
    // about the thing that was on screen a moment ago.
    const plan = after('What is blocking the beta launch?', 'Who is fixing that?')
    expect(plan.followUp).toBe(true)
    expect(plan.query).toContain('blocking')
    expect(plan.query).toContain('beta')
    // The question itself is untouched; only the search text grows.
    expect(plan.query.startsWith('Who is fixing that?')).toBe(true)
  })

  it('recognises a continuation opener', () => {
    expect(after('Where is the offsite?', 'And who is booking it?').followUp).toBe(true)
    expect(after('Where is the offsite?', 'what else?').followUp).toBe(true)
  })

  it('leaves a self-contained question alone', () => {
    // A new subject must not drag the last one along, or every answer slowly
    // accumulates the whole conversation as search terms.
    const plan = after('What is blocking the beta launch?', 'Where are we holding the offsite?')
    expect(plan.followUp).toBe(false)
    expect(plan.query).toBe('Where are we holding the offsite?')
  })

  it('inherits recap intent for a bare period follow-up', () => {
    // "What about yesterday?" after a recap means recap yesterday. On its own
    // it names no subject at all, so without inheritance it searched for
    // nothing and said so.
    const plan = after('Summarize my day', 'What about yesterday?')
    expect(plan.intent).toBe('recap')
    expect(plan.window?.label).toBe('yesterday')
  })

  it('does not inherit recap for a follow-up that names a subject', () => {
    // "Who owns it?" after a recap is a lookup, not another recap.
    expect(after('Summarize my day', 'Who owns the rollback plan?').intent).toBe('lookup')
  })

  it('lets a question override the inherited intent', () => {
    expect(after('Summarize my day', 'How many meetings do I have?').intent).toBe('catalog')
  })

  it('behaves exactly as before when there is no conversation', () => {
    const plan = planAsk('Who is fixing that?', now, { previousQuestion: null })
    expect(plan.followUp).toBe(false)
    expect(plan.query).toBe('Who is fixing that?')
  })

  it('does not repeat a term the follow-up already has', () => {
    const plan = after('What is blocking the migration?', 'is the migration done?')
    expect(plan.query.match(/migration/g) ?? []).toHaveLength(1)
  })
})

describe('suggestedQuestions', () => {
  const base = {
    dictations: { total: 0, today: 0, week: 0, firstAt: null, lastAt: null, words: 0 },
    notes: { total: 0, lastAt: null, recent: [] },
    meetings: { total: 0, lastAt: null, totalMs: 0, recent: [] },
  }

  it('names a meeting that actually happened', () => {
    // "What did we agree in Design standup?" teaches the feature in a way
    // "…in my last meeting?" cannot, because the reader can tell it is theirs.
    const questions = suggestedQuestions({
      ...base,
      meetings: {
        total: 1,
        lastAt: 1,
        totalMs: 600_000,
        recent: [{ title: 'Design standup', at: 1, durationMs: 600_000, indexed: true }],
      },
    })
    expect(questions.some((q) => q.question.includes('Design standup'))).toBe(true)
  })

  it('offers a recap only when there is something to recap', () => {
    expect(suggestedQuestions(base)).toEqual([])
    const today = { ...base, dictations: { ...base.dictations, total: 3, today: 3 } }
    expect(suggestedQuestions(today)[0]?.question).toBe('Summarise my day')
  })

  it('falls back to the week when today is empty', () => {
    const week = { ...base, dictations: { ...base.dictations, total: 9, today: 0, week: 9 } }
    expect(week.dictations.week).toBe(9)
    expect(suggestedQuestions(week)[0]?.question).toBe('Summarise this week')
  })

  it('counts what it offers, so the hint is never a guess', () => {
    const one = { ...base, dictations: { ...base.dictations, total: 1, today: 1 } }
    expect(suggestedQuestions(one)[0]?.hint).toBe('1 dictation today')
  })

  it('stays scannable', () => {
    const full = {
      dictations: { total: 40, today: 5, week: 20, firstAt: 1, lastAt: 2, words: 900 },
      notes: { total: 3, lastAt: 2, recent: [{ title: 'Plan', at: 2 }] },
      meetings: {
        total: 2,
        lastAt: 2,
        totalMs: 100,
        recent: [{ title: 'Standup', at: 2, durationMs: 100, indexed: true }],
      },
    }
    expect(suggestedQuestions(full).length).toBeLessThanOrEqual(3)
  })
})
