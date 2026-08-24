import { describe, expect, it } from 'vitest'

import { normaliseTranscript, stripHallucinatedTail } from '../src/main/engines/stt/transcript'

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

describe('stripHallucinatedTail', () => {
  /** A confidently-transcribed segment. */
  const said = (text: string, avgLogProb = -0.2) => ({ text, avgLogProb })
  /** One conjured out of silence: same words, far less evidence. */
  const dreamt = (text: string) => ({ text, avgLogProb: -0.95 })

  /**
   * Joined the way the engine joins them, then normalised — which is what
   * collapses whisper's per-segment leading space in production.
   */
  const textOf = (result: { segments: { text?: string | undefined }[] }): string =>
    normaliseTranscript(result.segments.map((segment) => segment.text ?? '').join(' '))

  it('drops the "Yes." Whisper adds after a question', () => {
    // The exact shape observed in real dictations: a question, then an answer
    // the speaker never gave.
    const result = stripHallucinatedTail([said('Does that make sense?'), dreamt(' Yes.')])
    expect(result.dropped).toBe('Yes.')
    expect(textOf(result)).toBe('Does that make sense?')
  })

  it('drops every filler it is known to invent', () => {
    for (const filler of ['Okay.', 'Yeah.', 'Yes.', 'Thank you.', 'Bye.', 'Oh.', 'you']) {
      const result = stripHallucinatedTail([said('Ship it on Wednesday.'), dreamt(` ${filler}`)])
      expect(result.dropped, filler).not.toBeNull()
    }
  })

  it('keeps a filler the speaker actually said', () => {
    // Same word, transcribed as confidently as the rest — there was audio for
    // it. No word list can tell these apart; the confidence gap can.
    const result = stripHallucinatedTail([said('Are we still on for Tuesday?'), said(' Yeah.')])
    expect(result.dropped).toBeNull()
    expect(textOf(result)).toBe('Are we still on for Tuesday? Yeah.')
  })

  it('never returns nothing, even when the whole transcript is a filler', () => {
    // Someone dictating just "Okay." into a reply meant it.
    const result = stripHallucinatedTail([dreamt('Okay.')])
    expect(result.dropped).toBeNull()
    expect(textOf(result)).toBe('Okay.')
  })

  it('leaves a filler that shares a segment with real speech', () => {
    // No pause means no segment boundary, which means the speaker said it in
    // the same breath.
    const result = stripHallucinatedTail([said('Does that make sense? Yeah.')])
    expect(result.dropped).toBeNull()
  })

  it('leaves a trailing sentence that is not a known invention', () => {
    const result = stripHallucinatedTail([said('Check the logs.'), dreamt(' Publish them.')])
    expect(result.dropped).toBeNull()
  })

  it('strips on structure alone when whisper.cpp reports no confidence', () => {
    const result = stripHallucinatedTail([{ text: 'Ship it Wednesday.' }, { text: ' Thank you.' }])
    expect(result.dropped).toBe('Thank you.')
  })

  it('ignores punctuation and case when matching', () => {
    expect(stripHallucinatedTail([said('Go on.'), dreamt(' YEAH!')]).dropped).toBe('YEAH!')
    expect(stripHallucinatedTail([said('Go on.'), dreamt(' thank you…')]).dropped).toBe(
      'thank you…',
    )
  })

  it('drops empty segments without treating one as the tail', () => {
    const result = stripHallucinatedTail([said('Ship it.'), { text: '  ' }, dreamt(' Okay.')])
    expect(result.dropped).toBe('Okay.')
    expect(textOf(result)).toBe('Ship it.')
  })

  it('only ever removes the last segment', () => {
    const result = stripHallucinatedTail([dreamt('Yeah.'), said(' We should ship it.')])
    expect(result.dropped).toBeNull()
    expect(result.segments).toHaveLength(2)
  })

  it('handles an empty transcript', () => {
    expect(stripHallucinatedTail([])).toEqual({ segments: [], dropped: null })
  })
})
