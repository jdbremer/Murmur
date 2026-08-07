import { describe, expect, it } from 'vitest'

import { expandSnippets, SnippetSchema, type Snippet } from '../src/domain/snippet'

function snippet(trigger: string, expansion: string, enabled = true): Snippet {
  return SnippetSchema.parse({ id: trigger, trigger, expansion, enabled })
}

describe('expandSnippets', () => {
  const calendar = snippet('my calendar link', 'https://cal.example/jordan')

  it('expands a trigger in the middle of a sentence', () => {
    expect(expandSnippets('Here is my calendar link, pick a time.', [calendar])).toBe(
      'Here is https://cal.example/jordan, pick a time.',
    )
  })

  it('matches whatever capitalisation the polish model produced', () => {
    // The trigger is matched against *polished* text, so it arrives sentence-cased.
    expect(expandSnippets('My calendar link is below.', [calendar])).toBe(
      'https://cal.example/jordan is below.',
    )
  })

  it('does not fire inside a longer word', () => {
    const link = snippet('link', 'https://example.com')
    expect(expandSnippets('the linkage is broken', [link])).toBe('the linkage is broken')
    expect(expandSnippets('the link is broken', [link])).toBe('the https://example.com is broken')
  })

  it('prefers the most specific trigger when one contains another', () => {
    const short = snippet('my address', '1 Short St')
    const long = snippet('my work address', '2 Long Ave')
    expect(expandSnippets('send it to my work address please', [short, long])).toBe(
      'send it to 2 Long Ave please',
    )
  })

  it('never rescans an expansion for another trigger', () => {
    // Without the placeholder pass this loops or double-expands: B's trigger
    // appears inside A's expansion.
    const a = snippet('greeting', 'Hi there, signature')
    const b = snippet('signature', 'Jordan')
    expect(expandSnippets('greeting', [a, b])).toBe('Hi there, signature')
  })

  it('leaves ordinary numbers alone', () => {
    // Regression guard on the placeholder encoding: a readable placeholder like
    // " 0 " would match the bare number here and delete it.
    expect(expandSnippets('I have 3 things and 12 more', [calendar])).toBe(
      'I have 3 things and 12 more',
    )
  })

  it('skips disabled snippets', () => {
    const off = snippet('my calendar link', 'https://cal.example/jordan', false)
    expect(expandSnippets('Here is my calendar link.', [off])).toBe('Here is my calendar link.')
  })

  it('expands every occurrence', () => {
    expect(expandSnippets('my calendar link and my calendar link', [calendar])).toBe(
      'https://cal.example/jordan and https://cal.example/jordan',
    )
  })

  it('tolerates extra whitespace between the trigger words', () => {
    expect(expandSnippets('here is my  calendar   link', [calendar])).toBe(
      'here is https://cal.example/jordan',
    )
  })

  it('handles a multi-line expansion', () => {
    const address = snippet('my address', '1 Example Street\nSpringfield')
    expect(expandSnippets('Ship to my address please', [address])).toBe(
      'Ship to 1 Example Street\nSpringfield please',
    )
  })

  it('is a no-op with no snippets', () => {
    expect(expandSnippets('nothing to do here', [])).toBe('nothing to do here')
  })
})
