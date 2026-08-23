import { describe, expect, it } from 'vitest'

import type { DictationRecord } from '../src/domain/dictation'
import type { Note } from '../src/domain/note'
import {
  BACKUP_VERSION,
  backupFileName,
  buildBackup,
  csvField,
  historyExportFileName,
  historyToCsv,
  historyToMarkdown,
  historyToText,
  noteFileName,
  noteToMarkdown,
  readBackup,
  serializeHistory,
  summarizeBackup,
  uniqueFileNames,
} from '../src/domain/backup'

const record = (overrides: Partial<DictationRecord> = {}): DictationRecord => ({
  id: 'a',
  ts: Date.parse('2026-08-01T10:00:00Z'),
  rawText: 'um so we should ship it',
  polishedText: 'We should ship it.',
  appBundleId: 'com.tinyspeck.slackmacgap',
  appName: 'Slack',
  appCategory: 'work',
  durationMs: 4200,
  sttModelId: 'whisper-small-en',
  polishModelId: 'gemma-3-1b',
  timings: { sttMs: 300, polishMs: 400, totalMs: 900 },
  ...overrides,
})

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'n1',
  title: '',
  body: 'Remember the milk',
  pinned: false,
  createdAt: Date.parse('2026-08-01T10:00:00Z'),
  updatedAt: Date.parse('2026-08-02T10:00:00Z'),
  ...overrides,
})

describe('csvField', () => {
  it('leaves ordinary text alone', () => {
    expect(csvField('hello world')).toBe('hello world')
  })

  it('quotes anything containing a comma, a quote or a newline', () => {
    // All three appear constantly in dictated prose, and all three silently
    // corrupt a naive join.
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('line one\nline two')).toBe('"line one\nline two"')
  })

  it('defuses a leading character a spreadsheet would treat as a formula', () => {
    // The classic CSV-injection case: a transcript starting with "=" is a
    // formula to Excel, not text.
    expect(csvField('=SUM(A1)')).toBe(`"'=SUM(A1)"`)
    expect(csvField('+1 for that')).toBe(`"'+1 for that"`)
    expect(csvField('-- so anyway')).toBe(`"'-- so anyway"`)
    expect(csvField('@channel')).toBe(`"'@channel"`)
  })

  it('handles the empty string', () => {
    expect(csvField('')).toBe('')
  })
})

describe('historyToCsv', () => {
  it('writes a header and one row per dictation', () => {
    const csv = historyToCsv([record(), record({ id: 'b' })])
    const lines = csv.trimEnd().split('\r\n')
    expect(lines[0]).toContain('timestamp,iso,text')
    expect(lines).toHaveLength(3)
  })

  it('uses CRLF, which is what the RFC says and what Excel expects', () => {
    expect(historyToCsv([record()])).toContain('\r\n')
  })

  it('exports the polished text as the text column and keeps the raw one too', () => {
    const csv = historyToCsv([record()])
    expect(csv).toContain('We should ship it.')
    expect(csv).toContain('um so we should ship it')
  })

  it('falls back to the raw text when nothing was polished', () => {
    const csv = historyToCsv([record({ polishedText: null })])
    expect(csv).toContain('um so we should ship it')
  })

  it('survives a dictation containing every awkward character at once', () => {
    const nasty = record({ polishedText: 'He said "go", then\nleft, quickly' })
    const csv = historyToCsv([nasty])
    expect(csv).toContain('"He said ""go"", then\nleft, quickly"')
  })

  it('produces a header even with nothing to export', () => {
    expect(historyToCsv([]).trimEnd()).toBe(
      'timestamp,iso,text,raw_text,app,app_category,duration_ms,stt_model,polish_model',
    )
  })
})

describe('historyToMarkdown', () => {
  it('reads forwards, oldest first — a document is not a feed', () => {
    const md = historyToMarkdown([
      record({ id: 'new', ts: 2_000_000_000_000, polishedText: 'Second' }),
      record({ id: 'old', ts: 1_000_000_000_000, polishedText: 'First' }),
    ])
    expect(md.indexOf('First')).toBeLessThan(md.indexOf('Second'))
  })

  it('groups under one heading per day', () => {
    const day = Date.parse('2026-08-01T10:00:00Z')
    const md = historyToMarkdown([
      record({ id: '1', ts: day }),
      record({ id: '2', ts: day + 3_600_000 }),
      record({ id: '3', ts: day + 86_400_000 * 2 }),
    ])
    expect(md.match(/^## /gm)).toHaveLength(2)
  })

  it('names the app when one was recorded, and stays quiet when not', () => {
    expect(historyToMarkdown([record()])).toContain('· Slack')
    expect(historyToMarkdown([record({ appName: null, appBundleId: null })])).not.toContain('·')
  })

  it('takes a title, so an export of a filtered view says what it is', () => {
    expect(historyToMarkdown([record()], 'Selected dictations')).toContain('# Selected dictations')
  })
})

describe('historyToText', () => {
  it('is just the words, one paragraph each', () => {
    const text = historyToText([
      record({ id: '1', ts: 1, polishedText: 'One' }),
      record({ id: '2', ts: 2, polishedText: 'Two' }),
    ])
    expect(text).toBe('One\n\nTwo\n')
  })
})

describe('serializeHistory', () => {
  it('covers every format it advertises', () => {
    for (const format of ['json', 'csv', 'md', 'txt'] as const) {
      expect(serializeHistory([record()], format).length).toBeGreaterThan(0)
    }
  })

  it('produces JSON that parses back to the same records', () => {
    const parsed = JSON.parse(serializeHistory([record()], 'json')) as DictationRecord[]
    expect(parsed[0]?.polishedText).toBe('We should ship it.')
  })
})

describe('noteToMarkdown', () => {
  it('carries the metadata in front matter, so it is useful outside Murmur', () => {
    const md = noteToMarkdown(note({ title: 'Groceries' }))
    expect(md).toContain('---\ntitle: Groceries\n')
    expect(md).toContain('created: 2026-08-01T10:00:00.000Z')
    expect(md).toContain('# Groceries')
  })

  it('does not repeat a title that was only derived from the body', () => {
    // The heading would otherwise duplicate the first line of the note.
    const md = noteToMarkdown(note())
    expect(md).toContain('title: Remember the milk')
    expect(md).not.toContain('# Remember the milk')
  })

  it('quotes a title that could be mistaken for YAML', () => {
    expect(noteToMarkdown(note({ title: 'due: tomorrow' }))).toContain('title: "due: tomorrow"')
  })

  it('records a pin and stays silent about an unpinned note', () => {
    expect(noteToMarkdown(note({ pinned: true }))).toContain('pinned: true')
    expect(noteToMarkdown(note())).not.toContain('pinned:')
  })
})

describe('noteFileName', () => {
  it('names the file after the note', () => {
    expect(noteFileName(note({ title: 'Shopping list' }), 0)).toBe('Shopping list.md')
  })

  it('strips the characters Windows refuses', () => {
    const name = noteFileName(note({ title: 'a/b\\c:d*e?f"g<h>i|j' }), 0)
    expect(name).not.toMatch(/[\\/:*?"<>|]/)
  })

  it('renames a note that would collide with a Windows device name', () => {
    // `con.md` cannot be created on Windows, and the failure is inscrutable.
    expect(noteFileName(note({ title: 'CON' }), 3)).toBe('note-4.md')
    expect(noteFileName(note({ title: 'lpt1' }), 0)).toBe('note-1.md')
  })

  it('uses the note placeholder for an empty note, and numbers only what has no name at all', () => {
    // An empty note already has a name — "Untitled note" — and `uniqueFileNames`
    // keeps several of them apart. Only a title that survives sanitising as an
    // empty string needs a number.
    expect(noteFileName(note({ title: '', body: '' }), 6)).toBe('Untitled note.md')
    expect(noteFileName(note({ title: '///', body: '///' }), 0)).toBe('note-1.md')
  })

  it('never ends in a dot or a space', () => {
    expect(noteFileName(note({ title: 'Trailing.  ' }), 0)).toBe('Trailing.md')
  })

  it('keeps names short enough to survive a real filesystem', () => {
    const long = noteFileName(note({ title: 'x'.repeat(500) }), 0)
    expect(long.length).toBeLessThanOrEqual(64)
  })
})

describe('uniqueFileNames', () => {
  it('leaves distinct names alone', () => {
    expect(uniqueFileNames(['a.md', 'b.md'])).toEqual(['a.md', 'b.md'])
  })

  it('suffixes repeats instead of overwriting them', () => {
    expect(uniqueFileNames(['a.md', 'a.md', 'a.md'])).toEqual(['a.md', 'a (2).md', 'a (3).md'])
  })

  it('treats names that differ only in case as the same file', () => {
    // macOS and Windows are case-insensitive; writing both would lose one.
    expect(uniqueFileNames(['Note.md', 'note.md'])).toEqual(['Note.md', 'note (2).md'])
  })
})

describe('buildBackup and readBackup', () => {
  const input = {
    createdAt: Date.parse('2026-08-23T12:00:00Z'),
    appVersion: '0.5.4',
    dictionary: [],
    snippets: [],
    notes: [note()],
    history: [record()],
    settings: { appearance: 'dark' } as Record<string, unknown>,
  }

  it('round-trips through JSON', () => {
    const backup = buildBackup(input)
    const result = readBackup(JSON.parse(JSON.stringify(backup)))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup.notes).toHaveLength(1)
    expect(result.backup.history).toHaveLength(1)
    expect(result.backup.settings).toEqual({ appearance: 'dark' })
  })

  it('stamps the format version, not the app version', () => {
    const backup = buildBackup(input)
    expect(backup.version).toBe(BACKUP_VERSION)
    expect(backup.appVersion).toBe('0.5.4')
  })

  it('rejects a file that is not a backup at all, and says so', () => {
    for (const value of [null, 42, 'text', {}, { version: 1 }, []]) {
      const result = readBackup(value)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toBe('not-a-backup')
    }
  })

  it('refuses a backup from a newer Murmur rather than half-importing it', () => {
    const result = readBackup({ ...buildBackup(input), version: BACKUP_VERSION + 1 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('too-new')
    expect(result.detail).toContain('newer version')
  })

  it('reports a corrupt backup differently from a wrong file', () => {
    const result = readBackup({ ...buildBackup(input), notes: [{ nonsense: true }] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('malformed')
  })

  it('accepts a backup missing sections a later version added', () => {
    // Forwards compatibility in the direction that matters: an old backup must
    // still restore into a newer app.
    const result = readBackup({
      murmurBackup: true,
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.backup.notes).toEqual([])
    expect(result.backup.settings).toBeNull()
  })

  it('summarises what a restore would do', () => {
    const summary = summarizeBackup(buildBackup(input))
    expect(summary).toMatchObject({ notes: 1, history: 1, dictionary: 0, settings: true })
  })
})

describe('file names', () => {
  it('sorts by date and says what it is', () => {
    const at = Date.parse('2026-08-23T12:00:00')
    expect(backupFileName(at)).toBe('Murmur backup 2026-08-23.json')
    expect(historyExportFileName(at, 'csv')).toBe('Murmur dictations 2026-08-23.csv')
  })

  it('pads single-digit months and days', () => {
    const at = Date.parse('2026-01-05T12:00:00')
    expect(backupFileName(at)).toBe('Murmur backup 2026-01-05.json')
  })
})
