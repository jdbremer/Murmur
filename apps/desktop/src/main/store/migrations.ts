import type { Database } from 'better-sqlite3'

import { countedText, countWords, dayKey } from './stats'

/**
 * Forward-only schema migrations (PLAN §9, §15.2).
 *
 * Rules, deliberately rigid:
 *
 *  - migrations are **append-only**; an existing entry is never edited, because
 *    a shipped build has already run it;
 *  - each one is idempotent-by-version, tracked in `user_version`;
 *  - each runs inside a transaction, so a failure leaves the previous version
 *    intact rather than half-applied;
 *  - the caller takes a **pre-migration backup** first (see `db.ts`), which is
 *    the actual safety net — a migration that corrupts data is recoverable, one
 *    that does so with no copy of the old file is not.
 *
 * There is no `down`. Rolling an app back to a build that predates a migration
 * is handled by restoring the pre-migration backup, which is a file copy rather
 * than a second set of SQL nobody has ever run.
 */

export interface Migration {
  /** 1-based, contiguous. Matches the `user_version` after it has run. */
  version: number
  name: string
  up(db: Database): void
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: 'initial-schema',
    up(db) {
      // -- dictations (PLAN §9) -------------------------------------------
      db.exec(`
        CREATE TABLE dictations (
          id            TEXT PRIMARY KEY,
          ts            INTEGER NOT NULL,
          raw_text      TEXT NOT NULL,
          polished_text TEXT,
          app_bundle_id TEXT,
          app_category  TEXT NOT NULL DEFAULT 'other',
          duration_ms   INTEGER NOT NULL DEFAULT 0,
          stt_model     TEXT NOT NULL,
          polish_model  TEXT,
          timings_json  TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX idx_dictations_ts ON dictations (ts DESC);
      `)

      // FTS5 over both text columns. `content=` makes it an external-content
      // index: the text lives once, in `dictations`, and the triggers below
      // keep the index in step. Halves the on-disk size of a long history.
      db.exec(`
        CREATE VIRTUAL TABLE dictations_fts USING fts5(
          raw_text,
          polished_text,
          content='dictations',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER dictations_ai AFTER INSERT ON dictations BEGIN
          INSERT INTO dictations_fts(rowid, raw_text, polished_text)
          VALUES (new.rowid, new.raw_text, new.polished_text);
        END;

        CREATE TRIGGER dictations_ad AFTER DELETE ON dictations BEGIN
          INSERT INTO dictations_fts(dictations_fts, rowid, raw_text, polished_text)
          VALUES ('delete', old.rowid, old.raw_text, old.polished_text);
        END;

        CREATE TRIGGER dictations_au AFTER UPDATE ON dictations BEGIN
          INSERT INTO dictations_fts(dictations_fts, rowid, raw_text, polished_text)
          VALUES ('delete', old.rowid, old.raw_text, old.polished_text);
          INSERT INTO dictations_fts(rowid, raw_text, polished_text)
          VALUES (new.rowid, new.raw_text, new.polished_text);
        END;
      `)

      // -- dictionary (PLAN §9) -------------------------------------------
      // `replacement IS NULL` = vocabulary-boost only; the UNIQUE index makes
      // "add the same term twice" a no-op rather than a duplicate row.
      db.exec(`
        CREATE TABLE dictionary (
          id          TEXT PRIMARY KEY,
          term        TEXT NOT NULL,
          replacement TEXT,
          enabled     INTEGER NOT NULL DEFAULT 1
        );
        CREATE UNIQUE INDEX idx_dictionary_term ON dictionary (term COLLATE NOCASE);
      `)

      // -- style profiles (PLAN §9) ---------------------------------------
      db.exec(`
        CREATE TABLE style_profiles (
          category            TEXT PRIMARY KEY,
          formality           TEXT NOT NULL,
          filler_handling     TEXT NOT NULL,
          emoji               TEXT NOT NULL,
          custom_instructions TEXT NOT NULL DEFAULT ''
        );
      `)
    },
  },
  {
    version: 2,
    name: 'lifetime-stats',
    up(db) {
      // The Home header's numbers used to be a live aggregate over
      // `dictations`, which made them a function of the *retention window*
      // rather than of what the user had actually dictated: every boot with a
      // 90-day policy silently deleted words from the lifetime total, and
      // shortening the window subtracted thousands at once. Counters that only
      // the user can reset are the point of this migration.
      //
      // Two tables rather than one because the streak is not a counter: it
      // needs the *set* of days dictated on, and that set has to outlive the
      // rows too. One row per day is ~3.6k rows per decade — nothing.
      db.exec(`
        CREATE TABLE lifetime_stats (
          id             INTEGER PRIMARY KEY CHECK (id = 1),
          total_words    INTEGER NOT NULL DEFAULT 0,
          -- Numerator and denominator of the average rate, kept in step: a
          -- dictation contributes to both or to neither (see stats.ts).
          timed_words    INTEGER NOT NULL DEFAULT 0,
          spoken_ms      INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO lifetime_stats (id) VALUES (1);

        CREATE TABLE dictation_days (
          -- Local-calendar 'YYYY-MM-DD', matching stats.ts's dayKey().
          day TEXT PRIMARY KEY
        );
      `)

      // Backfill from whatever history survives, so an upgrading user keeps the
      // numbers they already had rather than watching them reset to zero.
      //
      // Counted in JS through the very functions the live path uses, rather
      // than in SQL: `countWords` and `dayKey` are the definitions these
      // columns are supposed to hold, and a hand-rolled SQL transliteration of
      // them would be a second, subtly different implementation that no test
      // pins. `iterate` keeps a long history off the heap.
      const rows = db
        .prepare(`SELECT ts, raw_text, polished_text, duration_ms FROM dictations`)
        .iterate() as Iterable<{
        ts: number
        raw_text: string
        polished_text: string | null
        duration_ms: number
      }>

      let totalWords = 0
      let timedWords = 0
      let spokenMs = 0
      // Days are collected first and written after the loop: better-sqlite3
      // refuses to execute a statement while an iterator is still open on the
      // same connection, so writing inside the loop would throw.
      const days = new Set<string>()

      for (const row of rows) {
        const words = countWords(countedText(row.polished_text, row.raw_text))
        totalWords += words
        if (row.duration_ms > 0 && words > 0) {
          timedWords += words
          spokenMs += row.duration_ms
        }
        days.add(dayKey(row.ts))
      }

      const addDay = db.prepare(`INSERT OR IGNORE INTO dictation_days (day) VALUES (?)`)
      for (const day of days) addDay.run(day)

      db.prepare(
        `UPDATE lifetime_stats
            SET total_words = ?, timed_words = ?, spoken_ms = ?
          WHERE id = 1`,
      ).run(totalWords, timedWords, spokenMs)
    },
  },
  {
    version: 3,
    name: 'meetings',
    up(db) {
      // An index of recorded meetings, not a copy of them. The transcript
      // itself lives in the Markdown file at `path` and is deliberately not
      // duplicated here: a meeting can run for hours, the file is the artifact
      // the user actually wanted, and two copies would only ever disagree.
      //
      // `path` is therefore allowed to point at a file the user has since
      // moved or deleted — readers must handle a missing file rather than
      // assume the row implies one.
      db.exec(`
        CREATE TABLE meetings (
          id               TEXT PRIMARY KEY,
          started_at       INTEGER NOT NULL,
          ended_at         INTEGER,
          title            TEXT NOT NULL,
          path             TEXT NOT NULL,
          app_bundle_id    TEXT,
          had_system_audio INTEGER NOT NULL DEFAULT 0,
          segment_count    INTEGER NOT NULL DEFAULT 0,
          duration_ms      INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_meetings_started ON meetings (started_at DESC);
      `)
    },
  },
  {
    version: 4,
    name: 'snippets',
    up(db) {
      // Snippets sit beside `dictionary` rather than inside it. The columns
      // would nearly line up — trigger/term, expansion/replacement — but the
      // constraints do not: an expansion is long and may contain newlines,
      // while a dictionary replacement is a single word, and the two run at
      // different points in the pipeline. Sharing a table would mean a nullable
      // discriminator and every query filtering on it.
      //
      // UNIQUE on trigger, NOCASE, for the same reason as the dictionary:
      // adding the same trigger twice should be a correction, not a second row
      // that silently never fires because the first one matched.
      db.exec(`
        CREATE TABLE snippets (
          id        TEXT PRIMARY KEY,
          trigger   TEXT NOT NULL,
          expansion TEXT NOT NULL,
          enabled   INTEGER NOT NULL DEFAULT 1
        );
        CREATE UNIQUE INDEX idx_snippets_trigger ON snippets (trigger COLLATE NOCASE);
      `)
    },
  },
  {
    version: 5,
    name: 'insights',
    up(db) {
      // Everything the Insights section draws, kept where the retention sweep
      // cannot reach it — the same argument migration 2 makes for the lifetime
      // counters, extended to the three things that section actually shows.
      //
      // Deriving any of this from `dictations` would make the charts a picture
      // of the *retention window* rather than of the user: a 90-day policy
      // would silently erase a year of streak history every boot, and the app
      // breakdown would forget which apps you used it in most.

      // The frontmost app's display name. The orchestrator already receives it
      // from `getFrontmostApp()` and throws it away, so the History row has
      // only ever been able to show a raw bundle id.
      db.exec(`ALTER TABLE dictations ADD COLUMN app_name TEXT`)

      // The heatmap needs magnitude, not just presence: a day with 4,000 words
      // and a day with six should not be the same square.
      db.exec(`
        ALTER TABLE dictation_days ADD COLUMN words INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE dictation_days ADD COLUMN dictations INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE dictation_days ADD COLUMN spoken_ms INTEGER NOT NULL DEFAULT 0;
      `)

      // The three fixes the pipeline already performs but has never counted.
      // On `lifetime_stats` rather than a table of their own: they are lifetime
      // counters on the same single row, updated in the same transaction, and a
      // second one-row table would only ever be joined back to this one.
      db.exec(`
        ALTER TABLE lifetime_stats ADD COLUMN dictionary_fixes INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE lifetime_stats ADD COLUMN snippet_expansions INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE lifetime_stats ADD COLUMN words_cleaned INTEGER NOT NULL DEFAULT 0;
      `)

      // One row per app ever dictated into. `display_name` is stored rather
      // than resolved at read time because the app may not be installed — let
      // alone running — when the Hub asks, and "com.tinyspeck.slackmacgap" is
      // not an answer to "where do you use this".
      db.exec(`
        CREATE TABLE app_usage (
          bundle_id    TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          category     TEXT NOT NULL DEFAULT 'other',
          words        INTEGER NOT NULL DEFAULT 0,
          dictations   INTEGER NOT NULL DEFAULT 0,
          spoken_ms    INTEGER NOT NULL DEFAULT 0,
          last_used_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_app_usage_words ON app_usage (words DESC);
      `)

      // Backfill from whatever history survives, through the same functions the
      // live path uses — and no further. This is **partial by construction**:
      // rows the retention sweep already deleted are gone, so a user upgrading
      // with a 90-day window gets 90 days of per-day and per-app history, not a
      // reconstructed lifetime. Inventing the rest would be worse than a chart
      // that starts where the evidence does.
      //
      // The fix counters stay at zero: they have never been measured, and a
      // guess ("assume one dictionary fix per row") would be a fabrication
      // sitting in a column the UI presents as a count.
      const rows = db
        .prepare(
          `SELECT ts, raw_text, polished_text, duration_ms, app_bundle_id, app_category
             FROM dictations`,
        )
        .iterate() as Iterable<{
        ts: number
        raw_text: string
        polished_text: string | null
        duration_ms: number
        app_bundle_id: string | null
        app_category: string
      }>

      const days = new Map<string, { words: number; dictations: number; spokenMs: number }>()
      const apps = new Map<
        string,
        {
          category: string
          words: number
          dictations: number
          spokenMs: number
          lastUsedAt: number
        }
      >()

      // Collected first and written after the loop: better-sqlite3 refuses to
      // execute a statement while an iterator is open on the same connection.
      for (const row of rows) {
        const words = countWords(countedText(row.polished_text, row.raw_text))
        const key = dayKey(row.ts)
        const day = days.get(key) ?? { words: 0, dictations: 0, spokenMs: 0 }
        day.words += words
        day.dictations += 1
        day.spokenMs += row.duration_ms
        days.set(key, day)

        if (!row.app_bundle_id) continue
        const app = apps.get(row.app_bundle_id) ?? {
          category: row.app_category,
          words: 0,
          dictations: 0,
          spokenMs: 0,
          lastUsedAt: 0,
        }
        app.words += words
        app.dictations += 1
        app.spokenMs += row.duration_ms
        app.lastUsedAt = Math.max(app.lastUsedAt, row.ts)
        apps.set(row.app_bundle_id, app)
      }

      // `INSERT OR IGNORE` first so a day predating migration 2's backfill
      // still gets a row; the UPDATE then fills the new columns for every day.
      const addDay = db.prepare(`INSERT OR IGNORE INTO dictation_days (day) VALUES (?)`)
      const fillDay = db.prepare(
        `UPDATE dictation_days SET words = ?, dictations = ?, spoken_ms = ? WHERE day = ?`,
      )
      for (const [day, totals] of days) {
        addDay.run(day)
        fillDay.run(totals.words, totals.dictations, totals.spokenMs, day)
      }

      // The display name is unknown here — it was never stored — so the bundle
      // id stands in until the next dictation into that app supplies the real
      // one. A readable-ish placeholder beats an empty cell.
      const addApp = db.prepare(
        `INSERT INTO app_usage
           (bundle_id, display_name, category, words, dictations, spoken_ms, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const [bundleId, totals] of apps) {
        addApp.run(
          bundleId,
          bundleId,
          totals.category,
          totals.words,
          totals.dictations,
          totals.spokenMs,
          totals.lastUsedAt,
        )
      }
    },
  },
  {
    version: 6,
    name: 'notes',
    up(db) {
      // The Scratchpad's storage (PLAN §2.2.7).
      //
      // Note the absence of anything retention-shaped. Every other text table
      // here is a *record* — of a dictation, of a meeting — and is pruned on a
      // schedule for that reason. A note is something the user wrote and
      // expects to find again; the retention sweep must never touch it, and the
      // only thing that deletes one is the user deleting it.
      db.exec(`
        CREATE TABLE notes (
          id         TEXT PRIMARY KEY,
          title      TEXT NOT NULL DEFAULT '',
          body       TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          pinned     INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_notes_updated ON notes (pinned DESC, updated_at DESC);
      `)

      // Same external-content FTS5 arrangement as `dictations`: the text lives
      // once, in `notes`, and the triggers keep the index in step.
      db.exec(`
        CREATE VIRTUAL TABLE notes_fts USING fts5(
          title,
          body,
          content='notes',
          content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;

        CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, body)
          VALUES ('delete', old.rowid, old.title, old.body);
        END;

        CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, body)
          VALUES ('delete', old.rowid, old.title, old.body);
          INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
        END;
      `)
    },
  },
])

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
)

export function currentVersion(db: Database): number {
  const row = db.pragma('user_version', { simple: true })
  return typeof row === 'number' ? row : 0
}

export interface MigrationResult {
  from: number
  to: number
  applied: string[]
}

/**
 * Bring `db` up to {@link LATEST_SCHEMA_VERSION}.
 *
 * @throws when the database is *newer* than this build understands — running an
 *   old binary against a new schema silently drops columns, so it must refuse.
 */
export function migrate(db: Database): MigrationResult {
  const from = currentVersion(db)

  if (from > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${from} is newer than this build supports ` +
        `(${LATEST_SCHEMA_VERSION}). Update Murmur, or restore a backup.`,
    )
  }

  const applied: string[] = []
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue
    db.transaction(() => {
      migration.up(db)
      // `pragma` cannot be parameterised, and `version` is a number from our
      // own frozen table — never user input.
      db.pragma(`user_version = ${migration.version}`)
    })()
    applied.push(`${migration.version}:${migration.name}`)
  }

  return { from, to: currentVersion(db), applied }
}
