import { describe, expect, it } from 'vitest'

import {
  ASK_BUDGET,
  ASK_TITLE_MAX,
  ASK_SYSTEM_PROMPT,
  AskEventSchema,
  buildAskPrompt,
  deriveConversationTitle,
  estimateTokens,
  fitPassages,
  isRefusal,
  parseTimeWindow,
  passageBudgetTokens,
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
  return { id: `${role}-${content.slice(0, 4)}`, role, content, citations: [], createdAt: NOW }
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
    expect(parseTimeWindow('what have I been saying lately', now)?.label).toBe(
      'the last fortnight',
    )
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
    for (const question of ['today', 'yesterday', 'this week', 'last week', 'this month', 'last month', 'lately']) {
      const window = parseTimeWindow(question, now)
      expect(window).not.toBeNull()
      expect(window?.to).toBeGreaterThan(window?.from ?? 0)
    }
  })
})
