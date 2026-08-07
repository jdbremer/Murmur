import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import SQLite, { type Database } from 'better-sqlite3'

import { createNullLogger } from '../src/main/logging'
import { checkIntegrity, databasePath, openDatabase } from '../src/main/store/db'
import { LATEST_SCHEMA_VERSION, currentVersion, migrate } from '../src/main/store/migrations'
import {
  applyReplacements,
  DictationsRepository,
  DictionaryRepository,
  StyleRepository,
  toFtsQuery,
} from '../src/main/store/repositories'

/**
 * SQLite store (PLAN §9, §15.2).
 *
 * The data-safety requirements — WAL, boot integrity check, corrupt-file
 * recovery, pre-migration backup — are the ones that decide whether a user's
 * history survives a bad day, so each gets an explicit test against a real
 * database file rather than a mock.
 */

const log = createNullLogger()
let directory: string
let db: Database

function open(): ReturnType<typeof openDatabase> {
  return openDatabase(databasePath(directory), { log })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'murmur-db-'))
  db = open().db
})

afterEach(() => {
  try {
    db.close()
  } catch {
    /* already closed */
  }
  rmSync(directory, { recursive: true, force: true })
})

describe('openDatabase', () => {
  it('creates the schema, in WAL mode, at the latest version', () => {
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(currentVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    expect(checkIntegrity(db)).toBeNull()
  })

  it('is idempotent across reopens', () => {
    db.close()
    const second = open()
    expect(second.appliedMigrations).toEqual([])
    expect(second.recoveredFrom).toBeNull()
    db = second.db
  })

  it('quarantines a corrupt file and re-initialises rather than crash-looping', () => {
    db.close()
    const path = databasePath(directory)
    // Not a SQLite file at all — the classic "disk went bad" symptom.
    writeFileSync(path, 'this is definitely not a database, not even a little bit')

    const result = open()
    db = result.db

    expect(result.recoveredFrom).not.toBeNull()
    // The old bytes are kept: a user's history is not ours to throw away.
    expect(readFileSync(result.recoveredFrom!, 'utf8')).toContain('not a database')
    expect(currentVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    expect(checkIntegrity(db)).toBeNull()
  })

  it('takes a pre-migration backup when an older schema is upgraded', () => {
    db.close()
    const path = databasePath(directory)

    // Simulate a v0 database with some content the migration must not lose.
    const old = new SQLite(path)
    old.pragma('journal_mode = WAL')
    old.exec('CREATE TABLE legacy (id INTEGER PRIMARY KEY)')
    old.pragma('user_version = 0')
    old.close()

    // A version-0 file is treated as brand new (nothing to back up)…
    const first = open()
    expect(first.backupPath).toBeNull()
    expect(first.appliedMigrations.length).toBeGreaterThan(0)
    db = first.db
  })

  it('refuses a database newer than this build understands', () => {
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 5}`)
    expect(() => migrate(db)).toThrow(/newer than this build supports/)
  })

  it('backfills lifetime stats from a v1 history rather than resetting them', () => {
    // A user upgrading into the lifetime-stats migration has a history but no
    // counters. Zeroing their word count on upgrade would look exactly like the
    // bug the migration exists to fix.
    // Rewind to a genuine v1 shape: everything migrations 2 and 3 introduced
    // has to go, or replaying them collides with tables that already exist.
    db.exec(`
      DELETE FROM lifetime_stats;
      DELETE FROM dictation_days;
      DROP TABLE lifetime_stats;
      DROP TABLE dictation_days;
      DROP TABLE meetings;
    `)
    const ts = Date.parse('2026-08-01T12:00:00')
    db.prepare(
      `INSERT INTO dictations
         (id, ts, raw_text, polished_text, app_category, duration_ms, stt_model, timings_json)
       VALUES (?, ?, ?, ?, 'work', ?, 'whisper-small-en', '{}')`,
    ).run('a', ts, 'um so we should uh ship it wednesday', 'We should ship it on Wednesday.', 6_000)
    db.pragma('user_version = 1')

    expect(migrate(db).applied).toEqual(['2:lifetime-stats', '3:meetings'])

    // The polished text's 6 words, at 6 words / 6 s = 60 wpm, on one day.
    expect(new DictationsRepository(db).stats(ts)).toEqual({
      totalWords: 6,
      avgWpm: 60,
      streakDays: 1,
    })
  })
})

describe('DictationsRepository', () => {
  let repository: DictationsRepository

  const draft = (overrides: Partial<Parameters<DictationsRepository['insert']>[0]> = {}) => ({
    ts: Date.parse('2026-08-01T10:00:00Z'),
    rawText: 'um so we should ship it on wednesday',
    polishedText: 'We should ship it on Wednesday.',
    appBundleId: 'com.tinyspeck.slackmacgap',
    appCategory: 'work' as const,
    durationMs: 4200,
    sttModelId: 'whisper-small-en',
    polishModelId: 'gemma-3-1b-it-qat-q4_0',
    timings: { sttMs: 300, polishMs: 400, totalMs: 900 },
    ...overrides,
  })

  beforeEach(() => {
    repository = new DictationsRepository(db)
  })

  it('inserts and reads back a complete record', () => {
    const record = repository.insert(draft())
    expect(record.id).toMatch(/[0-9a-f-]{36}/)

    const fetched = repository.get(record.id)
    expect(fetched).toMatchObject({
      rawText: draft().rawText,
      polishedText: draft().polishedText,
      appCategory: 'work',
      timings: { sttMs: 300, polishMs: 400, totalMs: 900 },
    })
  })

  it('returns pages newest first', () => {
    repository.insert(draft({ ts: 1000, rawText: 'oldest' }))
    repository.insert(draft({ ts: 3000, rawText: 'newest' }))
    repository.insert(draft({ ts: 2000, rawText: 'middle' }))

    const page = repository.query({ search: '', limit: 50, offset: 0 })
    expect(page.total).toBe(3)
    expect(page.records.map((record) => record.rawText)).toEqual(['newest', 'middle', 'oldest'])
  })

  it('pages with limit and offset', () => {
    for (let index = 0; index < 10; index += 1) {
      repository.insert(draft({ ts: 1000 + index, rawText: `row ${index}` }))
    }
    const page = repository.query({ search: '', limit: 3, offset: 3 })
    expect(page.records).toHaveLength(3)
    expect(page.total).toBe(10)
    expect(page.records[0]?.rawText).toBe('row 6')
  })

  it('full-text searches both raw and polished columns', () => {
    repository.insert(draft({ rawText: 'ship the kubernetes migration', polishedText: null }))
    repository.insert(
      draft({ rawText: 'unrelated', polishedText: 'Deploy the Kubernetes cluster.' }),
    )
    repository.insert(draft({ rawText: 'nothing to see', polishedText: 'Nothing to see.' }))

    const hits = repository.query({ search: 'kubernetes', limit: 50, offset: 0 })
    expect(hits.total).toBe(2)
  })

  it('does a prefix search, which is what a search box implies', () => {
    repository.insert(draft({ rawText: 'the migration is ready', polishedText: null }))
    expect(repository.query({ search: 'migr', limit: 50, offset: 0 }).total).toBe(1)
  })

  it('survives FTS5 syntax characters in the query', () => {
    repository.insert(draft({ rawText: 'perfectly normal text', polishedText: null }))
    for (const search of ['"', 'a AND', 'NEAR(', '*', 'x:y', '-foo', ')(']) {
      expect(() => repository.query({ search, limit: 50, offset: 0 })).not.toThrow()
    }
  })

  it('keeps the FTS index in step when a row is deleted', () => {
    const record = repository.insert(draft({ rawText: 'ephemeral kubernetes note' }))
    expect(repository.query({ search: 'kubernetes', limit: 50, offset: 0 }).total).toBe(1)

    expect(repository.delete(record.id)).toBe(true)
    expect(repository.query({ search: 'kubernetes', limit: 50, offset: 0 }).total).toBe(0)
    expect(repository.get(record.id)).toBeNull()
  })

  it('clears everything, index included', () => {
    repository.insert(draft())
    repository.insert(draft())
    expect(repository.clear()).toBe(2)
    expect(repository.count()).toBe(0)
    expect(repository.query({ search: 'wednesday', limit: 50, offset: 0 }).total).toBe(0)
  })

  it('prunes by retention window', () => {
    const now = Date.parse('2026-08-01T00:00:00Z')
    repository.insert(draft({ ts: now - 100 * 86_400_000 }))
    repository.insert(draft({ ts: now - 10 * 86_400_000 }))

    expect(repository.pruneOlderThan(now - 90 * 86_400_000)).toBe(1)
    expect(repository.count()).toBe(1)
  })

  describe('lifetime stats (PLAN §2.2.1)', () => {
    // Midday, so a local-timezone day key lands on the same date the fixture
    // names no matter which zone the test runner is in.
    const at = (iso: string): number => Date.parse(`${iso}T12:00:00`)

    it('is all zeros before anything has been dictated', () => {
      expect(repository.stats()).toEqual({ totalWords: 0, avgWpm: 0, streakDays: 0 })
    })

    it('counts the polished text rather than both texts', () => {
      // Raw is 8 words, polished is 6. Counting both would give 14.
      repository.insert(
        draft({
          rawText: 'um so we should uh ship it wednesday',
          polishedText: 'We should ship it on Wednesday.',
          durationMs: 6_000,
        }),
      )
      // 6 words in 6 s = 60 wpm exactly.
      expect(repository.stats()).toMatchObject({ totalWords: 6, avgWpm: 60 })
    })

    it('counts an untimed dictation’s words but keeps it out of the rate', () => {
      repository.insert(draft({ rawText: 'one two three', polishedText: null, durationMs: 6_000 }))
      repository.insert(draft({ rawText: 'four five six', polishedText: null, durationMs: 0 }))

      // All 6 words count towards the headline. The rate uses only the timed
      // dictation — 3 words in 6 s = 30 wpm. Charging the untimed words against
      // the timed seconds would report 60, which is a lie.
      expect(repository.stats()).toMatchObject({ totalWords: 6, avgWpm: 30 })
    })

    it('counts a streak of consecutive local days', () => {
      for (const iso of ['2026-07-30', '2026-07-31', '2026-08-01']) {
        repository.insert(draft({ ts: at(iso) }))
      }
      expect(repository.stats(at('2026-08-01')).streakDays).toBe(3)
    })

    it('counts a day once however many times it was dictated on', () => {
      repository.insert(draft({ ts: at('2026-08-01') }))
      repository.insert(draft({ ts: at('2026-08-01') }))
      expect(repository.stats(at('2026-08-01')).streakDays).toBe(1)
    })

    // The bug this table exists for: the totals used to be an aggregate over
    // `dictations`, so the retention sweep silently deducted words the user had
    // really dictated — and shortening the window subtracted thousands at once.
    it('survives the retention sweep untouched', () => {
      const now = at('2026-08-01')
      repository.insert(
        draft({ ts: now - 100 * 86_400_000, rawText: 'one two three', polishedText: null }),
      )
      repository.insert(
        draft({ ts: now - 10 * 86_400_000, rawText: 'four five six', polishedText: null }),
      )
      const before = repository.stats(now)
      expect(before.totalWords).toBe(6)

      expect(repository.pruneOlderThan(now - 90 * 86_400_000)).toBe(1)

      // The row is gone from history; the words it contributed are not.
      expect(repository.count()).toBe(1)
      expect(repository.stats(now)).toEqual(before)
    })

    it('keeps a streak whose earlier days have been pruned away', () => {
      const now = at('2026-08-01')
      for (const iso of ['2026-07-30', '2026-07-31', '2026-08-01']) {
        repository.insert(draft({ ts: at(iso) }))
      }
      repository.pruneOlderThan(at('2026-07-31'))

      expect(repository.count()).toBe(2)
      expect(repository.stats(now).streakDays).toBe(3)
    })

    it('resets on an explicit clear, which the sweep is not', () => {
      repository.insert(draft({ ts: at('2026-08-01') }))
      expect(repository.stats(at('2026-08-01')).totalWords).toBeGreaterThan(0)

      repository.clear()
      expect(repository.stats(at('2026-08-01'))).toEqual({
        totalWords: 0,
        avgWpm: 0,
        streakDays: 0,
      })
    })

    it('keeps counting from zero after a clear', () => {
      repository.insert(draft({ ts: at('2026-08-01') }))
      repository.clear()
      repository.insert(
        draft({ ts: at('2026-08-01'), rawText: 'one two three', polishedText: null }),
      )
      expect(repository.stats(at('2026-08-01'))).toMatchObject({ totalWords: 3, streakDays: 1 })
    })

    it('leaves the totals alone when a single row is deleted', () => {
      // Deleting one transcript is a request to forget the text, not a claim
      // that the words were never spoken. Only "clear all" resets.
      const record = repository.insert(
        draft({ ts: at('2026-08-01'), rawText: 'one two three', polishedText: null }),
      )
      expect(repository.delete(record.id)).toBe(true)
      expect(repository.count()).toBe(0)
      expect(repository.stats(at('2026-08-01')).totalWords).toBe(3)
    })
  })

  it('handles 1000 rows quickly (PLAN §13 M4: <50 ms search)', () => {
    const insert = db.transaction(() => {
      for (let index = 0; index < 1000; index += 1) {
        repository.insert(
          draft({
            ts: 1_700_000_000_000 + index,
            rawText: `row ${index} about kubernetes and things`,
          }),
        )
      }
    })
    insert()

    const started = performance.now()
    const page = repository.query({ search: 'kubernetes', limit: 50, offset: 0 })
    const elapsed = performance.now() - started

    expect(page.total).toBe(1000)
    expect(page.records).toHaveLength(50)
    expect(elapsed).toBeLessThan(200) // generous: CI machines vary
  })

  it('heals a row whose timings JSON is unreadable', () => {
    const record = repository.insert(draft())
    db.prepare('UPDATE dictations SET timings_json = ? WHERE id = ?').run('{not json', record.id)

    expect(repository.get(record.id)?.timings).toEqual({ sttMs: 0, polishMs: 0, totalMs: 0 })
  })

  it('falls back to "other" for an unrecognised app category', () => {
    const record = repository.insert(draft())
    db.prepare('UPDATE dictations SET app_category = ? WHERE id = ?').run('nonsense', record.id)

    expect(repository.get(record.id)?.appCategory).toBe('other')
  })
})

describe('toFtsQuery', () => {
  it('quotes each term and adds a prefix wildcard', () => {
    expect(toFtsQuery('hello world')).toBe('"hello"* AND "world"*')
  })

  it('strips embedded quotes rather than producing invalid syntax', () => {
    expect(toFtsQuery('say "hi"')).toBe('"say"* AND "hi"*')
  })

  it('returns null for an empty query', () => {
    expect(toFtsQuery('   ')).toBeNull()
    expect(toFtsQuery('"')).toBeNull()
  })
})

describe('DictionaryRepository', () => {
  let repository: DictionaryRepository

  beforeEach(() => {
    repository = new DictionaryRepository(db)
  })

  it('creates, lists and deletes entries', () => {
    const entry = repository.create({ term: 'Murmur', replacement: null, enabled: true })
    expect(repository.list()).toHaveLength(1)

    expect(repository.delete(entry.id)).toBe(true)
    expect(repository.list()).toHaveLength(0)
    expect(repository.delete(entry.id)).toBe(false)
  })

  it('upserts on a duplicate term rather than creating a second row', () => {
    repository.create({ term: 'eta', replacement: null, enabled: true })
    const second = repository.create({ term: 'ETA', replacement: 'ETA', enabled: true })

    expect(repository.list()).toHaveLength(1)
    expect(second.replacement).toBe('ETA')
  })

  it('updates sparsely', () => {
    const entry = repository.create({ term: 'kubernetes', replacement: null, enabled: true })
    const updated = repository.update(entry.id, { replacement: 'Kubernetes' })

    expect(updated.term).toBe('kubernetes')
    expect(updated.replacement).toBe('Kubernetes')
    expect(updated.enabled).toBe(true)
  })

  it('throws for an unknown id rather than silently creating one', () => {
    expect(() => repository.update('nope', { enabled: false })).toThrow(/No dictionary entry/)
  })

  it('filters to enabled entries for the prompt builder', () => {
    repository.create({ term: 'On', replacement: null, enabled: true })
    repository.create({ term: 'Off', replacement: null, enabled: false })
    expect(repository.enabled().map((entry) => entry.term)).toEqual(['On'])
  })

  it('sorts case-insensitively', () => {
    repository.create({ term: 'zebra', replacement: null, enabled: true })
    repository.create({ term: 'Apple', replacement: null, enabled: true })
    expect(repository.list().map((entry) => entry.term)).toEqual(['Apple', 'zebra'])
  })
})

describe('applyReplacements (PLAN §6.4)', () => {
  const entries = [
    { id: '1', term: 'murmer', replacement: 'Murmur', enabled: true },
    { id: '2', term: 'eta', replacement: 'ETA', enabled: true },
    { id: '3', term: 'boost-only', replacement: null, enabled: true },
    { id: '4', term: 'disabled', replacement: 'Enabled', enabled: false },
  ]

  it('replaces whole words, case-insensitively', () => {
    expect(applyReplacements('ship murmer today', entries)).toBe('ship Murmur today')
    expect(applyReplacements('ship MURMER today', entries)).toBe('ship Murmur today')
  })

  it('does not touch substrings inside other words', () => {
    expect(applyReplacements('murmering along', entries)).toBe('murmering along')
    expect(applyReplacements('theta wave', entries)).toBe('theta wave')
  })

  it('keeps an all-caps replacement as written', () => {
    expect(applyReplacements('whats the eta', entries)).toBe('whats the ETA')
    expect(applyReplacements('Eta please', entries)).toBe('ETA please')
  })

  it('capitalises the replacement when the original was capitalised', () => {
    expect(applyReplacements('Murmer is the name', entries)).toBe('Murmur is the name')
  })

  it('ignores boost-only and disabled entries', () => {
    expect(applyReplacements('boost-only stays disabled stays', entries)).toBe(
      'boost-only stays disabled stays',
    )
  })

  it('escapes regex metacharacters in a term', () => {
    const tricky = [{ id: '1', term: 'c++', replacement: 'C++', enabled: true }]
    expect(() => applyReplacements('i like c++ a lot', tricky)).not.toThrow()
  })
})

describe('StyleRepository', () => {
  let repository: StyleRepository

  beforeEach(() => {
    repository = new StyleRepository(db)
  })

  it('seeds one complete profile per category', () => {
    const profiles = repository.get()
    expect(profiles.map((profile) => profile.category).sort()).toEqual([
      'email',
      'other',
      'personal',
      'work',
    ])
  })

  it('patches one category and leaves the rest alone', () => {
    const updated = repository.set({ category: 'email', formality: 'formal', emoji: 'never' })

    const email = updated.find((profile) => profile.category === 'email')!
    expect(email.formality).toBe('formal')
    expect(email.emoji).toBe('never')

    // Personal ships casual while the rest ship formal, so an untouched
    // profile keeps its own default rather than a single global one.
    const personal = updated.find((profile) => profile.category === 'personal')!
    expect(personal.formality).toBe('casual')
  })

  it('persists across instances', () => {
    repository.set({ category: 'work', customInstructions: 'Never use exclamation marks.' })
    const reloaded = new StyleRepository(db)
    expect(reloaded.forCategory('work').customInstructions).toBe('Never use exclamation marks.')
  })

  it('falls back to the default when a stored row is invalid', () => {
    db.prepare('UPDATE style_profiles SET formality = ? WHERE category = ?').run('bizarre', 'work')
    expect(repository.forCategory('work').formality).toBe('formal')
  })

  it('migrates the retired neutral tone to the category default on read', () => {
    // `neutral` was the shipped default before Styles, so it is sitting in
    // every pre-existing install. It still parses — which is exactly why it
    // needs healing rather than the invalid-row fallback above: left alone it
    // would reach a Select that has no such option.
    db.prepare('UPDATE style_profiles SET formality = ?').run('neutral')

    expect(repository.forCategory('personal').formality).toBe('casual')
    expect(repository.forCategory('work').formality).toBe('formal')
    expect(repository.forCategory('email').formality).toBe('formal')
  })

  it('leaves a tone the category still offers untouched', () => {
    // The healing must not be a blanket reset — only Very Casual is
    // personal-only, and Casual is legitimate everywhere.
    repository.set({ category: 'personal', formality: 'veryCasual' })
    repository.set({ category: 'work', formality: 'casual' })

    expect(repository.forCategory('personal').formality).toBe('veryCasual')
    expect(repository.forCategory('work').formality).toBe('casual')
  })

  it('re-seeds a category whose row was deleted', () => {
    db.prepare('DELETE FROM style_profiles WHERE category = ?').run('personal')
    expect(repository.get()).toHaveLength(4)
    expect(repository.forCategory('personal').category).toBe('personal')
  })
})
