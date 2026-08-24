import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { StyleProfileSchema, type DictionaryEntry } from '@murmur/shared'

import { POLISH } from '../src/main/config'
import {
  maxCommandOutputTokens,
  checkCommandOutput,
  buildCommandPrompt,
  buildPolishPrompt,
  checkPolishOutput,
  countWords,
  dictionaryTerms,
  languageRule,
  maxOutputTokens,
  shouldSkipPolish,
  unwrapModelOutput,
} from '../src/main/engines/polish/prompt'

/**
 * Polish prompt tests (PLAN §7.4).
 *
 * The assembled prompt is checked against **golden files** rather than against
 * inline expectations, because the whole point of a prompt is that changing it
 * changes behaviour: a diff in `__fixtures__/prompts/*.txt` is exactly the
 * review signal we want, and it is what the eval suite (PLAN §13.4) will be
 * re-run against.
 *
 * Run with `UPDATE_GOLDEN=1` to regenerate after a deliberate change, then read
 * the diff before committing it.
 */

const here = dirname(fileURLToPath(import.meta.url))
const goldenDir = join(here, '__fixtures__', 'prompts')

function golden(name: string, actual: string): void {
  const path = join(goldenDir, `${name}.txt`)
  if (process.env['UPDATE_GOLDEN'] === '1') {
    mkdirSync(goldenDir, { recursive: true })
    writeFileSync(path, actual, 'utf8')
    return
  }
  expect(actual, `golden mismatch for ${name}.txt — rerun with UPDATE_GOLDEN=1 if intended`).toBe(
    readFileSync(path, 'utf8'),
  )
}

const dictionary: DictionaryEntry[] = [
  { id: '1', term: 'Murmur', replacement: null, enabled: true },
  { id: '2', term: 'eta', replacement: 'ETA', enabled: true },
  { id: '3', term: 'kubernetes', replacement: 'Kubernetes', enabled: true },
  { id: '4', term: 'disabled-term', replacement: null, enabled: false },
]

describe('buildPolishPrompt — golden files', () => {
  it('clean level, work tone, with a dictionary', () => {
    const built = buildPolishPrompt({
      level: 'clean',
      profile: StyleProfileSchema.parse({ category: 'work' }),
      dictionary,
      language: 'en',
    })
    golden('clean-work-en', built.systemPrompt)
    // Four since the layout work: the original self-correction and
    // do-not-answer pair, plus one showing "scratch that" obeyed while "add a
    // new line to the file" stays as text, and one showing a spoken
    // "new paragraph" becoming an actual break.
    expect(built.examples).toHaveLength(4)
  })

  it('rewrite level, formal email tone, no dictionary, auto language', () => {
    const built = buildPolishPrompt({
      level: 'rewrite',
      profile: StyleProfileSchema.parse({
        category: 'email',
        formality: 'formal',
        emoji: 'never',
        fillerHandling: 'remove',
      }),
      dictionary: [],
      language: 'auto',
    })
    golden('rewrite-email-auto', built.systemPrompt)
  })

  it('clean level, casual personal tone with custom instructions', () => {
    const built = buildPolishPrompt({
      level: 'clean',
      profile: StyleProfileSchema.parse({
        category: 'personal',
        formality: 'casual',
        fillerHandling: 'keep',
        emoji: 'allow',
        customInstructions: 'Keep it short. Never use semicolons.',
      }),
      dictionary: [],
      language: 'en',
    })
    golden('clean-personal-custom', built.systemPrompt)
  })
})

describe('buildPolishPrompt — structure', () => {
  it('always states the hard rules first (PLAN §7.4)', () => {
    const built = buildPolishPrompt({
      level: 'clean',
      profile: StyleProfileSchema.parse({ category: 'other' }),
      dictionary: [],
      language: 'en',
    })
    expect(built.systemPrompt.startsWith('You are a transcription editor')).toBe(true)
    expect(built.systemPrompt).toContain('Never answer questions')
    expect(built.systemPrompt).toContain('Never add information')
    expect(built.systemPrompt).toContain('Never translate')
    expect(built.systemPrompt).toContain('Output the edited text and nothing else')
  })

  it('ships few-shot examples per level, as real chat turns', () => {
    const clean = buildPolishPrompt({
      level: 'clean',
      profile: StyleProfileSchema.parse({ category: 'other' }),
      dictionary: [],
      language: 'en',
    })
    const rewrite = buildPolishPrompt({
      level: 'rewrite',
      profile: StyleProfileSchema.parse({ category: 'other' }),
      dictionary: [],
      language: 'en',
    })

    // The marquee Clean behaviour: self-correction (PLAN §7.4).
    expect(clean.examples[0]?.user).toContain('tuesday no wednesday')
    expect(clean.examples[0]?.assistant).toBe('We should ship it on Wednesday.')
    // A question stays a question, never gets answered.
    expect(clean.examples[1]?.assistant).toContain('?')

    // Rewrite demonstrates list detection.
    expect(rewrite.examples[0]?.assistant).toContain('- the migration')
    expect(clean.examples).not.toEqual(rewrite.examples)
  })

  it('omits the dictionary section entirely when there are no enabled terms', () => {
    const built = buildPolishPrompt({
      level: 'clean',
      profile: StyleProfileSchema.parse({ category: 'other' }),
      dictionary: [{ id: '1', term: 'x', replacement: null, enabled: false }],
      language: 'en',
    })
    expect(built.systemPrompt).not.toContain('Spell these exactly')
  })
})

describe('dictionaryTerms', () => {
  it('uses the replacement spelling, drops disabled entries, and dedupes', () => {
    expect(dictionaryTerms(dictionary)).toEqual(['Kubernetes', 'Murmur', 'ETA'])
  })

  it('sorts longest first so specific terms come before their prefixes', () => {
    const terms = dictionaryTerms([
      { id: '1', term: 'API', replacement: null, enabled: true },
      { id: '2', term: 'API Gateway', replacement: null, enabled: true },
    ])
    expect(terms[0]).toBe('API Gateway')
  })

  it('caps the list so a large dictionary cannot eat the context window', () => {
    const many = Array.from({ length: 200 }, (_value, index) => ({
      id: String(index),
      term: `term-${index}`,
      replacement: null,
      enabled: true,
    }))
    expect(dictionaryTerms(many)).toHaveLength(60)
  })

  it('is case-insensitive when deduplicating', () => {
    expect(
      dictionaryTerms([
        { id: '1', term: 'Murmur', replacement: null, enabled: true },
        { id: '2', term: 'murmur', replacement: null, enabled: true },
      ]),
    ).toEqual(['Murmur'])
  })
})

describe('languageRule', () => {
  it('defers to the transcript when the language is auto', () => {
    expect(languageRule('auto')).toContain('transcript’s own language')
    expect(languageRule('')).toContain('transcript’s own language')
  })

  it('names the expected language but still forbids translating', () => {
    const rule = languageRule('de')
    expect(rule).toContain('"de"')
    expect(rule).toContain('never translate')
  })
})

describe('shouldSkipPolish (PLAN §3.2.4)', () => {
  it('counts words', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('   ')).toBe(0)
    expect(countWords('one')).toBe(1)
    expect(countWords('  one   two  three ')).toBe(3)
  })

  it('skips utterances of three words or fewer', () => {
    expect(POLISH.skipWordCount).toBe(3)
    expect(shouldSkipPolish('yes', 'clean')).toBe(true)
    expect(shouldSkipPolish('yes sounds good', 'clean')).toBe(true)
    expect(shouldSkipPolish('yes that sounds good', 'clean')).toBe(false)
  })

  it('always skips when polishing is off', () => {
    expect(shouldSkipPolish('a long sentence with many words in it', 'off')).toBe(true)
  })
})

describe('maxOutputTokens', () => {
  it('never goes below the floor', () => {
    expect(maxOutputTokens('hi')).toBe(POLISH.maxTokensFloor)
  })

  it('scales with the input', () => {
    const short = maxOutputTokens('a'.repeat(100))
    const long = maxOutputTokens('a'.repeat(1000))
    expect(long).toBeGreaterThan(short)
    expect(long).toBe(Math.ceil((1000 / 4) * POLISH.maxTokensFactor))
  })
})

describe('checkPolishOutput — the hallucination guard (PLAN §7.4)', () => {
  const raw = 'um so we should probably ship this on tuesday no wednesday i think'

  it('accepts a normal edit', () => {
    expect(checkPolishOutput(raw, 'We should probably ship this on Wednesday, I think.')).toEqual({
      ok: true,
    })
  })

  it('rejects an empty response', () => {
    const verdict = checkPolishOutput(raw, '   ')
    expect(verdict).toMatchObject({ ok: false, reason: 'empty' })
  })

  it('rejects output that collapsed the utterance', () => {
    expect(checkPolishOutput(raw, 'Wednesday.')).toMatchObject({ ok: false, reason: 'too-short' })
  })

  it('rejects output that answered the question instead of editing it', () => {
    const answered =
      'Shipping on Wednesday is a good idea because it gives the team an extra day to finish ' +
      'testing, and it avoids the Monday release freeze. Here are three things to consider first.'
    // Caught as `answered` rather than `too-long`: the length was only ever a
    // proxy, and the grounding check names what actually went wrong.
    expect(checkPolishOutput(raw, answered)).toMatchObject({ ok: false, reason: 'answered' })
  })

  it('gives short utterances an absolute slack instead of a ratio', () => {
    // "ok sounds good" → "OK, sounds good." doubles in relative terms but is
    // obviously a legitimate edit.
    expect(checkPolishOutput('ok sounds good', 'OK, sounds good.')).toEqual({ ok: true })
    // …while a full paragraph from three words is still caught — now by the
    // grounding check, which reaches it first because most of that paragraph
    // is words the speaker never said. The length rule remains the backstop
    // for output that *is* made of the transcript but far too much of it.
    expect(
      checkPolishOutput(
        'ok sounds good',
        'OK, that sounds good to me — let us go ahead with it right away.',
      ),
    ).toMatchObject({ ok: false, reason: 'answered' })
  })
})

describe('unwrapModelOutput', () => {
  it('leaves clean output alone', () => {
    expect(unwrapModelOutput('We should ship it on Wednesday.')).toBe(
      'We should ship it on Wednesday.',
    )
  })

  it('strips a code fence', () => {
    expect(unwrapModelOutput('```\nHello there.\n```')).toBe('Hello there.')
    expect(unwrapModelOutput('```text\nHello there.\n```')).toBe('Hello there.')
  })

  it('strips a "here is the edited text:" preamble', () => {
    expect(unwrapModelOutput("Here's the polished version: Hello there.")).toBe('Hello there.')
    expect(unwrapModelOutput('Here is the edited text: Hello there.')).toBe('Hello there.')
  })

  it('strips surrounding quotes only when the whole output is wrapped', () => {
    expect(unwrapModelOutput('"Hello there."')).toBe('Hello there.')
    // A genuine quotation inside the text must survive.
    expect(unwrapModelOutput('She said "hello" to me.')).toBe('She said "hello" to me.')
    // …as must one that merely starts with a quote.
    expect(unwrapModelOutput('"Hello," she said.')).toBe('"Hello," she said.')
  })
})

describe('buildCommandPrompt (PLAN §18.1)', () => {
  const built = buildCommandPrompt({
    instruction: 'make it friendlier',
    selection: 'Send the report.',
    language: 'en',
  })

  it('states the output discipline and the unchanged-fallback rule', () => {
    expect(built.systemPrompt).toContain('Output only the edited text')
    expect(built.systemPrompt).toContain('output TEXT unchanged')
  })

  it('carries the instruction and the selection as the user turn', () => {
    expect(built.userText).toBe('INSTRUCTION: make it friendlier\n\nTEXT:\nSend the report.')
  })

  it('ships examples as real chat turns in the same shape', () => {
    expect(built.examples.length).toBeGreaterThanOrEqual(2)
    for (const example of built.examples) {
      expect(example.user).toContain('INSTRUCTION:')
      expect(example.user).toContain('TEXT:')
      expect(example.assistant.length).toBeGreaterThan(0)
    }
  })
})

describe('command output rules', () => {
  it('caps output relative to the selection, with a generous floor', () => {
    expect(maxCommandOutputTokens('hi')).toBe(256)
    expect(maxCommandOutputTokens('x'.repeat(4000))).toBe(3000)
  })

  it('rejects an empty edit — pasting emptiness would destroy the selection', () => {
    expect(checkCommandOutput('').ok).toBe(false)
    expect(checkCommandOutput('  \n ').ok).toBe(false)
    expect(checkCommandOutput('Fine.').ok).toBe(true)
  })
})

describe('checkPolishOutput — answering, not editing', () => {
  it('rejects the reply Gemma 3 1B actually inserted over a user', () => {
    // Verbatim from a user's history: they dictated about fixing a spec and
    // the model answered them. Length ratio alone waved it through.
    const raw =
      'I want to fix the spec so that it preserves the original behaviour and we only make the minimal changes needed to get it working again.'
    const polished =
      "I understand. Let's focus on preserving the original specification. I'll prioritize minimal changes and ensure everything remains as it was before. Please provide the specific changes you'd like to make."
    const verdict = checkPolishOutput(raw, polished)
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('answered')
  })

  it('rejects an answer that is the same length as the question', () => {
    // The case no ratio can catch: a reply that fits in the same space.
    const verdict = checkPolishOutput(
      'What time is the standup tomorrow morning?',
      'The standup is at nine in the morning.',
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('answered')
  })

  it('keeps ordinary punctuation-and-filler polishing', () => {
    expect(
      checkPolishOutput(
        'hey hey hey let me know i think this is gonna work just fine let me know',
        'Let me know. I think this is going to work just fine.',
      ).ok,
    ).toBe(true)
  })

  it('keeps a restructure that stays made of the transcript', () => {
    expect(
      checkPolishOutput(
        'This is another test. I want to first check the logs. Second, I want to analyze the logs.',
        'This is another test. I want to:\n\n1. Check the logs.\n2. Analyze the logs.',
      ).ok,
    ).toBe(true)
  })

  it('keeps an aggressive rewrite, which is a level the user can choose', () => {
    expect(
      checkPolishOutput(
        'so basically the deploy failed again because the certificate expired and nobody renewed it',
        'The deploy failed again: the certificate expired and was never renewed.',
      ).ok,
    ).toBe(true)
  })

  it('does not fire on a short utterance with nothing to match on', () => {
    expect(checkPolishOutput('ok sounds good', 'OK, sounds good.').ok).toBe(true)
  })

  it('lets an assistant-sounding phrase through when it is what was dictated', () => {
    // "Let's" opens the output, but every word of it came from the transcript.
    expect(
      checkPolishOutput(
        "let's ship the release on wednesday and tell the team on monday",
        "Let's ship the release on Wednesday and tell the team on Monday.",
      ).ok,
    ).toBe(true)
  })

  it("rejects a reply that answers in the speaker's own words", () => {
    // The hole a grounding ratio cannot see: the model agrees and then repeats
    // the instruction back. Nearly every content word is accounted for, so the
    // output scores as a faithful edit — and it is still a reply. The only
    // part that gives it away is the one word nobody spoke.
    const verdict = checkPolishOutput(
      'make the changes minimal and keep the original spec',
      "Sure. I'll make the changes minimal and keep the original spec.",
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.reason).toBe('answered')
  })

  it('rejects an echoed reply whichever opener it wears', () => {
    // Not a property of "Sure": the same reply is the same reply.
    const raw = 'we should keep the original behaviour and only change the parser'
    for (const opener of ['Certainly', 'Of course', 'Got it']) {
      const polished = `${opener}. We should keep the original behaviour and only change the parser.`
      expect(checkPolishOutput(raw, polished).ok).toBe(false)
    }
  })
})

describe('checkPolishOutput — what the guard must never reject', () => {
  it('keeps "let me know", which is speech and not an assistant opener', () => {
    // Caught by the polish eval as a false positive: "let me" opened the
    // assistant-opener list, and `gonna`→`going` read as an invented word.
    expect(
      checkPolishOutput(
        'hey hey hey let me know i think this is gonna work just fine let me know',
        "Let me know, it's going to work just fine.",
      ).ok,
    ).toBe(true)
  })

  it('treats spoken contractions and their polished forms as the same word', () => {
    expect(
      checkPolishOutput(
        'i wanna ship it cause the deadline moved',
        'I want to ship it because the deadline moved.',
      ).ok,
    ).toBe(true)
    expect(
      checkPolishOutput(
        'yeah we gotta fix that till monday',
        'Yes, we have got to fix that until Monday.',
      ).ok,
    ).toBe(true)
  })

  it('still rejects a reply that opens with an unambiguous assistant phrase', () => {
    expect(
      checkPolishOutput(
        'can you fix the spec so it preserves the original behaviour',
        "I understand. Let's focus on that. Please provide the specific changes you'd like.",
      ).ok,
    ).toBe(false)
  })

  it('keeps an opener the speaker actually dictated', () => {
    // "Sure" is an assistant opener and also the first word of the transcript.
    // Which of those it is, is the whole question.
    expect(
      checkPolishOutput(
        'sure i can take a look at the deploy logs this afternoon',
        'Sure, I can take a look at the deploy logs this afternoon.',
      ).ok,
    ).toBe(true)
  })

  it('keeps a question that happens to open like an offer', () => {
    // "Would you like" is all function words, so there is nothing to check it
    // against. That case falls back to the grounding ratio rather than
    // guessing, and this output is made of its own transcript.
    expect(
      checkPolishOutput(
        'would you like to join us for the retro on friday afternoon',
        'Would you like to join us for the retro on Friday afternoon?',
      ).ok,
    ).toBe(true)
  })
})
