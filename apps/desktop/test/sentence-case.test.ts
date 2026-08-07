import { describe, expect, it } from 'vitest'

import { applySentenceCase, continuesSentence } from '../src/main/dictation/sentence-case'

describe('continuesSentence', () => {
  it('is true mid-sentence', () => {
    expect(continuesSentence('I rewrote the parser ')).toBe(true)
    expect(continuesSentence('we shipped it, ')).toBe(true)
    expect(continuesSentence('the migration — ')).toBe(true)
  })

  it('is false after terminal punctuation', () => {
    for (const before of ['We shipped it. ', 'Did we? ', 'Ship it! ', 'One thing: ', 'so… ']) {
      expect(continuesSentence(before)).toBe(false)
    }
  })

  it('is false at the start of an empty field', () => {
    expect(continuesSentence('')).toBe(false)
    expect(continuesSentence('   ')).toBe(false)
  })

  it('is false after a line break, even with no full stop', () => {
    // A new bullet or paragraph is a new thought regardless of punctuation.
    expect(continuesSentence('- the migration\n')).toBe(false)
    expect(continuesSentence('intro\n\n')).toBe(false)
  })

  it('reads a closing bracket by what it closed', () => {
    expect(continuesSentence('(see below) ')).toBe(true)
    expect(continuesSentence('(see below.) ')).toBe(false)
  })

  it('treats an unreadable context as "do not touch"', () => {
    // null means the platform could not tell us — distinct from an empty field,
    // and the only safe reading is to leave the text alone.
    expect(continuesSentence(null)).toBe(false)
  })
})

describe('applySentenceCase', () => {
  it('lowercases the opening word when continuing', () => {
    expect(applySentenceCase('And then we shipped it.', 'I rewrote the parser ')).toBe(
      'and then we shipped it.',
    )
  })

  it('leaves the capital when starting a sentence', () => {
    expect(applySentenceCase('And then we shipped it.', 'We were done. ')).toBe(
      'And then we shipped it.',
    )
    expect(applySentenceCase('And then we shipped it.', '')).toBe('And then we shipped it.')
  })

  it('never touches an acronym', () => {
    expect(applySentenceCase('NASA confirmed it.', 'we heard that ')).toBe('NASA confirmed it.')
    expect(applySentenceCase('API keys are rotated.', 'he said ')).toBe('API keys are rotated.')
  })

  it('never touches a capitalised "I"', () => {
    expect(applySentenceCase('I think so.', 'he said ')).toBe('I think so.')
    expect(applySentenceCase("I'm on it.", 'she said ')).toBe("I'm on it.")
  })

  it('leaves a proper noun alone in the sense that matters', () => {
    // "Jordan" would be lowercased — the function cannot know it is a name, and
    // that is an accepted limit. What it must not do is mangle a word whose
    // *later* letters are capitalised, which is the acronym guard above.
    expect(applySentenceCase('McDonald called.', 'he said ')).toBe('McDonald called.')
  })

  it('is a no-op on text that does not start with a capital', () => {
    expect(applySentenceCase('and then we shipped', 'I rewrote it ')).toBe('and then we shipped')
    expect(applySentenceCase('42 things happened', 'I counted ')).toBe('42 things happened')
  })

  it('is a no-op on empty text', () => {
    expect(applySentenceCase('', 'I rewrote it ')).toBe('')
  })
})
