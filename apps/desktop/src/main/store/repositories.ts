import { randomUUID } from 'node:crypto'

import type { Database } from 'better-sqlite3'

import { z } from 'zod'

import {
  AppCategorySchema,
  AskCitationSchema,
  AskConversationSchema,
  AskSearchHitSchema,
  AskTurnSchema,
  DictationRecordSchema,
  DictionaryEntrySchema,
  INSIGHTS_MAX_APPS,
  INSIGHTS_MAX_DAYS,
  InsightsSchema,
  MeetingRecordSchema,
  NoteSchema,
  SnippetSchema,
  StyleProfileSchema,
  createDefaultStyleProfiles,
  healStyleProfiles,
  type AskConversation,
  type AskSearchHit,
  type AskTurn,
  type DictationRecord,
  type DictionaryEntry,
  type DictionaryEntryDraft,
  type DictionaryEntryPatch,
  type HistoryPage,
  type HistoryQuery,
  type HistoryStats,
  type Insights,
  type InsightsFixes,
  type MeetingRecord,
  type Note,
  type NoteDraft,
  type NoteList,
  type NotePatch,
  type NoteQuery,
  type Snippet,
  type SnippetDraft,
  type SnippetPatch,
  type StyleProfile,
  type StyleProfilePatch,
  type StyleProfileSet,
} from '@murmur/shared'

import {
  averageWpm,
  computeStreak,
  countedText,
  countWords,
  dayKey,
  longestStreak,
  streakEndDay,
} from './stats'

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
  app_name: string | null
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
    appName: row.app_name,
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

/** No fixes at all — command mode runs neither transform. */
export const NO_FIXES: InsightsFixes = Object.freeze({
  dictionaryFixes: 0,
  snippetExpansions: 0,
  wordsCleaned: 0,
})

export interface InsertOptions {
  /**
   * What the pipeline corrected on the way to this row. Counted where it
   * happens rather than re-derived here: only the orchestrator knows how many
   * replacement rules actually fired.
   */
  fixes?: InsightsFixes
  /**
   * False when the user has switched per-app collection off. Only the
   * `app_usage` write is skipped — the word, streak and fix counters are the
   * same lifetime totals Murmur has always kept and are not the new collection.
   */
  collectAppUsage?: boolean
}

export class DictationsRepository {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  insert(draft: DictationDraft, options: InsertOptions = {}): DictationRecord {
    const record = DictationRecordSchema.parse({ ...draft, id: draft.id ?? randomUUID() })
    const fixes = options.fixes ?? NO_FIXES

    // The row and every counter move together or not at all: a crash between
    // them would leave the Insights numbers permanently disagreeing with the
    // history below them, and nothing ever recomputes the counters to notice.
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO dictations
             (id, ts, raw_text, polished_text, app_bundle_id, app_name, app_category,
              duration_ms, stt_model, polish_model, timings_json)
           VALUES (@id, @ts, @rawText, @polishedText, @appBundleId, @appName, @appCategory,
                   @durationMs, @sttModelId, @polishModelId, @timingsJson)`,
        )
        .run({
          id: record.id,
          ts: record.ts,
          rawText: record.rawText,
          polishedText: record.polishedText,
          appBundleId: record.appBundleId,
          appName: record.appName,
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
              SET total_words        = total_words + ?,
                  timed_words        = timed_words + ?,
                  spoken_ms          = spoken_ms + ?,
                  dictionary_fixes   = dictionary_fixes + ?,
                  snippet_expansions = snippet_expansions + ?,
                  words_cleaned      = words_cleaned + ?
            WHERE id = 1`,
        )
        .run(
          words,
          timed ? words : 0,
          timed ? record.durationMs : 0,
          fixes.dictionaryFixes,
          fixes.snippetExpansions,
          fixes.wordsCleaned,
        )

      // Upsert rather than insert-then-update: the day row may predate schema
      // v5 (migration 2 created day rows with no counters at all).
      this.#db
        .prepare(
          `INSERT INTO dictation_days (day, words, dictations, spoken_ms) VALUES (?, ?, 1, ?)
           ON CONFLICT(day) DO UPDATE SET
             words      = words + excluded.words,
             dictations = dictations + 1,
             spoken_ms  = spoken_ms + excluded.spoken_ms`,
        )
        .run(dayKey(record.ts), words, record.durationMs)

      if (options.collectAppUsage === false || !record.appBundleId) return

      // `display_name` is refreshed on every dictation so a rename — or a row
      // backfilled with the bundle id as a placeholder — heals the next time
      // the user dictates into that app.
      this.#db
        .prepare(
          `INSERT INTO app_usage
             (bundle_id, display_name, category, words, dictations, spoken_ms, last_used_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(bundle_id) DO UPDATE SET
             display_name = excluded.display_name,
             category     = excluded.category,
             words        = words + excluded.words,
             dictations   = dictations + 1,
             spoken_ms    = spoken_ms + excluded.spoken_ms,
             last_used_at = MAX(last_used_at, excluded.last_used_at)`,
        )
        .run(
          record.appBundleId,
          record.appName ?? record.appBundleId,
          record.appCategory,
          words,
          record.durationMs,
          record.ts,
        )
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
   * Put back a row that {@link delete} removed — the undo behind the toast.
   *
   * Deliberately *not* `insert`. Deleting a transcript leaves every counter
   * standing (the dictation still happened; only the text is gone), so putting
   * the text back must leave them standing too. Routing undo through `insert`
   * would add the row's words to the lifetime total a second time, and nothing
   * ever recomputes those counters to notice the drift.
   *
   * `OR IGNORE` rather than an existence check: a double-tapped Undo, or an
   * undo racing a re-sync, should be a no-op rather than a constraint error
   * surfacing as a failure toast for an operation that already succeeded.
   */
  restore(record: DictationRecord): boolean {
    return (
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO dictations
             (id, ts, raw_text, polished_text, app_bundle_id, app_name, app_category,
              duration_ms, stt_model, polish_model, timings_json)
           VALUES (@id, @ts, @rawText, @polishedText, @appBundleId, @appName, @appCategory,
                   @durationMs, @sttModelId, @polishModelId, @timingsJson)`,
        )
        .run({
          id: record.id,
          ts: record.ts,
          rawText: record.rawText,
          polishedText: record.polishedText,
          appBundleId: record.appBundleId,
          appName: record.appName,
          appCategory: record.appCategory,
          durationMs: record.durationMs,
          sttModelId: record.sttModelId,
          polishModelId: record.polishModelId,
          timingsJson: JSON.stringify(record.timings),
        }).changes > 0
    )
  }

  /**
   * Replace a row's polished text — what re-polishing from History writes.
   *
   * Only that column moves. The raw transcript is what was actually said and is
   * never rewritten, the timestamp is when it was said, and the lifetime
   * counters stay put: polishing the same sentence a second time did not make
   * the user say it twice.
   */
  setPolishedText(id: string, polishedText: string): DictationRecord | null {
    const changed = this.#db
      .prepare(`UPDATE dictations SET polished_text = ? WHERE id = ?`)
      .run(polishedText, id).changes
    return changed > 0 ? this.get(id) : null
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
      this.#resetCounters()
      return changes
    })()
  }

  /**
   * Zero every Insights counter without touching the transcripts.
   *
   * The mirror image of {@link clear}: that one is "erase what I said", this is
   * "forget the tally". Someone who wants the charts to start over should not
   * have to delete their history to get it — and someone deleting their history
   * should not be left with a word count and a streak still standing over it,
   * which is why `clear` calls this too.
   */
  resetInsights(): void {
    this.#db.transaction(() => this.#resetCounters())()
  }

  #resetCounters(): void {
    this.#db
      .prepare(
        `UPDATE lifetime_stats
            SET total_words = 0, timed_words = 0, spoken_ms = 0,
                dictionary_fixes = 0, snippet_expansions = 0, words_cleaned = 0
          WHERE id = 1`,
      )
      .run()
    this.#db.prepare(`DELETE FROM dictation_days`).run()
    this.#db.prepare(`DELETE FROM app_usage`).run()
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

  /**
   * Everything the Insights section draws, in one read (PLAN §2.2.2).
   *
   * One call rather than five because the section renders as a unit and the
   * numbers must agree with each other: five round trips could straddle a
   * dictation and show a streak that includes a day the word count does not.
   *
   * Read entirely from the counter tables — `dictations` is not consulted, for
   * the same reason `stats()` does not consult it.
   */
  insights(options: { collecting: boolean; now?: number }): Insights {
    const now = options.now ?? Date.now()

    const totals = this.#db
      .prepare(
        `SELECT total_words, timed_words, spoken_ms,
                dictionary_fixes, snippet_expansions, words_cleaned
           FROM lifetime_stats WHERE id = 1`,
      )
      .get() as
      | {
          total_words: number
          timed_words: number
          spoken_ms: number
          dictionary_fixes: number
          snippet_expansions: number
          words_cleaned: number
        }
      | undefined

    const dayRows = this.#db
      .prepare(
        `SELECT day, words, dictations FROM dictation_days
          ORDER BY day DESC LIMIT ?`,
      )
      .all(INSIGHTS_MAX_DAYS) as { day: string; words: number; dictations: number }[]

    // The streak walk needs every day ever recorded, not just the windowed
    // page above: a 400-day streak would otherwise be truncated to 371 by the
    // limit that exists only to bound the heatmap's payload.
    const allDays = new Set(
      (this.#db.prepare(`SELECT day FROM dictation_days`).all() as { day: string }[]).map(
        (row) => row.day,
      ),
    )

    const appRows = this.#db
      .prepare(
        `SELECT bundle_id, display_name, category, words, dictations, last_used_at
           FROM app_usage ORDER BY words DESC, last_used_at DESC LIMIT ?`,
      )
      .all(INSIGHTS_MAX_APPS) as {
      bundle_id: string
      display_name: string
      category: string
      words: number
      dictations: number
      last_used_at: number
    }[]

    // Whatever the top-N cut off, reported rather than silently dropped: the
    // percentages under the bars have to add up to the total above them.
    const listedWords = appRows.reduce((sum, row) => sum + row.words, 0)
    const allAppWords = (
      this.#db.prepare(`SELECT COALESCE(SUM(words), 0) AS n FROM app_usage`).get() as { n: number }
    ).n

    return InsightsSchema.parse({
      totals: {
        words: totals?.total_words ?? 0,
        dictations: (
          this.#db
            .prepare(`SELECT COALESCE(SUM(dictations), 0) AS n FROM dictation_days`)
            .get() as {
            n: number
          }
        ).n,
        spokenMs: totals?.spoken_ms ?? 0,
        avgWpm: averageWpm(totals?.timed_words ?? 0, totals?.spoken_ms ?? 0),
      },
      fixes: {
        dictionaryFixes: totals?.dictionary_fixes ?? 0,
        snippetExpansions: totals?.snippet_expansions ?? 0,
        wordsCleaned: totals?.words_cleaned ?? 0,
      },
      streak: {
        current: computeStreak(allDays, now),
        longest: longestStreak(allDays),
        endDay: streakEndDay(allDays, now),
      },
      // Ascending for the renderer, which lays the heatmap out left-to-right.
      days: dayRows.reverse(),
      today: dayKey(now),
      apps: appRows.map((row) => ({
        bundleId: row.bundle_id,
        name: row.display_name,
        category: AppCategorySchema.catch('other').parse(row.category),
        words: row.words,
        dictations: row.dictations,
        lastUsedAt: row.last_used_at,
      })),
      otherAppWords: Math.max(0, allAppWords - listedWords),
      collecting: options.collecting,
    })
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

  /**
   * Put an entry back with its original id — the restore half of a backup.
   *
   * `OR IGNORE` on both the id and the term makes restoring idempotent: the
   * same backup applied twice is the same database, and a term the user has
   * since edited by hand is left as they edited it rather than being silently
   * reverted by a file from last month.
   */
  restore(entry: DictionaryEntry): boolean {
    return (
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO dictionary (id, term, replacement, enabled) VALUES (?, ?, ?, ?)`,
        )
        .run(entry.id, entry.term, entry.replacement, entry.enabled ? 1 : 0).changes > 0
    )
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

// ---------------------------------------------------------------------------
// Notes (the Scratchpad)
// ---------------------------------------------------------------------------

interface NoteRow {
  id: string
  title: string
  body: string
  created_at: number
  updated_at: number
  pinned: number
}

function toNote(row: NoteRow): Note {
  return NoteSchema.parse({
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: row.pinned !== 0,
  })
}

/**
 * The Scratchpad's store (PLAN §2.2.7).
 *
 * Two things separate it from every other text this app keeps:
 *
 *  - **Nothing prunes it.** There is no `pruneOlderThan` here and there must
 *    never be one. A note is a document the user wrote, not a record of
 *    something that happened, and `historyRetention` governs the latter.
 *  - **Ordering is pinned-then-recent**, not purely chronological, because a
 *    scratchpad is a working surface: the note you keep coming back to should
 *    not sink as you jot others.
 *
 * The FTS path is the same shape as `DictationsRepository.query` and reuses its
 * {@link toFtsQuery} — an unescaped search box is a crash in FTS5, and one
 * escaping rule is easier to keep right than two.
 */
export class NotesRepository {
  readonly #db: Database
  readonly #now: () => number

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db
    this.#now = now
  }

  list(request: NoteQuery): NoteList {
    const search = request.search.trim()

    if (!search) {
      const rows = this.#db
        .prepare(`SELECT * FROM notes ORDER BY pinned DESC, updated_at DESC LIMIT ?`)
        .all(request.limit) as NoteRow[]
      const total = this.#db.prepare(`SELECT COUNT(*) AS n FROM notes`).get() as { n: number }
      return { notes: rows.map(toNote), total: total.n }
    }

    const match = toFtsQuery(search)
    if (!match) return { notes: [], total: 0 }

    const rows = this.#db
      .prepare(
        `SELECT n.* FROM notes n
           JOIN notes_fts f ON f.rowid = n.rowid
          WHERE notes_fts MATCH ?
          ORDER BY n.pinned DESC, n.updated_at DESC
          LIMIT ?`,
      )
      .all(match, request.limit) as NoteRow[]

    const total = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM notes n
           JOIN notes_fts f ON f.rowid = n.rowid
          WHERE notes_fts MATCH ?`,
      )
      .get(match) as { n: number }

    return { notes: rows.map(toNote), total: total.n }
  }

  get(id: string): Note | null {
    const row = this.#db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as NoteRow | undefined
    return row ? toNote(row) : null
  }

  create(draft: NoteDraft): Note {
    const now = this.#now()
    const note = NoteSchema.parse({
      id: randomUUID(),
      title: draft.title,
      body: draft.body,
      createdAt: now,
      updatedAt: now,
      pinned: false,
    })
    this.#db
      .prepare(
        `INSERT INTO notes (id, title, body, created_at, updated_at, pinned)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(note.id, note.title, note.body, note.createdAt, note.updatedAt)
    return note
  }

  /**
   * Put a note back exactly as it was, timestamps and pin included.
   *
   * Not `create`, which stamps a fresh id and a fresh `createdAt` — restoring a
   * backup must not rewrite the day every note was written.
   */
  restore(note: Note): boolean {
    return (
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO notes (id, title, body, created_at, updated_at, pinned)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(note.id, note.title, note.body, note.createdAt, note.updatedAt, note.pinned ? 1 : 0)
        .changes > 0
    )
  }

  update(id: string, patch: NotePatch): Note {
    const existing = this.#db.prepare(`SELECT * FROM notes WHERE id = ?`).get(id) as
      NoteRow | undefined
    if (!existing) throw new Error(`No note with id "${id}"`)

    // `updated_at` moves only when the content does. Pinning is a filing
    // action, not an edit, and letting it re-sort the list to the top would
    // make the pin look like it had rewritten the note.
    const touched = patch.title !== undefined || patch.body !== undefined

    const next = NoteSchema.parse({
      id,
      title: patch.title ?? existing.title,
      body: patch.body ?? existing.body,
      createdAt: existing.created_at,
      updatedAt: touched ? this.#now() : existing.updated_at,
      pinned: patch.pinned ?? existing.pinned !== 0,
    })

    this.#db
      .prepare(`UPDATE notes SET title = ?, body = ?, updated_at = ?, pinned = ? WHERE id = ?`)
      .run(next.title, next.body, next.updatedAt, next.pinned ? 1 : 0, id)
    return next
  }

  delete(id: string): boolean {
    return this.#db.prepare(`DELETE FROM notes WHERE id = ?`).run(id).changes > 0
  }

  count(): number {
    return (this.#db.prepare(`SELECT COUNT(*) AS n FROM notes`).get() as { n: number }).n
  }
}

interface SnippetRow {
  id: string
  trigger: string
  expansion: string
  enabled: number
}

function toSnippet(row: SnippetRow): Snippet {
  return SnippetSchema.parse({
    id: row.id,
    trigger: row.trigger,
    expansion: row.expansion,
    enabled: row.enabled !== 0,
  })
}

/**
 * Stored voice shortcuts (PLAN §2.2.2).
 *
 * Deliberately the same shape as {@link DictionaryRepository} — the two are
 * neighbours in the Hub and behave alike from the user's side — but a separate
 * table and a separate place in the pipeline. See domain/snippet.ts for why
 * expansion runs after polishing rather than before.
 */
export class SnippetsRepository {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  list(): Snippet[] {
    const rows = this.#db
      .prepare(`SELECT * FROM snippets ORDER BY trigger COLLATE NOCASE ASC`)
      .all() as SnippetRow[]
    return rows.map(toSnippet)
  }

  /** Enabled snippets only — what the orchestrator expands against. */
  enabled(): Snippet[] {
    return this.list().filter((snippet) => snippet.enabled)
  }

  create(draft: SnippetDraft): Snippet {
    const snippet = SnippetSchema.parse({ ...draft, id: randomUUID() })
    this.#db
      .prepare(
        `INSERT INTO snippets (id, trigger, expansion, enabled) VALUES (?, ?, ?, ?)
         ON CONFLICT(trigger COLLATE NOCASE) DO UPDATE SET
           expansion = excluded.expansion,
           enabled = excluded.enabled`,
      )
      .run(snippet.id, snippet.trigger, snippet.expansion, snippet.enabled ? 1 : 0)

    // The upsert may have hit an existing row, whose id we must return.
    const stored = this.#db
      .prepare(`SELECT * FROM snippets WHERE trigger = ? COLLATE NOCASE`)
      .get(snippet.trigger) as SnippetRow | undefined
    return stored ? toSnippet(stored) : snippet
  }

  /** Put a snippet back with its original id. See the dictionary's `restore`. */
  restore(snippet: Snippet): boolean {
    return (
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO snippets (id, trigger, expansion, enabled) VALUES (?, ?, ?, ?)`,
        )
        .run(snippet.id, snippet.trigger, snippet.expansion, snippet.enabled ? 1 : 0).changes > 0
    )
  }

  update(id: string, patch: SnippetPatch): Snippet {
    const existing = this.#db.prepare(`SELECT * FROM snippets WHERE id = ?`).get(id) as
      SnippetRow | undefined
    if (!existing) throw new Error(`No snippet with id "${id}"`)

    const next = SnippetSchema.parse({
      id,
      trigger: patch.trigger ?? existing.trigger,
      expansion: patch.expansion ?? existing.expansion,
      enabled: patch.enabled ?? existing.enabled !== 0,
    })

    this.#db
      .prepare(`UPDATE snippets SET trigger = ?, expansion = ?, enabled = ? WHERE id = ?`)
      .run(next.trigger, next.expansion, next.enabled ? 1 : 0, id)
    return next
  }

  delete(id: string): boolean {
    return this.#db.prepare(`DELETE FROM snippets WHERE id = ?`).run(id).changes > 0
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
  return applyReplacementsWithCount(text, entries).text
}

/**
 * The same transform, reporting how many replacements actually fired.
 *
 * The count is of *substitutions performed*, not of rules that matched: a rule
 * hitting three times in one utterance is three fixes, because that is three
 * words the user did not have to correct. Rules that matched nothing contribute
 * nothing, which is what makes the Insights number a measurement rather than an
 * estimate of effort.
 */
export function applyReplacementsWithCount(
  text: string,
  entries: readonly DictionaryEntry[],
): { text: string; replacements: number } {
  let out = text
  let replacements = 0
  for (const entry of entries) {
    if (!entry.enabled || !entry.replacement) continue
    const pattern = new RegExp(`\\b${escapeRegExp(entry.term)}\\b`, 'gi')
    out = out.replace(pattern, (match) => {
      replacements += 1
      return matchCase(match, entry.replacement ?? match)
    })
  }
  return { text: out, replacements }
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

// ---------------------------------------------------------------------------
// Ask
// ---------------------------------------------------------------------------

interface AskTurnRow {
  id: string
  role: string
  content: string
  citations: string
  created_at: number
}

interface AskConversationRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  turn_count: number
}

/**
 * Ask's conversations and their turns (PLAN §2.2.9).
 *
 * Citations are stored as JSON rather than a join table because they are a
 * *snapshot* of what the model was shown. A relational link would silently
 * re-point at edited or deleted text, and an answer from March would end up
 * appearing to cite a note that was rewritten in June.
 *
 * Reads are lenient about that JSON on purpose: a turn whose citations fail to
 * parse still has an answer worth showing, and losing a whole conversation to
 * one malformed row is a far worse outcome than losing its chips.
 */
export class AskRepository {
  readonly #db: Database

  constructor(db: Database) {
    this.#db = db
  }

  // -- conversations ---------------------------------------------------------

  create(title: string, now: number): AskConversation {
    const id = randomUUID()
    this.#db
      .prepare(
        `INSERT INTO ask_conversations (id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, title, now, now)
    return AskConversationSchema.parse({ id, title, createdAt: now, updatedAt: now, turnCount: 0 })
  }

  /**
   * Conversations, most recently used first.
   *
   * The turn count comes from a correlated subquery rather than a stored
   * column: it is only read by the list, and a denormalised counter is one more
   * thing that can drift out of step with the rows it counts.
   */
  list(limit = 200): AskConversation[] {
    const rows = this.#db
      .prepare(
        `SELECT c.id, c.title, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM ask_turns t WHERE t.conversation_id = c.id) AS turn_count
           FROM ask_conversations c
          ORDER BY c.updated_at DESC, c.rowid DESC
          LIMIT ?`,
      )
      .all(limit) as AskConversationRow[]
    return rows.map(toConversation)
  }

  get(id: string): AskConversation | null {
    const row = this.#db
      .prepare(
        `SELECT c.id, c.title, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM ask_turns t WHERE t.conversation_id = c.id) AS turn_count
           FROM ask_conversations c WHERE c.id = ?`,
      )
      .get(id) as AskConversationRow | undefined
    return row ? toConversation(row) : null
  }

  rename(id: string, title: string, now: number): AskConversation | null {
    this.#db
      .prepare(`UPDATE ask_conversations SET title = ?, updated_at = ? WHERE id = ?`)
      .run(title.slice(0, 200), now, id)
    return this.get(id)
  }

  /** Deletes the turns too, by the cascade on `ask_turns.conversation_id`. */
  delete(id: string): boolean {
    return this.#db.prepare(`DELETE FROM ask_conversations WHERE id = ?`).run(id).changes > 0
  }

  /** Everything. Does not touch a single dictation, note or transcript. */
  clear(): number {
    return this.#db.prepare(`DELETE FROM ask_conversations`).run().changes
  }

  /** Drop conversations that never got a turn — an opened-but-unused thread. */
  pruneEmpty(exceptId?: string): number {
    return this.#db
      .prepare(
        `DELETE FROM ask_conversations
          WHERE id != COALESCE(?, '')
            AND NOT EXISTS (SELECT 1 FROM ask_turns t WHERE t.conversation_id = ask_conversations.id)`,
      )
      .run(exceptId ?? null).changes
  }

  // -- turns -----------------------------------------------------------------

  /**
   * Add a turn and mark the conversation used, in one transaction.
   *
   * Together because a turn whose conversation still sorts by its old timestamp
   * is a thread that answered you and then hid at the bottom of the list.
   */
  append(conversationId: string, turn: Omit<AskTurn, 'id'> & { id?: string }): AskTurn {
    const record = AskTurnSchema.parse({ ...turn, id: turn.id ?? randomUUID() })
    const write = this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO ask_turns (id, conversation_id, role, content, citations, created_at)
           VALUES (@id, @conversationId, @role, @content, @citations, @createdAt)
           ON CONFLICT(id) DO UPDATE SET
             content = excluded.content,
             citations = excluded.citations`,
        )
        .run({
          id: record.id,
          conversationId,
          role: record.role,
          content: record.content,
          citations: JSON.stringify(record.citations),
          createdAt: record.createdAt,
        })
      this.#db
        .prepare(`UPDATE ask_conversations SET updated_at = ? WHERE id = ?`)
        .run(record.createdAt, conversationId)
    })
    write()
    return record
  }

  /**
   * A conversation's turns, oldest first.
   *
   * Ordered by `rowid`, not by `id`, and that is load-bearing. A question and
   * its answer routinely land in the same millisecond — a short answer needs no
   * more than that — so `created_at` alone leaves them tied, and a UUID
   * tiebreak resolves the tie at random. Half the time the thread would render
   * the answer above the question that prompted it. `rowid` is insertion order
   * by construction and cannot tie.
   */
  turns(conversationId: string, limit = 500): AskTurn[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM (
           SELECT rowid AS rid, id, role, content, citations, created_at
             FROM ask_turns
            WHERE conversation_id = ?
            ORDER BY created_at DESC, rowid DESC
            LIMIT ?
         ) ORDER BY created_at ASC, rid ASC`,
      )
      .all(conversationId, limit) as AskTurnRow[]
    return rows.map(toAskTurn)
  }

  // -- search ----------------------------------------------------------------

  /**
   * Find conversations by what was said in them.
   *
   * One hit per conversation, not per turn: a long thread about the migration
   * matches on eight of its turns, and eight rows for one conversation buries
   * the seven other threads that also matched. The best-ranked turn stands for
   * its conversation, and its text is the snippet.
   */
  search(query: string, limit = 30): AskSearchHit[] {
    const match = toFtsQuery(query)
    if (!match) return []

    let rows: (AskConversationRow & { snippet: string; role: string; turn_id: string })[]
    try {
      rows = this.#db
        .prepare(
          `SELECT c.id, c.title, c.created_at, c.updated_at,
                  (SELECT COUNT(*) FROM ask_turns t2 WHERE t2.conversation_id = c.id) AS turn_count,
                  best.content AS snippet, best.role AS role, best.id AS turn_id
             FROM ask_conversations c
             JOIN (
               SELECT t.conversation_id, t.content, t.role, t.id,
                      ROW_NUMBER() OVER (
                        PARTITION BY t.conversation_id ORDER BY bm25(ask_turns_fts) ASC
                      ) AS rn
                 FROM ask_turns t
                 JOIN ask_turns_fts f ON f.rowid = t.rowid
                WHERE ask_turns_fts MATCH ?
             ) AS best ON best.conversation_id = c.id AND best.rn = 1
            ORDER BY c.updated_at DESC
            LIMIT ?`,
        )
        .all(match, limit) as typeof rows
    } catch {
      // FTS5 raises on some inputs that survive `toFtsQuery`. An empty result is
      // the right answer for a search box; a crash is not.
      return []
    }

    return rows.map((row) =>
      AskSearchHitSchema.parse({
        conversation: toConversation(row),
        snippet: row.snippet,
        role: row.role === 'assistant' ? 'assistant' : 'user',
        turnId: row.turn_id,
      }),
    )
  }
}

function toConversation(row: AskConversationRow): AskConversation {
  return AskConversationSchema.parse({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turnCount: row.turn_count ?? 0,
  })
}

function toAskTurn(row: AskTurnRow): AskTurn {
  let citations: unknown
  try {
    citations = JSON.parse(row.citations)
  } catch {
    citations = []
  }
  const parsed = z.array(AskCitationSchema).safeParse(citations)
  return AskTurnSchema.parse({
    id: row.id,
    role: row.role,
    content: row.content,
    citations: parsed.success ? parsed.data : [],
    createdAt: row.created_at,
  })
}
