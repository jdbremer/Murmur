import { describe, expect, it } from 'vitest'

import type { AskCitation, AskConversation, AskEvent, AskState, AskTurn } from '@murmur/shared'

import {
  INITIAL_THREAD,
  isBusy,
  splitAnswer,
  splitBlocks,
  statusLabel,
  threadReducer,
  type ThreadState,
} from '../src/renderer/hub/sections/ask/thread'

/**
 * The Ask thread reducer (PLAN §2.2.9).
 *
 * Worth testing apart from the component because of `restart`: a dictation
 * preempting an answer mid-stream means the partial text on screen has to be
 * thrown away rather than appended to, and getting that wrong splices two half
 * answers together into something that reads like the model contradicting
 * itself. Reproducing it through the UI would mean timing a race; here it is
 * three lines.
 */

const NOW = 1_700_000_000_000
const CONV = 'conv-1'

function turn(role: 'user' | 'assistant', content: string, citations: AskCitation[] = []): AskTurn {
  return {
    id: `${role}-${content}`,
    role,
    content,
    citations,
    coverage: '',
    truncated: false,
    createdAt: NOW,
  }
}

function citation(index: number): AskCitation {
  return {
    index,
    id: `d${index}`,
    source: 'dictation',
    title: 'dictated in Slack',
    timestamp: NOW,
    excerpt: 'the deploy is blocked',
  }
}

function conv(over: Partial<AskConversation> = {}): AskConversation {
  return {
    id: over.id ?? CONV,
    title: over.title ?? 'Why is the deploy blocked',
    createdAt: NOW,
    updatedAt: over.updatedAt ?? NOW,
    turnCount: over.turnCount ?? 2,
  }
}

/** The reducer's starting point once a conversation is on screen. */
const OPEN: ThreadState = { ...INITIAL_THREAD, activeId: CONV }

function reduce(state: ThreadState, ...events: AskEvent[]): ThreadState {
  return events.reduce((acc, event) => threadReducer(acc, { type: 'event', event }), state)
}

describe('threadReducer', () => {
  it('accumulates deltas into the streaming answer', () => {
    const state = reduce(
      INITIAL_THREAD,
      { type: 'delta', conversationId: CONV, text: 'The deploy ' },
      { type: 'delta', conversationId: CONV, text: 'is blocked.' },
    )
    expect(state.streaming).toBe('The deploy is blocked.')
  })

  it('throws the partial answer away on a restart', () => {
    // The bug this file exists for. Appending here would show the reader the
    // first half of one answer joined to the whole of another.
    const state = reduce(
      INITIAL_THREAD,
      { type: 'delta', conversationId: CONV, text: 'The deploy is bl' },
      { type: 'restart', conversationId: CONV },
      { type: 'delta', conversationId: CONV, text: 'The deploy is blocked on the migration.' },
    )
    expect(state.streaming).toBe('The deploy is blocked on the migration.')
  })

  it('replaces the streamed text with the stored turn when the answer lands', () => {
    // The turn is authoritative — trimmed, and carrying the citations. Joining
    // it to the streamed text would duplicate the whole answer.
    const answer = turn('assistant', 'The deploy is blocked.', [citation(1)])
    const state = reduce(
      INITIAL_THREAD,
      { type: 'delta', conversationId: CONV, text: 'The deploy is blocked.' },
      { type: 'done', conversationId: CONV, turn: answer, conversation: conv() },
    )
    expect(state.streaming).toBe('')
    expect(state.turns).toEqual([answer])
    expect(state.status).toBe('idle')
  })

  it('appends the question as its own turn', () => {
    const state = reduce(OPEN, {
      type: 'question',
      conversationId: CONV,
      turn: turn('user', 'why?'),
    })
    expect(state.turns.map((t) => t.role)).toEqual(['user'])
  })

  it('clears a previous error when a new question is asked', () => {
    // A stale failure sitting above an answer that is arriving perfectly well
    // is the kind of thing that makes a pane look broken when it is not.
    const failed = reduce(OPEN, { type: 'error', conversationId: CONV, message: 'model not ready' })
    const asked = reduce(failed, {
      type: 'question',
      conversationId: CONV,
      turn: turn('user', 'again'),
    })
    expect(asked.error).toBeNull()
  })

  it('keeps the partial answer when an error arrives mid-stream', () => {
    // Half an answer plus an explanation beats an empty pane plus the same
    // explanation.
    const state = reduce(
      INITIAL_THREAD,
      { type: 'delta', conversationId: CONV, text: 'It was blocked by' },
      { type: 'error', conversationId: CONV, message: 'llama-server stopped responding' },
    )
    expect(state.streaming).toBe('It was blocked by')
    expect(state.error).toBe('llama-server stopped responding')
    expect(state.status).toBe('error')
  })

  it('records the sources offered and how many were searched', () => {
    const state = reduce(OPEN, {
      type: 'sources',
      conversationId: CONV,
      citations: [citation(1), citation(2)],
      searched: 17,
      coverage: '',
    })
    expect(state.citations).toHaveLength(2)
    expect(state.searched).toBe(17)
  })

  it('drops the previous answer sources when a new question starts', () => {
    // Otherwise the chips under a fresh, still-empty answer are the last one's.
    const state = reduce(
      INITIAL_THREAD,
      {
        type: 'sources',
        conversationId: CONV,
        citations: [citation(1)],
        searched: 4,
        coverage: '',
      },
      { type: 'question', conversationId: CONV, turn: turn('user', 'next') },
    )
    expect(state.citations).toEqual([])
    expect(state.searched).toBe(0)
    // The coverage line goes with them; a recap's "read 12 dictations" left
    // standing over the next answer would misdescribe it.
    expect(state.coverage).toBe('')
  })

  it('loads a stored conversation', () => {
    const loaded = threadReducer(
      { ...OPEN, streaming: 'in flight' },
      {
        type: 'loaded',
        state: {
          status: 'idle',
          activeId: CONV,
          conversations: [conv()],
          turns: [turn('user', 'q')],
          counts: { dictations: 12, notes: 3, meetings: 1 },
          suggestions: [],
          unavailable: null,
        } satisfies AskState,
      },
    )
    expect(loaded.turns).toHaveLength(1)
    expect(loaded.counts.dictations).toBe(12)
    // A load is a whole-state replace, so the stream it interrupts goes too.
    expect(loaded.streaming).toBe('')
  })

  it('drops an in-flight answer when the pane loads another conversation', () => {
    // Main cancels the answer when the active conversation changes; keeping the
    // partial text would leave one thread's half-answer under another's turns.
    const mid: ThreadState = { ...OPEN, streaming: 'half an answer', citations: [citation(1)] }
    const swapped = threadReducer(mid, {
      type: 'loaded',
      state: {
        status: 'idle',
        activeId: 'conv-2',
        conversations: [conv({ id: 'conv-2' })],
        turns: [],
        counts: { dictations: 300, notes: 4, meetings: 2 },
        suggestions: [],
        unavailable: null,
      } satisfies AskState,
    })
    expect(swapped.streaming).toBe('')
    expect(swapped.citations).toEqual([])
    expect(swapped.activeId).toBe('conv-2')
    // Clearing conversations deletes no dictations, so the corpus is intact.
    expect(swapped.counts.dictations).toBe(300)
  })

  it('ignores an event belonging to a different conversation', () => {
    // The switch cancels the answer, but the cancel and the last few deltas
    // race — and a delta applied to the wrong thread appends one
    // conversation's words to another's answer.
    const state = reduce(OPEN, { type: 'delta', conversationId: 'somewhere-else', text: 'stray' })
    expect(state.streaming).toBe('')
  })

  it('adopts the conversation main created for a question asked from blank', () => {
    // Asking with no thread open creates one in main, so the first event is the
    // renderer's only way to learn its id.
    const state = reduce(INITIAL_THREAD, {
      type: 'question',
      conversationId: 'fresh',
      turn: turn('user', 'first question'),
    })
    expect(state.activeId).toBe('fresh')
    expect(state.turns).toHaveLength(1)
  })

  it('moves a conversation to the front of the list when it answers', () => {
    const state = reduce(
      { ...OPEN, conversations: [conv({ id: 'other' }), conv()] },
      {
        type: 'done',
        conversationId: CONV,
        turn: turn('assistant', 'answer'),
        conversation: conv({ updatedAt: NOW + 1000 }),
      },
    )
    expect(state.conversations.map((c) => c.id)).toEqual([CONV, 'other'])
    expect(state.conversations).toHaveLength(2)
  })
})

describe('isBusy', () => {
  it('covers every state where the model still owes an answer', () => {
    expect(isBusy('searching')).toBe(true)
    expect(isBusy('answering')).toBe(true)
    // Paused counts: the answer is coming back, so the button must stay Stop.
    expect(isBusy('paused')).toBe(true)
    expect(isBusy('idle')).toBe(false)
    expect(isBusy('error')).toBe(false)
  })
})

describe('statusLabel', () => {
  it('explains the wait before any text arrives', () => {
    expect(statusLabel({ ...OPEN, status: 'searching' })).toMatch(/searching/i)
    expect(statusLabel({ ...OPEN, status: 'answering' })).toMatch(/reading/i)
  })

  it('goes quiet once text is arriving', () => {
    // The text is the progress indicator. A spinner beside it is noise.
    expect(statusLabel({ ...OPEN, status: 'answering', streaming: 'The' })).toBeNull()
  })

  it('says why an answer stopped when a dictation took the model', () => {
    expect(statusLabel({ ...OPEN, status: 'paused' })).toMatch(/dictated/i)
  })

  it('says nothing at rest', () => {
    expect(statusLabel(OPEN)).toBeNull()
    expect(statusLabel({ ...OPEN, status: 'error' })).toBeNull()
  })
})

describe('splitAnswer', () => {
  it('turns a marker into a chip in place', () => {
    const parts = splitAnswer('It was blocked [1].', [citation(1)])
    expect(parts.map((p) => p.kind)).toEqual(['text', 'citation', 'text'])
    // The word before the marker moves onto the chip, so the two stay on one
    // line — see `lead`. What is left of the text run keeps the space.
    expect(parts[0]?.value).toBe('It was ')
    expect(parts[1]?.lead).toBe('blocked')
    expect(parts[1]?.citation?.id).toBe('d1')
    expect(parts[2]?.value).toBe('.')
  })

  it('drops a marker with no matching source', () => {
    // The real 3B model ends refusals with a phantom "[1]". A lone bracket
    // after "I could not find anything" reads as a source you cannot open.
    const parts = splitAnswer('as noted [9]', [citation(1)])
    expect(parts).toEqual([{ kind: 'text', value: 'as noted' }])
  })

  it('takes the space before a dropped marker with it', () => {
    const parts = splitAnswer('I could not find anything about that. [1]', [])
    expect(parts).toEqual([{ kind: 'text', value: 'I could not find anything about that.' }])
  })

  it('does not leave a seam where a marker was removed', () => {
    // Two adjacent text nodes would render identically here but make the
    // surrounding whitespace logic impossible to reason about.
    const parts = splitAnswer('before [9] after', [citation(1)])
    expect(parts).toEqual([{ kind: 'text', value: 'before after' }])
  })

  it('handles several markers and repeats', () => {
    const parts = splitAnswer('[1] and [2], again [1].', [citation(1), citation(2)])
    expect(parts.filter((p) => p.kind === 'citation').map((p) => p.value)).toEqual(['1', '2', '1'])
  })

  it('preserves the prose exactly, changing only the markers', () => {
    // The chips are a rendering of the answer. Every word the model wrote has
    // to survive — including the ones moved onto a chip as its `lead` — and
    // only the bracketed references are the renderer's to touch.
    const parts = splitAnswer('Blocked [1] on the migration [2]; see also [9].', [
      citation(1),
      citation(2),
    ])
    const rebuilt = parts
      .map((part) => (part.kind === 'citation' ? `${part.lead ?? ''} [${part.value}]` : part.value))
      .join('')
    expect(rebuilt).toBe('Blocked [1] on the migration [2]; see also.')
  })

  it('glues the chip to the word before it', () => {
    // A chip is an atomic inline box, so CSS will happily break the line
    // between "month." and the chip and strand it on a line of its own.
    const parts = splitAnswer('…before the end of the month. [1]', [citation(1)])
    expect(parts.at(-1)).toMatchObject({ kind: 'citation', lead: 'month.' })
    expect(parts[0]?.value).toBe('…before the end of the ')
  })

  it('leaves no empty text run when the chip follows a single word', () => {
    const parts = splitAnswer('Blocked [1]', [citation(1)])
    expect(parts).toHaveLength(1)
    expect(parts[0]).toMatchObject({ kind: 'citation', lead: 'Blocked' })
  })

  it('needs no lead when the marker opens the answer', () => {
    const parts = splitAnswer('[1] was the reason', [citation(1)])
    expect(parts[0]).toMatchObject({ kind: 'citation', lead: '' })
  })

  it('handles an answer with no markers, and an empty one', () => {
    expect(splitAnswer('no citations here', [citation(1)])).toEqual([
      { kind: 'text', value: 'no citations here' },
    ])
    expect(splitAnswer('', [])).toEqual([])
  })
})

describe('splitBlocks', () => {
  it('groups a run of bullets into one list', () => {
    // A recap arrives as "- " lines. Rendered as one pre-wrap block it is a
    // wall of hyphens whose wrapped lines sit flush against the margin.
    const blocks = splitBlocks('- first thing\n- second thing\n- third thing')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe('list')
    expect(blocks[0]?.lines).toEqual(['first thing', 'second thing', 'third thing'])
  })

  it('keeps prose and bullets as separate blocks, in order', () => {
    const blocks = splitBlocks('Here is your day:\n- did a thing\n- did another\nThat was it.')
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'list', 'text'])
  })

  it('accepts the bullet characters a model actually emits', () => {
    expect(splitBlocks('- dash\n• dot\n* star')[0]?.lines).toEqual(['dash', 'dot', 'star'])
  })

  it('leaves a lone hyphen as prose', () => {
    // "-" on its own is punctuation mid-sentence, not an empty bullet.
    expect(splitBlocks('a sentence -\nand its rest')[0]?.kind).toBe('text')
  })

  it('does not treat a hyphenated word as a bullet', () => {
    expect(splitBlocks('well-known problem')[0]).toEqual({
      kind: 'text',
      lines: ['well-known problem'],
    })
  })

  it('drops blank lines rather than emitting empty blocks', () => {
    expect(splitBlocks('one\n\n\ntwo')).toEqual([{ kind: 'text', lines: ['one', 'two'] }])
  })

  it('handles an answer that is still streaming its first character', () => {
    expect(splitBlocks('')).toEqual([])
    expect(splitBlocks('-')).toEqual([{ kind: 'text', lines: ['-'] }])
  })
})
