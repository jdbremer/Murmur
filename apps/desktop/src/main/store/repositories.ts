import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import {
  AppCategorySchema,
  DictationRecordSchema,
  DictionaryEntrySchema,
  MeetingRecordSchema,
  StyleProfileSchema,
  createDefaultStyleProfiles,
  healStyleProfiles,
  type DictationRecord,
  type DictionaryEntry,
  type DictionaryEntryDraft,
  type DictionaryEntryPatch,
  type HistoryPage,
  type HistoryQuery,
  type HistoryStats,
  type MeetingRecord,
  type StyleProfile,
  type StyleProfilePatch,
  type StyleProfileSet,
} from '@murmur/shared'

import { averageWpm, computeStreak, countedText, countWords, dayKey } from './stats'

/**
 * Repositories over the SQLite schema (PLAN §9).
 *
 * `better-sqlite3` is synchronous, which is exactly what a main-process store
 * wants: no await points means no interleaving between "read the settings" and
 * "write the history row", and the whole dictation loop's persistence is a
 * couple of hundred microseconds.
 *
 * Everything crossing the IPC boundary is re-validated through the shared zod
 * schemas on the way out, so a hand-edited database cannot inject a shape the
 * renderer does not expect.
 */

interface DictationRow {
  id: string
  ts: number
  raw_text: string
  polished_text: string | null
  app_bundle_id: string | null
  app_category: string
  duration_ms: number
  stt_model: string
  polish_model: string | null
  timings_json: string
}

function toRecord(row: DictationRow): DictationRecord {
  let timings: unknown
  try {
    timings = JSON.parse(row.timings_json)
  } catch {
    timings = {}
  }
  const parsedTimings = timings as Partial<DictationRecord['timings']>

  return DictationRecordSchema.parse({
    id: row.id,
    ts: row.ts,
    rawText: row.raw_text,
    polishedText: row.polished_text,
    appBundleId: row.app_bundle_id,
    appCategory: AppCategorySchema.catch('other').parse(row.app_category),
    durationMs: row.duration_ms,
    sttModelId: row.stt_model,
    polishModelId: row.polish_model,
    timings: {
      sttMs: parsedTimings.sttMs ?? 0,
      polishMs: parsedTimings.polishMs ?? 0,
      totalMs: parsedTimings.totalMs ?? 0,
    },
  })
}

/** What the orchestrator hands over after a successful dictation. */
export type DictationDraft = Omit<DictationRecord, 'id'> & { id?: string }

export class DictationsRepository {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  insert(draft: DictationDraft): DictationRecord {
    const record = DictationRecordSchema.parse({ ...draft, id: draft.id ?? randomUUID() })

    // The row and the lifetime counters move together or not at all: a crash
    // between them would leave the header permanently disagreeing with the
    // history below it, and nothing ever recomputes the counters to notice.
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO dictations
             (id, ts, raw_text, polished_text, app_bundle_id, app_category,
              duration_ms, stt_model, polish_model, timings_json)
           VALUES (@id, @ts, @rawText, @polishedText, @appBundleId, @appCategory,
                   @durationMs, @sttModelId, @polishModelId, @timingsJson)`,
        )
        .run({
          id: record.id,
          ts: record.ts,
          rawText: record.rawText,
          polishedText: record.polishedText,
          appBundleId: record.appBundleId,
          appCategory: record.appCategory,
          durationMs: record.durationMs,
          sttModelId: record.sttModelId,
          polishModelId: record.polishModelId,
          timingsJson: JSON.stringify(record.timings),
        })

      const words = countWords(countedText(record.polishedText, record.rawText))
      const timed = record.durationMs > 0 && words > 0

      this.#db
        .prepare(
          `UPDATE lifetime_stats
              SET total_words = total_words + ?,
                  timed_words = timed_words + ?,
                  spoken_ms   = spoken_ms + ?
            WHERE id = 1`,
        )
        .run(words, timed ? words : 0, timed ? record.durationMs : 0)

      this.#db
        .prepare(`INSERT OR IGNORE INTO dictation_days (day) VALUES (?)`)
        .run(dayKey(record.ts))
    })()

    return record
  }

  /**
   * Reverse-chronological page, optionally full-text filtered.
   *
   * The search path goes through the FTS5 index and joins back to the base
   * table; the unfiltered path skips FTS entirely, which is what keeps "open
   * the Hub" fast on a large history.
   */
  query(request: HistoryQuery): HistoryPage {
    const search = request.search.trim()

    if (!search) {
      const rows = this.#db
        .prepare(`SELECT * FROM dictations ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`)
        .all(request.limit, request.offset) as DictationRow[]
      const total = this.#db.prepare(`SELECT COUNT(*) AS n FROM dictations`).get() as { n: number }
      return { records: rows.map(toRecord), total: total.n }
    }

    const match = toFtsQuery(search)
    if (!match) return { records: [], total: 0 }

    const rows = this.#db
      .prepare(
        `SELECT d.* FROM dictations d
           JOIN dictations_fts f ON f.rowid = d.rowid
          WHERE dictations_fts MATCH ?
          ORDER BY d.ts DESC, d.rowid DESC
          LIMIT ? OFFSET ?`,
      )
      .all(match, request.limit, request.offset) as DictationRow[]

    const total = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM dictations d
           JOIN dictations_fts f ON f.rowid = d.rowid
          WHERE dictations_fts MATCH ?`,
      )
      .get(match) as { n: number }

    return { records: rows.map(toRecord), total: total.n }
  }

  get(id: string): DictationRecord | null {
    const row = this.#db.prepare(`SELECT * FROM dictations WHERE id = ?`).get(id) as
      DictationRow | undefined
    return row ? toRecord(row) : null
  }

  delete(id: string): boolean {
    return this.#db.prepare(`DELETE FROM dictations WHERE id = ?`).run(id).changes > 0
  }

  /**
   * Delete everything, lifetime counters included.
   *
   * The one place the totals go backwards. "Delete all my dictations" is an
   * explicit, confirmed act of erasure, and leaving a word count and a streak
   * standing afterwards would misrepresent what was deleted — unlike the
   * retention sweep below, which the user did not press a button for.
   */
  clear(): number {
    return this.#db.transaction(() => {
      const changes = this.#db.prepare(`DELETE FROM dictations`).run().changes
      this.#db
        .prepare(
          `UPDATE lifetime_stats SET total_words = 0, timed_words = 0, spoken_ms = 0 WHERE id = 1`,
        )
        .run()
      this.#db.prepare(`DELETE FROM dictation_days`).run()
      return changes
    })()
  }

  /**
   * Drop rows older than `cutoff` (epoch ms) — the retention sweep (PLAN §9).
   *
   * Deliberately leaves the lifetime counters alone: retention governs how long
   * the *text* is kept, not whether the dictation happened.
   */
  pruneOlderThan(cutoff: number): number {
    return this.#db.prepare(`DELETE FROM dictations WHERE ts < ?`).run(cutoff).changes
  }

  /**
   * The Home header's numbers — **lifetime**, not a window over the rows.
   *
   * Read from the counters rather than aggregated over `dictations` on purpose:
   * history is subject to a retention policy (PLAN §9), and deriving the totals
   * from it made "words dictated" quietly fall every time the sweep ran. What
   * the user dictated is a fact about the past; deleting the transcript for
   * privacy does not un-speak it. Only an explicit `clear()` resets these.
   */
  stats(now?: number): HistoryStats {
    const totals = this.#db
      .prepare(`SELECT total_words, timed_words, spoken_ms FROM lifetime_stats WHERE id = 1`)
      .get() as { total_words: number; timed_words: number; spoken_ms: number } | undefined

    const { total_words, timed_words, spoken_ms } = totals ?? {
      total_words: 0,
      timed_words: 0,
      spoken_ms: 0,
    }

    const days = new Set(
      (this.#db.prepare(`SELECT day FROM dictation_days`).all() as { day: string }[]).map(
        (row) => row.day,
      ),
    )

    return {
      totalWords: total_words,
      avgWpm: averageWpm(timed_words, spoken_ms),
      streakDays: computeStreak(days, now ?? Date.now()),
    }
  }

  count(): number {
    return (this.#db.prepare(`SELECT COUNT(*) AS n FROM dictations`).get() as { n: number }).n
  }
}

/**
 * Turn a user's search box contents into an FTS5 MATCH expression.
 *
 * FTS5's query language treats `"`, `*`, `:`, `^`, `-`, `(`, `)` and `NEAR` as
 * syntax, so an unescaped user string is both a crash risk and a source of
 * baffling "fts5: syntax error" toasts. Every term is therefore quoted as a
 * literal and a trailing `*` is added for prefix matching, which is what people
 * actually expect from a search box.
 */
export function toFtsQuery(search: string): string | null {
  const terms = search
    .split(/\s+/)
    .map((term) => term.replace(/"/g, '').trim())
    .filter((term) => term.length > 0)
  if (terms.length === 0) return null
  return terms.map((term) => `"${term}"*`).join(' AND ')
}

// ---------------------------------------------------------------------------
// Dictionary
// ---------------------------------------------------------------------------

interface DictionaryRow {
  id: string
  term: string
  replacement: string | null
  enabled: number
}

function toDictionaryEntry(row: DictionaryRow): DictionaryEntry {
  return DictionaryEntrySchema.parse({
    id: row.id,
    term: row.term,
    replacement: row.replacement,
    enabled: row.enabled !== 0,
  })
}

export class DictionaryRepository {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  list(): DictionaryEntry[] {
    const rows = this.#db
      .prepare(`SELECT * FROM dictionary ORDER BY term COLLATE NOCASE ASC`)
      .all() as DictionaryRow[]
    return rows.map(toDictionaryEntry)
  }

  /** Enabled terms only — what feeds the prompt builder and `initial_prompt`. */
  enabled(): DictionaryEntry[] {
    return this.list().filter((entry) => entry.enabled)
  }

  create(draft: DictionaryEntryDraft): DictionaryEntry {
    const entry = DictionaryEntrySchema.parse({ ...draft, id: randomUUID() })
    this.#db
      .prepare(
        `INSERT INTO dictionary (id, term, replacement, enabled) VALUES (?, ?, ?, ?)
         ON CONFLICT(term COLLATE NOCASE) DO UPDATE SET
           replacement = excluded.replacement,
           enabled = excluded.enabled`,
      )
      .run(entry.id, entry.term, entry.replacement, entry.enabled ? 1 : 0)

    // The upsert may have hit an existing row, whose id we must return.
    const stored = this.#db
      .prepare(`SELECT * FROM dictionary WHERE term = ? COLLATE NOCASE`)
      .get(entry.term) as DictionaryRow | undefined
    return stored ? toDictionaryEntry(stored) : entry
  }

  update(id: string, patch: DictionaryEntryPatch): DictionaryEntry {
    const existing = this.#db.prepare(`SELECT * FROM dictionary WHERE id = ?`).get(id) as
      DictionaryRow | undefined
    if (!existing) throw new Error(`No dictionary entry with id "${id}"`)

    const next = DictionaryEntrySchema.parse({
      id,
      term: patch.term ?? existing.term,
      replacement: patch.replacement === undefined ? existing.replacement : patch.replacement,
      enabled: patch.enabled ?? existing.enabled !== 0,
    })

    this.#db
      .prepare(`UPDATE dictionary SET term = ?, replacement = ?, enabled = ? WHERE id = ?`)
      .run(next.term, next.replacement, next.enabled ? 1 : 0, id)
    return next
  }

  delete(id: string): boolean {
    return this.#db.prepare(`DELETE FROM dictionary WHERE id = ?`).run(id).changes > 0
  }
}

/**
 * Post-STT replacement rules (PLAN §6.4). Runs before polishing, so the polish
 * prompt sees — and preserves — the corrected spelling.
 *
 * Matching is whole-word and case-insensitive, and the replacement inherits the
 * original's capitalisation when the original was capitalised. That is what
 * makes "eta → ETA" behave at the start of a sentence without a second rule.
 */
export function applyReplacements(text: string, entries: readonly DictionaryEntry[]): string {
  let out = text
  for (const entry of entries) {
    if (!entry.enabled || !entry.replacement) continue
    const pattern = new RegExp(`\\b${escapeRegExp(entry.term)}\\b`, 'gi')
    out = out.replace(pattern, (match) => matchCase(match, entry.replacement ?? match))
  }
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchCase(original: string, replacement: string): string {
  // An all-caps replacement ("ETA") is a deliberate spelling; leave it alone.
  if (replacement === replacement.toUpperCase() && replacement !== replacement.toLowerCase()) {
    return replacement
  }
  const firstChar = original[0]
  if (firstChar && firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1)
  }
  return replacement
}

// ---------------------------------------------------------------------------
// Style profiles
// ---------------------------------------------------------------------------

interface StyleRow {
  category: string
  formality: string
  filler_handling: string
  emoji: string
  custom_instructions: string
}

export class StyleRepository {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
    this.#seed()
  }

  /** One profile per category, always complete — missing rows are re-seeded. */
  get(): StyleProfileSet {
    const rows = this.#db.prepare(`SELECT * FROM style_profiles`).all() as StyleRow[]
    const byCategory = new Map(rows.map((row) => [row.category, row]))

    const stored = createDefaultStyleProfiles().map((fallback) => {
      const row = byCategory.get(fallback.category)
      if (!row) return fallback
      const parsed = StyleProfileSchema.safeParse({
        category: row.category,
        formality: row.formality,
        fillerHandling: row.filler_handling,
        emoji: row.emoji,
        customInstructions: row.custom_instructions,
      })
      return parsed.success ? parsed.data : fallback
    })

    // Retired tones (`neutral`, the pre-Styles default) become the category's
    // current one. Read-time rather than a SQL migration on purpose: the value
    // still parses, so nothing is broken until it is *displayed*, and healing
    // where it is read keeps the rule next to the only code that cares.
    return healStyleProfiles(stored)
  }

  /** The profile for one app category — what the prompt builder asks for. */
  forCategory(category: StyleProfile['category']): StyleProfile {
    const profiles = this.get()
    return profiles.find((profile) => profile.category === category) ?? profiles[0]!
  }

  set(patch: StyleProfilePatch): StyleProfileSet {
    const current = this.forCategory(patch.category)
    const next = StyleProfileSchema.parse({
      category: patch.category,
      formality: patch.formality ?? current.formality,
      fillerHandling: patch.fillerHandling ?? current.fillerHandling,
      emoji: patch.emoji ?? current.emoji,
      customInstructions: patch.customInstructions ?? current.customInstructions,
    })

    this.#db
      .prepare(
        `INSERT INTO style_profiles
           (category, formality, filler_handling, emoji, custom_instructions)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(category) DO UPDATE SET
           formality = excluded.formality,
           filler_handling = excluded.filler_handling,
           emoji = excluded.emoji,
           custom_instructions = excluded.custom_instructions`,
      )
      .run(next.category, next.formality, next.fillerHandling, next.emoji, next.customInstructions)

    return this.get()
  }

  #seed(): void {
    const insert = this.#db.prepare(
      `INSERT OR IGNORE INTO style_profiles
         (category, formality, filler_handling, emoji, custom_instructions)
       VALUES (?, ?, ?, ?, ?)`,
    )
    this.#db.transaction((profiles: StyleProfileSet) => {
      for (const profile of profiles) {
        insert.run(
          profile.category,
          profile.formality,
          profile.fillerHandling,
          profile.emoji,
          profile.customInstructions,
        )
      }
    })(createDefaultStyleProfiles())
  }
}

/**
 * Index of recorded meetings (PLAN §18.2).
 *
 * An index, not a store: the transcript lives in the Markdown file at `path`
 * and is never copied in here. That means a row can outlive its file — the
 * user is free to move or delete a transcript from Finder — so every reader
 * has to treat the file as possibly missing rather than implied by the row.
 */
export class MeetingsRepository {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  save(record: MeetingRecord): MeetingRecord {
    const parsed = MeetingRecordSchema.parse(record)
    this.#db
      .prepare(
        `INSERT INTO meetings
           (id, started_at, ended_at, title, path, app_bundle_id,
            had_system_audio, segment_count, duration_ms)
         VALUES (@id, @startedAt, @endedAt, @title, @path, @appBundleId,
                 @hadSystemAudio, @segmentCount, @durationMs)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at,
           title = excluded.title,
           path = excluded.path,
           segment_count = excluded.segment_count,
           duration_ms = excluded.duration_ms`,
      )
      .run({
        id: parsed.id,
        startedAt: parsed.startedAt,
        endedAt: parsed.endedAt,
        title: parsed.title,
        path: parsed.path,
        appBundleId: parsed.appBundleId,
        hadSystemAudio: parsed.hadSystemAudio ? 1 : 0,
        segmentCount: parsed.segmentCount,
        durationMs: parsed.durationMs,
      })
    return parsed
  }

  list(limit = 200): MeetingRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT id, started_at, ended_at, title, path, app_bundle_id,
                had_system_audio, segment_count, duration_ms
           FROM meetings
          ORDER BY started_at DESC
          LIMIT ?`,
      )
      .all(limit) as MeetingRow[]
    return rows.map(toMeeting)
  }

  get(id: string): MeetingRecord | null {
    const row = this.#db
      .prepare(
        `SELECT id, started_at, ended_at, title, path, app_bundle_id,
                had_system_audio, segment_count, duration_ms
           FROM meetings WHERE id = ?`,
      )
      .get(id) as MeetingRow | undefined
    return row ? toMeeting(row) : null
  }

  delete(id: string): boolean {
    return this.#db.prepare(`DELETE FROM meetings WHERE id = ?`).run(id).changes > 0
  }
}

interface MeetingRow {
  id: string
  started_at: number
  ended_at: number | null
  title: string
  path: string
  app_bundle_id: string | null
  had_system_audio: number
  segment_count: number
  duration_ms: number
}

function toMeeting(row: MeetingRow): MeetingRecord {
  return MeetingRecordSchema.parse({
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    title: row.title,
    path: row.path,
    appBundleId: row.app_bundle_id,
    hadSystemAudio: row.had_system_audio === 1,
    segmentCount: row.segment_count,
    durationMs: row.duration_ms,
  })
}
