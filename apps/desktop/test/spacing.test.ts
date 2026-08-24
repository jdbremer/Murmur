import { describe, expect, it } from 'vitest'

import { needsLeadingSpace, padForCursor } from '../src/main/dictation/spacing'

describe('needsLeadingSpace', () => {
  it('separates a new dictation from the sentence before it', () => {
    // The reported bug: stop, go, stop, go welds them together.
    expect(needsLeadingSpace('Wednesday.')).toBe(true)
    expect(needsLeadingSpace('the docs')).toBe(true)
    expect(needsLeadingSpace('one thing,')).toBe(true)
  })

  it('stays quiet at the start of an empty field', () => {
    expect(needsLeadingSpace('')).toBe(false)
    expect(needsLeadingSpace('   ')).toBe(false)
  })

  it('stays quiet when there is already a separator', () => {
    expect(needsLeadingSpace('Wednesday. ')).toBe(false)
    expect(needsLeadingSpace('Wednesday.\t')).toBe(false)
    expect(needsLeadingSpace('a line\n')).toBe(false)
  })

  it('does not split a word or a URL', () => {
    // A space after any of these is wrong, not merely unnecessary.
    expect(needsLeadingSpace('well-')).toBe(false)
    expect(needsLeadingSpace('https://')).toBe(false)
    expect(needsLeadingSpace('snake_')).toBe(false)
    expect(needsLeadingSpace('a/b/')).toBe(false)
  })

  it('does not push text away from what opened it', () => {
    expect(needsLeadingSpace('(')).toBe(false)
    expect(needsLeadingSpace('note (')).toBe(false)
    expect(needsLeadingSpace('@')).toBe(false)
    expect(needsLeadingSpace('“')).toBe(false)
    // A straight quote is decided by what precedes it: this one opens.
    expect(needsLeadingSpace('he said "')).toBe(false)
    expect(needsLeadingSpace('"')).toBe(false)
  })

  it('does separate after something that closed', () => {
    expect(needsLeadingSpace('(see below)')).toBe(true)
    expect(needsLeadingSpace('"quoted"')).toBe(true)
    expect(needsLeadingSpace("the dogs'")).toBe(true)
  })

  it('treats unknown as unknown, never as empty', () => {
    // `null` means the platform could not read the field — the caller decides.
    expect(needsLeadingSpace(null)).toBe(false)
  })
})

describe('padForCursor', () => {
  describe('when the cursor context is readable', () => {
    it('adds a leading space so bursts do not weld together', () => {
      expect(padForCursor('How are the docs?', 'Wednesday.')).toBe(' How are the docs?')
    })

    it('fixes text the user typed themselves, which a trailing space cannot', () => {
      // Nothing added a trailing space here — the user typed it. Only a
      // leading-space rule can see that.
      expect(padForCursor('and then we shipped', 'I rewrote the parser')).toBe(
        ' and then we shipped',
      )
    })

    it('adds nothing at the start of a field', () => {
      expect(padForCursor('Ship it Wednesday.', '')).toBe('Ship it Wednesday.')
    })

    it('never doubles an existing space, on either side', () => {
      expect(padForCursor('How are the docs?', 'Wednesday. ')).toBe('How are the docs?')
      expect(padForCursor(' How are the docs?', 'Wednesday.')).toBe(' How are the docs?')
    })

    it('leaves no trailing space when it can see the context', () => {
      // The precise path costs nothing in a field the user is about to send.
      expect(padForCursor('Ship it.', 'Wednesday.').endsWith(' ')).toBe(false)
    })
  })

  describe('when the cursor context cannot be read', () => {
    it('sets up the next dictation with a trailing space', () => {
      // Electron apps often do not expose the accessibility attribute this
      // needs, and those are exactly the apps people dictate into all day.
      expect(padForCursor('Ship it Wednesday.', null)).toBe('Ship it Wednesday. ')
    })

    it('does not double a space the text already ends with', () => {
      expect(padForCursor('Ship it. ', null)).toBe('Ship it. ')
    })
  })

  it('composes across consecutive dictations without doubling', () => {
    // The fallback leaves a trailing space; the next dictation's leading-space
    // check sees whitespace and stays out of the way.
    const first = padForCursor('Ship it Wednesday.', null)
    expect(first).toBe('Ship it Wednesday. ')
    expect(padForCursor('How are the docs?', first)).toBe('How are the docs?')
  })

  it('leaves an empty insertion alone', () => {
    // A lone " " pasted into a document would be a visible edit.
    expect(padForCursor('', null)).toBe('')
    expect(padForCursor('', 'Wednesday.')).toBe('')
  })
})
