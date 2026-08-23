import { describe, expect, it } from 'vitest'

import { fuzzyScore, rankBy, scoreCommand } from '../src/renderer/hub/command/match'

const titles = (items: { title: string }[]): string[] => items.map((item) => item.title)

describe('fuzzyScore', () => {
  it('matches everything, neutrally, on an empty query', () => {
    expect(fuzzyScore('History', '')).toBe(0)
    expect(fuzzyScore('History', '   ')).toBe(0)
  })

  it('does not match when a letter is missing', () => {
    expect(fuzzyScore('History', 'zz')).toBeNull()
    expect(fuzzyScore('History', 'hix')).toBeNull()
  })

  it('ranks a prefix above a substring above a subsequence', () => {
    const prefix = fuzzyScore('History', 'his') as number
    const substring = fuzzyScore('Show history', 'his') as number
    const subsequence = fuzzyScore('Hide inline settings', 'his') as number
    expect(prefix).toBeGreaterThan(substring)
    expect(substring).toBeGreaterThan(subsequence)
  })

  it('is case-insensitive both ways', () => {
    expect(fuzzyScore('History', 'HISTORY')).toBe(fuzzyScore('HISTORY', 'history'))
  })

  it('prefers a substring that starts earlier', () => {
    const early = fuzzyScore('code editor', 'edit') as number
    const late = fuzzyScore('a much longer thing to edit', 'edit') as number
    expect(early).toBeGreaterThan(late)
  })

  it('prefers the shorter of two otherwise equal matches', () => {
    expect(fuzzyScore('Notes', 'note')).toBeGreaterThan(
      fuzzyScore('Notes and things', 'note') as number,
    )
  })

  it('makes initials work — the reason a palette is faster than the sidebar', () => {
    // "vc" should find Vibe coding by hitting the start of both words.
    expect(fuzzyScore('Vibe coding', 'vc')).not.toBeNull()
    expect(fuzzyScore('Vibe coding', 'vc')).toBeGreaterThan(
      fuzzyScore('Advanced controls', 'vc') as number,
    )
  })

  it('rewards a tight subsequence over one strung across the whole string', () => {
    const tight = fuzzyScore('set model', 'stm') as number
    const loose = fuzzyScore('scratchpad text and meetings', 'stm') as number
    expect(tight).toBeGreaterThan(loose)
  })
})

describe('scoreCommand', () => {
  it('finds a command by a synonym it does not contain', () => {
    const score = scoreCommand({ title: 'Scratchpad', keywords: ['notes'] }, 'notes')
    expect(score).not.toBeNull()
  })

  it('never lets a synonym outrank a real name', () => {
    // "notes" must find Scratchpad, but Scratchpad must not jump over a
    // command actually called Notes.
    const ranked = rankBy(
      [{ title: 'Scratchpad', keywords: ['notes', 'jot'] }, { title: 'Notes' }],
      'notes',
    )
    expect(titles(ranked)[0]).toBe('Notes')
  })

  it('lets a title match beat a synonym on another command', () => {
    // Typing "the" should reach the commands whose titles say *theme*, not the
    // one that merely lists it as a keyword.
    const ranked = rankBy(
      [
        { title: 'Settings', keywords: ['theme', 'preferences'] },
        { title: 'Switch to the dark theme' },
      ],
      'the',
    )
    expect(titles(ranked)[0]).toBe('Switch to the dark theme')
  })

  it('still finds a command only its keywords describe', () => {
    const ranked = rankBy(
      [{ title: 'Models', keywords: ['whisper'] }, { title: 'History' }],
      'whisper',
    )
    expect(titles(ranked)).toEqual(['Models'])
  })

  it('ignores keywords that do not match at all', () => {
    expect(scoreCommand({ title: 'History', keywords: ['zzz'] }, 'his')).toBe(
      fuzzyScore('History', 'his'),
    )
  })
})

describe('rankBy', () => {
  const COMMANDS = [
    { title: 'Go to Dashboard' },
    { title: 'Go to History' },
    { title: 'Go to Settings' },
    { title: 'Go to Models', keywords: ['download', 'whisper'] },
    { title: 'Start dictation' },
  ]

  it('leaves the declared order alone when nothing is typed', () => {
    expect(titles(rankBy(COMMANDS, ''))).toEqual(titles(COMMANDS))
  })

  it('drops what does not match', () => {
    expect(rankBy(COMMANDS, 'qqq')).toEqual([])
  })

  it('finds a command through its keywords', () => {
    expect(titles(rankBy(COMMANDS, 'whisper'))).toEqual(['Go to Models'])
  })

  it('puts the closest match first', () => {
    expect(titles(rankBy(COMMANDS, 'hist'))[0]).toBe('Go to History')
    expect(titles(rankBy(COMMANDS, 'dict'))[0]).toBe('Start dictation')
  })

  it('is stable, so equal scores keep their declared order', () => {
    const equal = [{ title: 'Alpha thing' }, { title: 'Alpha other' }, { title: 'Alpha third' }]
    expect(titles(rankBy(equal, ''))).toEqual(titles(equal))
  })

  it('does not mutate the list it was given', () => {
    const before = titles(COMMANDS)
    rankBy(COMMANDS, 'set')
    expect(titles(COMMANDS)).toEqual(before)
  })
})
