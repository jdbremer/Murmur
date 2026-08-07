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
