import { describe, expect, it } from 'vitest'

import { deriveNoteTitle, NOTE_TITLE_MAX } from '../src/domain/note'

/**
 * A note's title (PLAN §2.2.7).
 *
 * Derived rather than demanded: asking for a title before a thought is written
 * is the fastest way to lose the thought, and an untitled note in a list is
 * unfindable. So the first line stands in, and the rules for what "the first
 * line" means are pinned here.
 */

const note = (body: string, title = ''): { title: string; body: string } => ({ title, body })

describe('deriveNoteTitle', () => {
  it('prefers a title the user actually set', () => {
    expect(deriveNoteTitle(note('some body text', 'Standup'))).toBe('Standup')
    // Whitespace-only is not a title.
    expect(deriveNoteTitle(note('some body text', '   '))).toBe('some body text')
  })

  it('uses the first non-empty line of the body', () => {
    expect(deriveNoteTitle(note('\n\n  ship it on Wednesday\nand tell Ana'))).toBe(
      'ship it on Wednesday',
    )
  })

  it('strips Markdown heading marks', () => {
    expect(deriveNoteTitle(note('## Retro notes\n- one'))).toBe('Retro notes')
    expect(deriveNoteTitle(note('#nohash stays'))).toBe('#nohash stays')
  })

  it('names an empty note rather than showing a blank row', () => {
    expect(deriveNoteTitle(note(''))).toBe('Untitled note')
    expect(deriveNoteTitle(note('\n \n'))).toBe('Untitled note')
  })

  it('cuts a long first line at a word boundary', () => {
    const long = 'the quick brown fox jumps over the lazy dog and keeps on running for ages'
    const derived = deriveNoteTitle(note(long))

    expect(derived.endsWith('…')).toBe(true)
    expect(derived.length).toBeLessThanOrEqual(NOTE_TITLE_MAX + 1)
    // Cut between words, never through one.
    expect(long.startsWith(derived.slice(0, -1))).toBe(true)
    expect(derived).not.toMatch(/\s…$/)
  })

  it('cuts mid-word only when there is no word boundary to use', () => {
    const derived = deriveNoteTitle(note('x'.repeat(200)))
    expect(derived).toBe(`${'x'.repeat(NOTE_TITLE_MAX)}…`)
  })
})
