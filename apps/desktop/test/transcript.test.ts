import { describe, expect, it } from 'vitest'

import { normaliseTranscript } from '../src/main/engines/stt/transcript'

describe('normaliseTranscript', () => {
  it('collapses the segment newlines whisper.cpp joins its output with', () => {
    // The reported symptom: a pause mid-utterance becomes a hard line break in
    // whatever app the text lands in. whisper.cpp's `text` field is its
    // segments joined by "\n", and a segment boundary is a pause.
    const fromWhisper = 'So I was thinking\n we could ship it on Wednesday\n and tell the team.'

    expect(normaliseTranscript(fromWhisper)).toBe(
      'So I was thinking we could ship it on Wednesday and tell the team.',
    )
  })

  it('leaves no trace of a leading per-segment space', () => {
    // Each whisper segment carries its own leading space; joined, that lands as
    // a double space mid-sentence rather than a newline.
    expect(normaliseTranscript('one\n two\n three')).toBe('one two three')
  })

  it('handles CRLF, tabs and runs of blank lines', () => {
    expect(normaliseTranscript('a\r\n\r\nb\t\tc \n\n\n d')).toBe('a b c d')
  })

  it('trims the ends, as the old .trim() did', () => {
    expect(normaliseTranscript('  hello there  ')).toBe('hello there')
    expect(normaliseTranscript('\n\n hello \n\n')).toBe('hello')
  })

  it('is a no-op on text that is already one clean line', () => {
    const clean = 'We should ship it on Wednesday.'
    expect(normaliseTranscript(clean)).toBe(clean)
  })

  it('survives an empty or whitespace-only transcript', () => {
    // Silence, or a hold with no speech. The caller treats empty as "nothing
    // said" — it must not become a stray space that pastes a blank.
    expect(normaliseTranscript('')).toBe('')
    expect(normaliseTranscript('   \n  ')).toBe('')
  })

  it('does not touch punctuation or spacing inside words', () => {
    // Guard against an over-eager regex: hyphens, apostrophes and code-ish
    // tokens are not whitespace and must come through untouched.
    expect(normaliseTranscript("it's a well-known camelCase snake_case thing")).toBe(
      "it's a well-known camelCase snake_case thing",
    )
  })
})
